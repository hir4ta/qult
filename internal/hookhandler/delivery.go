package hookhandler

import (
	"fmt"
	"os"
	"strconv"

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
func RouteDelivery(sdb *sessiondb.SessionDB, pattern string, priority SuggestionPriority) DeliveryDecision {
	// Suppress non-critical suggestions during productive flow or suggestion fatigue.
	if priority > PriorityCritical && (isInFlow(sdb) || suggestionFatigue(sdb)) {
		return DeliveryDecision{Channel: ChannelDefer, Priority: priority}
	}

	// Apply adaptive priority adjustment based on user preference data.
	adjusted := adjustPriority(pattern, priority)
	if adjusted >= PrioritySuppressed {
		return DeliveryDecision{Channel: ChannelSuppress, Priority: adjusted}
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

// adjustPriority uses Thompson Sampling to adaptively adjust suggestion priority.
// For patterns with UserPref data, it uses the weighted effectiveness score.
// For patterns with only delivery/resolution counts, it samples from a Beta distribution
// to naturally balance exploration (new patterns) and exploitation (proven patterns).
// Returns PrioritySuppressed if the pattern should not be delivered at all.
func adjustPriority(pattern string, base SuggestionPriority) SuggestionPriority {
	st, err := store.OpenDefault()
	if err != nil {
		return base
	}
	defer st.Close()

	// Check UserPref first (has weighted moving average from past sessions).
	pref, err := st.UserPreference(pattern)
	if err == nil && pref != nil {
		return adjustFromUserPref(pref, base)
	}

	// No UserPref — try Thompson Sampling from raw delivery/resolution counts.
	delivered, resolved, err := st.PatternEffectiveness(pattern)
	if err != nil || delivered == 0 {
		// No data at all — also check legacy suppression.
		if st.ShouldSuppressPattern(pattern) {
			return PrioritySuppressed
		}
		return base // prior Beta(1,1) = 0.5, explore at assigned priority
	}

	// Thompson Sampling: estimate true effectiveness via Beta posterior.
	estimate := betaExpectation(float64(resolved)+1, float64(delivered-resolved)+1)
	return adjustFromEstimate(estimate, base)
}

// adjustFromUserPref uses the weighted effectiveness score from UserPref.
func adjustFromUserPref(pref *store.UserPref, base SuggestionPriority) SuggestionPriority {
	return adjustFromEstimate(pref.EffectivenessScore, base)
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
