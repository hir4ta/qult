package analyzer

import "sort"

// groupFor returns the alert group for a given pattern.
func groupFor(p PatternType) AlertGroup {
	switch p {
	case PatternDestructiveCmd:
		return GroupSafety
	case PatternCompactAmnesia, PatternRateLimitStuck:
		return GroupRecovery
	case PatternRetryLoop, PatternTestFailCycle, PatternApologizeRetry:
		return GroupExecution
	case PatternExploreLoop:
		return GroupExploration
	case PatternContextThrashing:
		return GroupContext
	default:
		return GroupExploration
	}
}

// priorityScore returns a score for alert ordering (higher = more important).
// Safety alerts always win; within a group, Action > Warning > Proposal.
func priorityScore(a Alert) int {
	base := 0
	switch groupFor(a.Pattern) {
	case GroupSafety:
		base = 100
	case GroupRecovery:
		base = 60
	case GroupExecution:
		base = 40
	case GroupContext:
		base = 30
	case GroupExploration:
		base = 20
	}

	// Kind bonus: alerts outprioritize proposals
	if a.Kind == KindAlert {
		base += 10
	}

	// Level bonus
	switch a.Level {
	case LevelAction:
		base += 5
	case LevelWarning:
		base += 3
	}

	return base
}

// SelectTopAlerts deduplicates alerts by group (keeping the highest-priority
// alert per group) and returns at most maxN alerts sorted by priority descending.
func SelectTopAlerts(alerts []Alert, maxN int) []Alert {
	if len(alerts) == 0 {
		return nil
	}

	// Within each group, keep only the highest-priority alert.
	// Walk newest-first so the most recent alert wins ties.
	type entry struct {
		alert    Alert
		priority int
	}
	best := make(map[AlertGroup]entry)

	for i := len(alerts) - 1; i >= 0; i-- {
		a := alerts[i]
		g := groupFor(a.Pattern)
		p := priorityScore(a)
		if cur, ok := best[g]; !ok || p > cur.priority {
			best[g] = entry{alert: a, priority: p}
		}
	}

	// Collect and sort by priority descending.
	result := make([]Alert, 0, len(best))
	for _, e := range best {
		result = append(result, e.alert)
	}
	sort.Slice(result, func(i, j int) bool {
		return priorityScore(result[i]) > priorityScore(result[j])
	})

	if len(result) > maxN {
		result = result[:maxN]
	}
	return result
}
