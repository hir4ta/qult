package analyzer

import (
	"testing"
	"time"
)

func TestSelectTopAlertsEmpty(t *testing.T) {
	t.Parallel()
	result := SelectTopAlerts(nil, 3)
	if len(result) != 0 {
		t.Errorf("expected empty, got %d alerts", len(result))
	}
}

func TestSelectTopAlertsSingle(t *testing.T) {
	t.Parallel()
	alerts := []Alert{{Pattern: PatternRetryLoop, Level: LevelWarning}}
	result := SelectTopAlerts(alerts, 3)
	if len(result) != 1 {
		t.Fatalf("expected 1, got %d", len(result))
	}
	if result[0].Pattern != PatternRetryLoop {
		t.Errorf("expected retry-loop, got %d", result[0].Pattern)
	}
}

func TestSelectTopAlertsMaxN(t *testing.T) {
	t.Parallel()
	alerts := []Alert{
		{Pattern: PatternRetryLoop, Level: LevelWarning},
		{Pattern: PatternDestructiveCmd, Level: LevelAction},
		{Pattern: PatternCompactAmnesia, Level: LevelWarning},
		{Pattern: PatternContextThrashing, Level: LevelWarning},
	}
	result := SelectTopAlerts(alerts, 2)
	if len(result) != 2 {
		t.Fatalf("expected 2, got %d", len(result))
	}
}

func TestSelectTopAlertsSafetyFirst(t *testing.T) {
	t.Parallel()
	alerts := []Alert{
		{Pattern: PatternRetryLoop, Level: LevelWarning},
		{Pattern: PatternExploreLoop, Level: LevelWarning},
		{Pattern: PatternDestructiveCmd, Level: LevelAction},
		{Pattern: PatternContextThrashing, Level: LevelWarning},
	}
	result := SelectTopAlerts(alerts, 3)
	// Safety alert should be first (highest priority)
	if result[0].Pattern != PatternDestructiveCmd {
		t.Errorf("expected destructive-cmd first, got %d", result[0].Pattern)
	}
}

func TestSelectTopAlertsGroupDeduplication(t *testing.T) {
	t.Parallel()
	// retry-loop and test-fail-cycle are same group (execution)
	alerts := []Alert{
		{Pattern: PatternRetryLoop, Kind: KindAlert, Level: LevelWarning, Timestamp: time.Now()},
		{Pattern: PatternTestFailCycle, Kind: KindAlert, Level: LevelWarning, Timestamp: time.Now()},
	}
	result := SelectTopAlerts(alerts, 3)
	// Same group → only one survives
	if len(result) != 1 {
		t.Errorf("expected 1 from same group, got %d", len(result))
	}
}

func TestSelectTopAlertsProposalLowerPriority(t *testing.T) {
	t.Parallel()
	// Same group (execution): alert should win over proposal
	alerts := []Alert{
		{Pattern: PatternRetryLoop, Kind: KindProposal, Level: LevelInfo},
		{Pattern: PatternTestFailCycle, Kind: KindAlert, Level: LevelWarning},
	}
	result := SelectTopAlerts(alerts, 3)
	// Same group → only one survives; alert should win
	if len(result) != 1 {
		t.Fatalf("expected 1 from same group, got %d", len(result))
	}
	if result[0].Kind != KindAlert {
		t.Error("full alert should win over proposal in same group")
	}
}

func TestGroupForAllPatterns(t *testing.T) {
	t.Parallel()
	cases := []struct {
		pattern PatternType
		group   AlertGroup
	}{
		{PatternDestructiveCmd, GroupSafety},
		{PatternCompactAmnesia, GroupRecovery},
		{PatternRateLimitStuck, GroupRecovery},
		{PatternRetryLoop, GroupExecution},
		{PatternTestFailCycle, GroupExecution},
		{PatternApologizeRetry, GroupExecution},
		{PatternExploreLoop, GroupExploration},
		{PatternContextThrashing, GroupContext},
	}
	for _, tc := range cases {
		t.Run(PatternName(tc.pattern), func(t *testing.T) {
			if g := groupFor(tc.pattern); g != tc.group {
				t.Errorf("groupFor(%s) = %d, want %d", PatternName(tc.pattern), g, tc.group)
			}
		})
	}
}
