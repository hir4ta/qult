package hookhandler

import (
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"strconv"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// SuggestionPriority determines the delivery channel for a suggestion.
type SuggestionPriority int

const (
	// PriorityCritical: immediate delivery via additionalContext or deny.
	PriorityCritical SuggestionPriority = iota
	// PriorityHigh: immediate additionalContext (capped at 3 per burst).
	PriorityHigh
	// PriorityMedium: queued to nudge_outbox for next UserPromptSubmit.
	PriorityMedium
	// PriorityLow: only surfaced via MCP tool on explicit request.
	PriorityLow
	// PrioritySuppressed: do not deliver at all.
	PrioritySuppressed
)

// DeliveryChannel describes how a suggestion should be delivered.
type DeliveryChannel int

const (
	ChannelImmediate DeliveryChannel = iota // return in current hook response
	ChannelNudge                            // enqueue to nudge_outbox
	ChannelDefer                            // store for MCP tool only
	ChannelSuppress                         // do not deliver
)

// DeliveryDecision holds the routing decision for a suggestion.
type DeliveryDecision struct {
	Channel  DeliveryChannel
	Priority SuggestionPriority
}

// RouteDelivery decides how to deliver a suggestion based on:
// 1. User's historical response rate for this pattern (effectiveness_score).
// 2. Number of suggestions already delivered in this burst.
// 3. Standard suppression check.
// 4. Workflow boundary boost (phase transitions, commits, task switches).
func RouteDelivery(sdb *sessiondb.SessionDB, pattern string, priority SuggestionPriority) DeliveryDecision {
	// Suppress non-critical suggestions during productive flow or suggestion fatigue.
	if priority > PriorityCritical && (isInFlow(sdb) || suggestionFatigue(sdb)) {
		return DeliveryDecision{Channel: ChannelDefer, Priority: priority}
	}

	// Workflow boundary boost: promote Medium → High at phase transitions,
	// commits, and task switches (52% engagement vs 31% mid-task).
	if priority == PriorityMedium && isAtWorkflowBoundary(sdb) {
		priority = PriorityHigh
	}

	// Critical priority bypasses Thompson Sampling — always deliver immediately.
	if priority == PriorityCritical {
		return DeliveryDecision{Channel: ChannelImmediate, Priority: priority}
	}

	// Apply adaptive priority adjustment using Thompson Sampling.
	rng := getSessionRNG(sdb)
	adjusted := adjustPriority(rng, pattern, priority)
	if adjusted >= PrioritySuppressed {
		// Never suppress High-priority suggestions — deliver as nudge instead.
		if priority <= PriorityHigh {
			adjusted = PriorityMedium
		} else {
			return DeliveryDecision{Channel: ChannelSuppress, Priority: adjusted}
		}
	}

	// Check burst suggestion count to prevent fatigue.
	burstCount := getBurstSuggestionCount(sdb)
	if adjusted <= PriorityHigh && burstCount >= 3 {
		// Too many suggestions this burst — downgrade to nudge.
		if adjusted == PriorityHigh {
			adjusted = PriorityMedium
		}
	}

	switch adjusted {
	case PriorityCritical:
		return DeliveryDecision{Channel: ChannelImmediate, Priority: adjusted}
	case PriorityHigh:
		incrementBurstSuggestionCount(sdb)
		return DeliveryDecision{Channel: ChannelImmediate, Priority: adjusted}
	case PriorityMedium:
		return DeliveryDecision{Channel: ChannelNudge, Priority: adjusted}
	default:
		return DeliveryDecision{Channel: ChannelDefer, Priority: adjusted}
	}
}

// isAtWorkflowBoundary checks and consumes the at_workflow_boundary flag.
// The flag is set by recordPhase on phase transitions, git commits, and task switches.
// It is consumed (cleared) after reading to ensure single-use per boundary event.
func isAtWorkflowBoundary(sdb *sessiondb.SessionDB) bool {
	val, _ := sdb.GetContext("at_workflow_boundary")
	if val != "true" {
		return false
	}
	_ = sdb.SetContext("at_workflow_boundary", "")
	return true
}

// adjustPriority uses contextual Thompson Sampling to adaptively adjust suggestion priority.
// It builds a contextual key from (pattern, task_type, velocity_state) and uses that
// for finer-grained adaptation. Falls back to the base pattern key when context data is sparse.
// For patterns with UserPref data, it uses the weighted effectiveness score (deterministic).
// For patterns with only delivery/resolution counts, it draws from a Beta distribution
// to naturally balance exploration (new patterns) and exploitation (proven patterns).
// Returns PrioritySuppressed if the pattern should not be delivered at all.
func adjustPriority(rng *rand.Rand, pattern string, base SuggestionPriority) SuggestionPriority {
	st, err := store.OpenDefault()
	if err != nil {
		return base
	}
	defer st.Close()

	// Build contextual key for finer-grained Thompson Sampling.
	ctxKey := contextualPatternKey(pattern)

	// Step 1: Explicit feedback has highest priority — if sufficient data exists,
	// use the weighted score directly (deterministic, no randomness needed).
	if stats, serr := st.PatternFeedbackStats(ctxKey); serr == nil && stats.TotalCount >= 3 {
		return adjustFromEstimate(normalizeFeedbackScore(stats.WeightedScore), base)
	}
	if stats, serr := st.PatternFeedbackStats(pattern); serr == nil && stats.TotalCount >= 3 {
		return adjustFromEstimate(normalizeFeedbackScore(stats.WeightedScore), base)
	}

	// Step 2: Check contextual UserPref, then fall back to base pattern.
	pref, err := st.UserPreference(ctxKey)
	if err == nil && pref != nil {
		return adjustFromUserPref(pref, base)
	}
	pref, err = st.UserPreference(pattern)
	if err == nil && pref != nil {
		return adjustFromUserPref(pref, base)
	}

	// Hard suppression safety net for truly dead patterns.
	// Critical/High bypass: never permanently suppress important signals.
	if base > PriorityHigh && st.ShouldSuppressPattern(pattern) {
		return PrioritySuppressed
	}

	// Thompson Sampling: try contextual key first, fall back to base pattern.
	delivered, resolved, err := st.DecayedPatternEffectiveness(ctxKey)
	if err != nil || delivered < 3.0 {
		// Insufficient contextual data — fall back to base pattern.
		delivered, resolved, err = st.DecayedPatternEffectiveness(pattern)
	}
	if err != nil || delivered < 0.5 {
		// No data at all — uniform prior Beta(1,1), sample for exploration.
		sample := betaSample(rng, 1, 1)
		return adjustFromEstimate(sample, base)
	}

	// Posterior from contextual data.
	alpha := resolved + 1
	beta := delivered - resolved + 1

	// KL regularization: penalize posterior that drifts too far from global prior.
	// This prevents overfitting to sparse contextual data.
	globalDel, globalRes, gerr := st.DecayedPatternEffectiveness(pattern)
	if gerr == nil && globalDel >= 3.0 {
		globalAlpha := globalRes + 1
		globalBeta := globalDel - globalRes + 1
		klPenalty := klDivBeta(alpha, beta, globalAlpha, globalBeta)
		// Blend posterior toward prior proportional to KL divergence (lambda=0.1).
		if klPenalty > 0.1 {
			blend := math.Min(klPenalty*0.1, 0.5) // cap at 50% blend
			alpha = alpha*(1-blend) + globalAlpha*blend
			beta = beta*(1-blend) + globalBeta*blend
		}
	}

	sample := betaSample(rng, alpha, beta)
	return adjustFromEstimate(sample, base)
}

// adjustFromUserPref uses the weighted effectiveness score from UserPref.
func adjustFromUserPref(pref *store.UserPref, base SuggestionPriority) SuggestionPriority {
	return adjustFromEstimate(pref.EffectivenessScore, base)
}

// normalizeFeedbackScore maps WeightedScore [-1, 1] to the [0, 1] range
// expected by adjustFromEstimate.
func normalizeFeedbackScore(score float64) float64 {
	return (score + 1) / 2
}

// adjustFromEstimate maps an effectiveness estimate [0,1] to a priority adjustment.
func adjustFromEstimate(estimate float64, base SuggestionPriority) SuggestionPriority {
	switch {
	case estimate > 0.5:
		return base // likely effective, deliver as-is
	case estimate > 0.25:
		if base < PriorityLow {
			return base + 1 // downgrade by 1 level
		}
		return base
	case estimate > 0.10:
		if base+2 < PrioritySuppressed {
			return base + 2 // downgrade by 2 levels
		}
		return PriorityLow
	default:
		return PrioritySuppressed
	}
}

// klDivBeta computes the KL divergence KL(Beta(a1,b1) || Beta(a2,b2)).
// Uses the closed-form: KL = ln(B(a2,b2)/B(a1,b1)) + (a1-a2)*psi(a1) + (b1-b2)*psi(b1) + (a2-b2+b2-a1+a1-b1)*psi(a1+b1)
// Simplified approximation using digamma ≈ ln(x) - 1/(2x) for large x.
func klDivBeta(a1, b1, a2, b2 float64) float64 {
	// Ensure valid parameters.
	if a1 <= 0 || b1 <= 0 || a2 <= 0 || b2 <= 0 {
		return 0
	}
	// Approximate KL using the mean-based shortcut:
	// KL ≈ (mean_diff^2 * concentration) / 2
	// This is cheaper and numerically stable for our use case.
	mean1 := a1 / (a1 + b1)
	mean2 := a2 / (a2 + b2)
	conc := a1 + b1 // concentration of posterior
	diff := mean1 - mean2
	return diff * diff * conc / 2
}

// betaExpectation returns the mean of a Beta(alpha, beta) distribution.
// This is the deterministic analog of Thompson Sampling — it produces the same
// priority ordering as random sampling in expectation, without adding randomness
// to hook output (which should be deterministic for reproducibility).
func betaExpectation(alpha, beta float64) float64 {
	return alpha / (alpha + beta)
}

// Deliver routes a suggestion through the appropriate channel.
// For ChannelImmediate, the caller should include the returned string in the hook output.
// For ChannelNudge, the suggestion is enqueued to nudge_outbox.
// For ChannelDefer and ChannelSuppress, nothing is delivered.
func Deliver(sdb *sessiondb.SessionDB, pattern, level, observation, suggestion string, priority SuggestionPriority) (immediate string) {
	// Phase-aware gating: suppress suggestions inappropriate for current phase.
	if shouldGateForPhase(sdb, pattern) {
		return ""
	}

	// Enrichment: if this pattern was previously unresolved, add richer context.
	suggestion = enrichIfRepeated(sdb, pattern, suggestion)

	decision := RouteDelivery(sdb, pattern, priority)

	switch decision.Channel {
	case ChannelImmediate:
		return fmt.Sprintf("[buddy] %s (%s): %s\n→ %s", pattern, level, observation, suggestion)
	case ChannelNudge:
		_ = sdb.EnqueueNudge(pattern, level, observation, suggestion)
		return ""
	case ChannelDefer, ChannelSuppress:
		return ""
	}
	return ""
}

// contextualPatternKey builds a contextual key from (pattern, task_type, user_cluster).
// This allows Thompson Sampling to learn that e.g. "workflow" suggestions are effective
// during bugfix+conservative but not during feature+aggressive.
// Velocity state is intentionally excluded to increase data density per context (~3x).
func contextualPatternKey(pattern string) string {
	taskType := currentTaskType()
	cluster := currentUserCluster()
	if taskType == "" && cluster == "" {
		return pattern
	}
	if taskType == "" {
		taskType = "unknown"
	}
	if cluster == "" {
		cluster = "balanced"
	}
	return pattern + ":" + taskType + ":" + cluster
}

// currentTaskType reads the task_type from the current sessiondb.
// Returns empty string if unavailable (called from short-lived hook process).
func currentTaskType() string {
	// Read from process-level cache set by the hook handler.
	return ctxTaskType
}

// SetDeliveryContext caches task_type and user cluster for contextual Thompson Sampling.
// Called once per hook invocation before any Deliver calls.
// Velocity state is computed and cached for use by velocity wall detection (Phase 2),
// but excluded from the contextual pattern key to increase data density.
func SetDeliveryContext(sdb *sessiondb.SessionDB) {
	ctxTaskType, _ = sdb.GetContext("task_type")
	vel := getFloat(sdb, "ewma_tool_velocity")
	switch {
	case vel > 8.0:
		ctxVelocityState = "fast"
	case vel < 2.0:
		ctxVelocityState = "slow"
	default:
		ctxVelocityState = "normal"
	}

	// Cache user cluster from persistent store.
	if st, err := store.OpenDefault(); err == nil {
		ctxUserCluster = st.UserCluster()
		st.Close()
	}
}

// currentUserCluster returns the cached user cluster.
func currentUserCluster() string {
	return ctxUserCluster
}

// Process-level cache for contextual delivery (set once per hook invocation).
var (
	ctxTaskType      string
	ctxVelocityState string
	ctxUserCluster   string
)

func getBurstSuggestionCount(sdb *sessiondb.SessionDB) int {
	val, _ := sdb.GetContext("suggestions_this_burst")
	if val == "" {
		return 0
	}
	n, _ := strconv.Atoi(val)
	return n
}

func incrementBurstSuggestionCount(sdb *sessiondb.SessionDB) {
	count := getBurstSuggestionCount(sdb) + 1
	if err := sdb.SetContext("suggestions_this_burst", strconv.Itoa(count)); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] increment burst suggestion count: %v\n", err)
	}
}

// getSessionRNG returns a per-session RNG seeded from a stored seed.
// Each hook invocation within a session gets a fresh RNG from the same seed,
// providing cross-session exploration diversity while being debuggable.
func getSessionRNG(sdb *sessiondb.SessionDB) *rand.Rand {
	seedStr, _ := sdb.GetContext("thompson_seed")
	if seedStr == "" {
		seed := uint64(time.Now().UnixNano())
		seedStr = strconv.FormatUint(seed, 10)
		_ = sdb.SetContext("thompson_seed", seedStr)
	}
	seedVal, _ := strconv.ParseUint(seedStr, 10, 64)
	return rand.New(rand.NewPCG(seedVal, seedVal>>32))
}

// betaSample draws a random sample from a Beta(alpha, beta) distribution
// using the Gamma variate method: Beta(a,b) = X/(X+Y) where X~Gamma(a,1), Y~Gamma(b,1).
func betaSample(rng *rand.Rand, alpha, beta float64) float64 {
	if alpha <= 0 {
		alpha = 1
	}
	if beta <= 0 {
		beta = 1
	}
	x := gammaSample(rng, alpha)
	y := gammaSample(rng, beta)
	if x+y == 0 {
		return 0.5
	}
	return x / (x + y)
}

// enrichIfRepeated adds richer context when a pattern fires again after being unresolved.
// Instead of nagging with the same message, it appends past solution data or effectiveness stats.
func enrichIfRepeated(sdb *sessiondb.SessionDB, pattern, suggestion string) string {
	lastUnresolved, _ := sdb.GetContext("last_unresolved_pattern")
	if lastUnresolved != pattern {
		return suggestion
	}

	// Clear to avoid double-enrichment.
	_ = sdb.SetContext("last_unresolved_pattern", "")

	st, err := store.OpenDefault()
	if err != nil {
		return suggestion
	}
	defer st.Close()

	// Try to find past solutions for this pattern.
	if stats, serr := st.PatternFeedbackStats(pattern); serr == nil && stats.TotalCount > 0 {
		helpful := stats.Helpful
		total := stats.TotalCount
		suggestion += fmt.Sprintf(" (Previously: %d/%d found helpful)", helpful, total)
	}

	return suggestion
}

// gammaSample draws from Gamma(shape, 1) using Marsaglia and Tsang's method.
// For shape < 1, uses the boost: Gamma(a) = Gamma(a+1) * U^(1/a).
func gammaSample(rng *rand.Rand, shape float64) float64 {
	if shape < 1 {
		return gammaSample(rng, shape+1) * math.Pow(rng.Float64(), 1.0/shape)
	}
	d := shape - 1.0/3.0
	c := 1.0 / math.Sqrt(9.0*d)
	for {
		var x, v float64
		for {
			x = rng.NormFloat64()
			v = 1.0 + c*x
			if v > 0 {
				break
			}
		}
		v = v * v * v
		u := rng.Float64()
		if u < 1.0-0.0331*(x*x)*(x*x) {
			return d * v
		}
		if math.Log(u) < 0.5*x*x+d*(1.0-v+math.Log(v)) {
			return d * v
		}
	}
}
