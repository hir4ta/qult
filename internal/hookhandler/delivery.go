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

// adjustPriority applies the learned effectiveness score to adjust a suggestion's priority.
// Returns PrioritySuppressed if the pattern should not be delivered at all.
func adjustPriority(pattern string, base SuggestionPriority) SuggestionPriority {
	st, err := store.OpenDefault()
	if err != nil {
		return base
	}
	defer st.Close()

	pref, err := st.UserPreference(pattern)
	if err != nil || pref == nil {
		// No data yet — also check legacy suppression.
		if st.ShouldSuppressPattern(pattern) {
			return PrioritySuppressed
		}
		return base
	}

	score := pref.EffectivenessScore
	switch {
	case score > 0.7:
		return base // deliver at assigned priority
	case score > 0.4:
		if base < PriorityLow {
			return base + 1 // downgrade by 1 level
		}
		return base
	case score > 0.2:
		if base+2 < PrioritySuppressed {
			return base + 2 // downgrade by 2 levels
		}
		return PriorityLow
	default:
		return PrioritySuppressed
	}
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
