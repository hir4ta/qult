package hookhandler

import (
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"strconv"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
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

	// Complexity gating: low-complexity tasks (delete, rename, format) only
	// receive Critical and High suggestions. This prevents mechanical operations
	// from being flooded with workflow and knowledge noise.
	complexity := currentTaskComplexity(sdb)
	if complexity == ComplexityLow && priority > PriorityHigh {
		return DeliveryDecision{Channel: ChannelSuppress, Priority: priority}
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

	// Apply graduated demotion before TS — probabilistically skip low-performing patterns.
	rng := getSessionRNG(sdb)
	if priority > PriorityHigh {
		if st, err := store.OpenDefaultCached(); err == nil {
			if applyGraduatedDemotion(rng, st, pattern) {
				return DeliveryDecision{Channel: ChannelSuppress, Priority: PrioritySuppressed}
			}
		}
	}

	// Apply adaptive priority adjustment using Thompson Sampling.
	var st *store.Store
	if s, err := store.OpenDefaultCached(); err == nil {
		st = s
	}
	result := adjustPriorityWithConfidence(rng, st, pattern, priority)
	ctxLastConfidence = result.Confidence
	adjusted := result.Priority
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

// AdjustResult holds the priority adjustment decision along with the
// confidence level of the underlying Thompson Sampling estimate.
type AdjustResult struct {
	Priority   SuggestionPriority
	Confidence float64 // alpha/(alpha+beta), range [0,1]; 0 means no data
}

// adjustPriorityWithConfidence uses Thompson Sampling to adaptively adjust
// suggestion priority based on historical effectiveness from user feedback.
// Alpha = resolution_count + 1 (successes + prior).
// Beta  = (delivery_count - resolution_count) + 1 (failures + prior).
func adjustPriorityWithConfidence(rng *rand.Rand, st *store.Store, pattern string, base SuggestionPriority) AdjustResult {
	if st == nil {
		return AdjustResult{Priority: base, Confidence: 0}
	}
	key := contextualPatternKey(pattern)
	pref, err := st.UserPreference(key)
	if err != nil || pref == nil || pref.DeliveryCount < 3 {
		return AdjustResult{Priority: base, Confidence: 0}
	}

	alpha := float64(pref.ResolutionCount) + 1
	beta := float64(pref.DeliveryCount-pref.ResolutionCount) + 1
	sample := betaSample(rng, alpha, beta)

	// Confidence: 1 - normalized Beta variance.
	// Var(Beta(a,b)) = ab / ((a+b)^2 * (a+b+1)), max 0.25 at a=b=1.
	ab := alpha + beta
	variance := (alpha * beta) / (ab * ab * (ab + 1))
	confidence := 1.0 - math.Min(variance*4, 1.0)

	adjusted := base
	switch {
	case sample > 0.6 && base > PriorityCritical:
		adjusted = base - 1
	case sample < 0.3 && base < PrioritySuppressed:
		adjusted = base + 1
	}

	return AdjustResult{Priority: adjusted, Confidence: confidence}
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

	// Personal context enrichment removed (alfred v1 simplification).

	// Gate WHY rationale based on flow detail (suppress during productive flow).
	if why != "" && !flowDetail(sdb).IncludeWhy {
		why = ""
	}

	decision := RouteDelivery(sdb, pattern, priority)

	// Append confidence to WHY when available.
	if why != "" && ctxLastConfidence > 0 {
		why += fmt.Sprintf(" (confidence: %.0f%%)", ctxLastConfidence*100)
	}

	switch decision.Channel {
	case ChannelImmediate:
		msg := fmt.Sprintf("[alfred] %s (%s): %s\n→ %s", pattern, level, observation, suggestion)
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
	ctxCwd, _ = sdb.GetContext("cwd")
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
	ctxTaskType       string
	ctxVelocityState  string
	ctxUserCluster    string
	ctxDomain         string  // used by SetDeliveryContext for domain-aware features outside TS
	ctxCwd            string  // project path for per-user pattern effectiveness lookup
	ctxLastConfidence float64 // last confidence from adjustPriorityWithConfidence
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
		fmt.Fprintf(os.Stderr, "[alfred] increment burst suggestion count: %v\n", err)
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

// enrichIfRepeated adds context when a pattern fires again after being unresolved.
func enrichIfRepeated(sdb *sessiondb.SessionDB, pattern, suggestion string) string {
	lastUnresolved, _ := sdb.GetContext("last_unresolved_pattern")
	if lastUnresolved != pattern {
		return suggestion
	}
	_ = sdb.SetContext("last_unresolved_pattern", "")
	return suggestion + " (repeated — previously unresolved)"
}

// patternSavingsNote returns an impact quantification note for high-priority suggestions.
// Reads aggregate delivery/resolution counts from user_preferences.
// Only shows after 5+ deliveries to avoid noisy early data.
func patternSavingsNote(pattern string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}
	key := contextualPatternKey(pattern)
	pref, err := st.UserPreference(key)
	if err != nil || pref == nil || pref.DeliveryCount < 5 {
		return ""
	}
	pct := float64(pref.ResolutionCount) / float64(pref.DeliveryCount) * 100
	return fmt.Sprintf("IMPACT: %d/%d suggestions acted on (%.0f%% effective)",
		pref.ResolutionCount, pref.DeliveryCount, pct)
}

// trackImplicitFeedback tracks turns since last MCP tool call (data recording only).
func trackImplicitFeedback(sdb *sessiondb.SessionDB, _ string) {
	turnsStr, _ := sdb.GetContext("turns_since_alfred_call")
	turns := 0
	if turnsStr != "" {
		turns, _ = strconv.Atoi(turnsStr)
	}
	turns++
	_ = sdb.SetContext("turns_since_alfred_call", strconv.Itoa(turns))
}

// ResetAlfredCallTracker resets the turns-since-alfred-call counter.
// Called from MCP tool handlers when alfred_* tools are invoked.
func ResetAlfredCallTracker(sdb *sessiondb.SessionDB) {
	_ = sdb.SetContext("turns_since_alfred_call", "0")
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

// applyGraduatedDemotion probabilistically suppresses patterns with poor effectiveness.
// Uses contextual key for per-(pattern, task_type, cluster) granularity.
// Requires 5+ deliveries before applying demotion (data maturity).
// Even the worst patterns get through ~10% of the time to allow recovery.
func applyGraduatedDemotion(rng *rand.Rand, st *store.Store, pattern string) bool {
	key := contextualPatternKey(pattern)
	pref, err := st.UserPreference(key)
	if err != nil || pref == nil {
		return false
	}
	if pref.DeliveryCount < 5 {
		return false
	}
	if pref.EffectivenessScore >= 0.3 {
		return false
	}
	// Probabilistic suppression: worse scores → higher suppression probability.
	// score=0.0 → 90% suppression, score=0.29 → 3% suppression.
	suppressProb := (0.3 - pref.EffectivenessScore) / 0.3 * 0.9
	return rng.Float64() < suppressProb
}
