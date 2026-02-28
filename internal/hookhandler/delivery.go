package hookhandler

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
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
	// Critical priority bypasses all flow checks and Thompson Sampling.
	if priority == PriorityCritical {
		return DeliveryDecision{Channel: ChannelImmediate, Priority: priority}
	}

	// Graduated suppression based on multi-signal flow state.
	flow := classifyFlowState(sdb)
	switch flow {
	case FlowProductive:
		// Genuine productivity — only High+ gets through immediately.
		if priority > PriorityHigh {
			return DeliveryDecision{Channel: ChannelDefer, Priority: priority}
		}
	case FlowThrashing:
		// Active but struggling — promote Medium warnings to immediate, suppress Low.
		if priority == PriorityLow {
			return DeliveryDecision{Channel: ChannelSuppress, Priority: priority}
		}
		if priority == PriorityMedium {
			priority = PriorityHigh // promote warnings so they reach the user
		}
	case FlowFatigued:
		// User ignoring suggestions — reduce to High only, 1 per burst.
		if priority > PriorityHigh {
			return DeliveryDecision{Channel: ChannelSuppress, Priority: priority}
		}
		if priority == PriorityHigh && getBurstSuggestionCount(sdb) >= 1 {
			return DeliveryDecision{Channel: ChannelNudge, Priority: priority}
		}
	case FlowStalled:
		// Low velocity — deliver everything to help unstick.
		// No suppression; fall through to normal routing.
	default:
		// FlowNormal — standard routing.
	}

	// Workflow boundary boost: promote Medium → High at phase transitions,
	// commits, and task switches (52% engagement vs 31% mid-task).
	if priority == PriorityMedium && isAtWorkflowBoundary(sdb) {
		priority = PriorityHigh
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
	if adjusted <= PriorityHigh && burstCount >= burstCapForCluster() {
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
	st, err := store.OpenDefaultCached()
	if err != nil {
		return base
	}

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
	if base > PriorityHigh && shouldSuppressForCluster(st, pattern) {
		return PrioritySuppressed
	}

	// Thompson Sampling: 2-tier fallback for data density.
	// 1. Contextual key (pattern:taskType:cluster)
	// 2. Base pattern only
	hl := patternDecayHalfLife(pattern)
	delivered, resolved, err := st.DecayedPatternEffectiveness(ctxKey, hl)
	if err != nil || delivered < 3.0 {
		delivered, resolved, err = st.DecayedPatternEffectiveness(pattern, hl)
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
// The optional reasoning parameter adds a WHY line explaining the deeper rationale.
func Deliver(sdb *sessiondb.SessionDB, pattern, level, observation, suggestion string, priority SuggestionPriority, reasoning ...string) (immediate string) {
	// Phase-aware gating: suppress suggestions inappropriate for current phase.
	if shouldGateForPhase(sdb, pattern) {
		return ""
	}

	// Enrichment: if this pattern was previously unresolved, add richer context.
	suggestion = enrichIfRepeated(sdb, pattern, suggestion)

	why := ""
	if len(reasoning) > 0 && reasoning[0] != "" {
		why = reasoning[0]
	}

	// Enrich WHY with personal data when available.
	if why != "" {
		ps := personalContext(sdb)
		why = formatPersonalWhy(why, ps, pattern)
	}

	// Gate WHY rationale based on flow detail (suppress during productive flow).
	if why != "" && !flowDetail(sdb).IncludeWhy {
		why = ""
	}

	decision := RouteDelivery(sdb, pattern, priority)

	switch decision.Channel {
	case ChannelImmediate:
		msg := fmt.Sprintf("[buddy] %s (%s): %s\n→ %s", pattern, level, observation, suggestion)
		if why != "" {
			msg += "\n  WHY: " + why
		}
		// Quantified impact for deny/warn patterns.
		if priority <= PriorityHigh {
			if savingsNote := patternSavingsNote(pattern); savingsNote != "" {
				msg += "\n  " + savingsNote
			}
		}
		msg += SkillHintForPattern(pattern)
		return msg
	case ChannelNudge:
		nudgeSuggestion := suggestion
		if why != "" {
			nudgeSuggestion += "\n  WHY: " + why
		}
		_ = sdb.EnqueueNudge(pattern, level, observation, nudgeSuggestion)
		return ""
	case ChannelDefer, ChannelSuppress:
		return ""
	}
	return ""
}

// contextualPatternKey builds a contextual key from (pattern, task_type, user_cluster).
// This allows Thompson Sampling to learn that e.g. "workflow" suggestions are effective
// during bugfix+conservative but not during feature+aggressive.
// Velocity state and domain are intentionally excluded to increase data density per context.
// Domain was previously included but caused sparse data — most patterns never accumulated
// enough deliveries per (pattern, taskType, cluster, domain) tuple to learn effectively.
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

// SetDeliveryContext caches task_type, domain, and user cluster for contextual Thompson Sampling.
// Called once per hook invocation before any Deliver calls.
// Velocity state is computed and cached for use by velocity wall detection,
// but excluded from the contextual pattern key to increase data density.
func SetDeliveryContext(sdb *sessiondb.SessionDB) {
	ctxTaskType, _ = sdb.GetContext("task_type")
	ctxDomain, _ = sdb.GetWorkingSet("domain")
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
	if st, err := store.OpenDefaultCached(); err == nil {
		ctxUserCluster = st.UserCluster()
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
	ctxDomain        string // used by SetDeliveryContext for domain-aware features outside TS
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

	st, err := store.OpenDefaultCached()
	if err != nil {
		return suggestion
	}

	// Try to find past solutions for this pattern.
	if stats, serr := st.PatternFeedbackStats(pattern); serr == nil && stats.TotalCount > 0 {
		helpful := stats.Helpful
		total := stats.TotalCount
		suggestion += fmt.Sprintf(" (Previously: %d/%d found helpful)", helpful, total)
	}

	// Search for past resolution diffs from recent failures.
	failures, _ := sdb.RecentFailures(1)
	if len(failures) > 0 && failures[0].FilePath != "" {
		solutions, _ := st.SearchFailureSolutionsByFile(failures[0].FilePath, 1)
		if len(solutions) > 0 && solutions[0].ResolutionDiff != "" {
			var diff struct {
				Old string `json:"old"`
				New string `json:"new"`
			}
			if json.Unmarshal([]byte(solutions[0].ResolutionDiff), &diff) == nil && diff.Old != "" {
				old := truncate(diff.Old, 50)
				new_ := truncate(diff.New, 50)
				suggestion += fmt.Sprintf("\n  Past fix: `%s` → `%s`", old, new_)
			}
		}
	}

	return suggestion
}

// patternSavingsNote returns a quantified savings message for high-priority patterns.
// e.g., "IMPACT: Acting on this saved avg 12 tools in past 5 sessions"
func patternSavingsNote(pattern string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	saved, instances, err := st.PatternSavings(pattern)
	if err != nil || instances < 2 || saved < 3 {
		return ""
	}
	return fmt.Sprintf("IMPACT: Acting on this saved avg %d tools in past %d instances", saved, instances)
}

// trackImplicitFeedback records implicit negative signals when buddy MCP tools
// haven't been called in a while. If Claude doesn't ask buddy for help across
// multiple user turns, the current suggestions likely aren't valuable enough.
// This feeds into Thompson Sampling to improve future suggestion relevance.
func trackImplicitFeedback(sdb *sessiondb.SessionDB, sessionID string) {
	// Count user turns since last buddy MCP tool call.
	turnsStr, _ := sdb.GetContext("turns_since_buddy_call")
	turns := 0
	if turnsStr != "" {
		turns, _ = strconv.Atoi(turnsStr)
	}
	turns++
	_ = sdb.SetContext("turns_since_buddy_call", strconv.Itoa(turns))

	// After 5+ turns without a buddy call, record as implicit negative signal.
	// This suggests suggestions aren't compelling enough to trigger MCP usage.
	if turns < 5 {
		return
	}

	// Only fire once per silence period (reset after recording).
	on, _ := sdb.IsOnCooldown("implicit_silence_feedback")
	if on {
		return
	}
	_ = sdb.SetCooldown("implicit_silence_feedback", 15*time.Minute)

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Record as auto-feedback against recently delivered patterns.
	_ = st.InsertFeedback(sessionID, "auto:silence", store.RatingNotHelpful,
		"auto: no buddy MCP calls in 5+ user turns", 0)
}

// ResetBuddyCallTracker resets the turns-since-buddy-call counter.
// Called from MCP tool handlers when buddy_* tools are invoked.
func ResetBuddyCallTracker(sdb *sessiondb.SessionDB) {
	_ = sdb.SetContext("turns_since_buddy_call", "0")
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

// patternDecayHalfLife returns the decay half-life based on pattern type.
// Tactical patterns (code-quality, retry-loop) decay faster (14 days),
// strategic patterns (knowledge, coaching) persist longer (60 days).
func patternDecayHalfLife(pattern string) time.Duration {
	base := pattern
	if idx := strings.Index(pattern, ":"); idx > 0 {
		base = pattern[:idx]
	}
	switch base {
	case "code-quality", "retry-loop", "stale-read":
		return 14 * 24 * time.Hour
	case "knowledge", "strategic", "coaching", "playbook":
		return 60 * 24 * time.Hour
	default:
		return 30 * 24 * time.Hour
	}
}

// burstCapForCluster returns the max suggestions per burst based on user cluster.
// Conservative users accept more guidance (5), aggressive users prefer less (1).
func burstCapForCluster() int {
	switch ctxUserCluster {
	case "conservative":
		return 5
	case "aggressive":
		return 1
	default:
		return 3
	}
}

// shouldSuppressForCluster applies cluster-adapted suppression thresholds.
func shouldSuppressForCluster(st *store.Store, pattern string) bool {
	delivered, resolved, err := st.DecayedPatternEffectiveness(pattern)
	if err != nil {
		return false
	}
	minDel, maxRate := suppressThresholdsForCluster()
	if delivered < float64(minDel) {
		return false
	}
	rate := resolved / delivered
	return rate < maxRate
}

func suppressThresholdsForCluster() (int, float64) {
	switch ctxUserCluster {
	case "conservative":
		return 20, 0.03
	case "aggressive":
		return 10, 0.08
	default:
		return 15, 0.05
	}
}
