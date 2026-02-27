package hookhandler

import (
	"fmt"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// episodeSignal represents a detected early-warning signal from an episode template.
type episodeSignal struct {
	Name       string
	Message    string
	Matched    int
	Total      int
	Confidence float64 // matched / total
}

// detectEpisodes scans recent events for partial matches against known
// anti-pattern episodes. Returns a signal when 60-70% of the episode
// steps have been matched but the full pattern has not yet completed.
// This enables "JARVIS-style" warnings BEFORE the anti-pattern fully manifests.
func (d *HookDetector) detectEpisodes() *episodeSignal {
	events, err := d.sdb.RecentEvents(15)
	if err != nil || len(events) < 2 {
		return nil
	}

	// Try each episode template; return the first signal found.
	detectors := []func([]sessiondb.HookEvent) *episodeSignal{
		d.episodeRetryCascade,
		d.episodeExploreToStuck,
		d.episodeEditFailSpiral,
		d.episodeTestFailFixup,
		d.episodeContextOverload,
	}

	for _, detect := range detectors {
		if sig := detect(events); sig != nil {
			set, _ := d.sdb.TrySetCooldown("episode:"+sig.Name, 10*time.Minute)
			if !set {
				continue
			}
			// Enrich with domain-specific advice when available.
			domain, _ := d.sdb.GetWorkingSet("domain")
			sig.Message += domainAdvice(sig.Name, domain)
			return sig
		}
	}

	// Check dynamically learned episodes from past sessions.
	if msg := d.detectLearnedEpisodes(); msg != "" {
		return &episodeSignal{Name: "learned", Message: msg}
	}

	// Check if current session trajectory matches a past failed session.
	if msg := d.detectTrajectoryMatch(); msg != "" {
		return &episodeSignal{Name: "trajectory", Message: msg}
	}

	return nil
}

// episodeRetryCascade detects the early stage of a retry loop:
// 2 consecutive identical tool calls (warns before 3rd, the current trigger).
func (d *HookDetector) episodeRetryCascade(events []sessiondb.HookEvent) *episodeSignal {
	if len(events) < 2 {
		return nil
	}

	// events[0] is the most recent. Check if last 2 are identical.
	if events[0].ToolName == events[1].ToolName && events[0].InputHash == events[1].InputHash {
		// Only fire if the full retry loop (3+) hasn't been detected yet.
		if len(events) >= 3 && events[2].ToolName == events[0].ToolName && events[2].InputHash == events[0].InputHash {
			return nil // full pattern already exists, let the main detector handle it
		}
		return &episodeSignal{
			Name:       "retry_cascade",
			Matched:    2,
			Total:      3,
			Confidence: 0.67,
			Message: fmt.Sprintf(
				"[buddy] early-warning (retry_cascade): %s called twice with identical input. A 3rd retry is unlikely to succeed — consider a different approach.",
				events[0].ToolName,
			),
		}
	}
	return nil
}

// episodeExploreToStuck detects prolonged read-only exploration that often
// leads to stuckness. Warns at 7+ consecutive reads (before the 10+ threshold).
func (d *HookDetector) episodeExploreToStuck(events []sessiondb.HookEvent) *episodeSignal {
	if d.inPlanMode() || d.subagentActive() {
		return nil
	}

	readCount := 0
	for _, ev := range events {
		if isReadTool(ev.ToolName) {
			readCount++
		} else if ev.IsWrite {
			break // encountered a write, stop counting
		} else {
			readCount++ // non-write, non-read tool still counts toward exploration
		}
	}

	// Warn at 7+ (before the existing 10+ minute / tool-count thresholds).
	if readCount >= 7 && readCount < 12 {
		return &episodeSignal{
			Name:       "explore_to_stuck",
			Matched:    readCount,
			Total:      12,
			Confidence: float64(readCount) / 12.0,
			Message: fmt.Sprintf(
				"[buddy] early-warning (explore_to_stuck): %d consecutive read operations without any writes. Consider narrowing scope or starting implementation.",
				readCount,
			),
		}
	}
	return nil
}

// episodeEditFailSpiral detects an emerging edit-fail cycle.
// Pattern: Edit → fail → Edit (same file hash) → about to fail again.
// Warns at 2 edit-fail cycles (before the 3-cycle threshold).
func (d *HookDetector) episodeEditFailSpiral(events []sessiondb.HookEvent) *episodeSignal {
	failures, err := d.sdb.RecentFailures(5)
	if err != nil || len(failures) < 2 {
		return nil
	}

	// Count edit failures on the same file.
	fileCounts := make(map[string]int)
	for _, f := range failures {
		if f.ToolName == "Edit" && f.FilePath != "" {
			fileCounts[f.FilePath]++
		}
	}

	for file, count := range fileCounts {
		if count >= 2 {
			// Check if the most recent event is also an Edit targeting the same file.
			if len(events) > 0 && events[0].ToolName == "Edit" {
				return &episodeSignal{
					Name:       "edit_fail_spiral",
					Matched:    count,
					Total:      3,
					Confidence: float64(count) / 3.0,
					Message: fmt.Sprintf(
						"[buddy] early-warning (edit_fail_spiral): Edit has failed %d times on %s. Read the file first to verify exact content before the next edit attempt.",
						count, shortPath(file),
					),
				}
			}
		}
	}
	return nil
}

// episodeTestFailFixup detects an emerging test-fail-edit loop.
// Pattern: Bash(test) → fail → Edit → Bash(test) → fail → Edit ...
// Warns at 2 cycles (before the 3-cycle threshold).
func (d *HookDetector) episodeTestFailFixup(events []sessiondb.HookEvent) *episodeSignal {
	failures, err := d.sdb.RecentFailures(5)
	if err != nil {
		return nil
	}

	testFailCount := 0
	for _, f := range failures {
		if f.ToolName == "Bash" && isTestFailure(f.FailureType) {
			testFailCount++
		}
	}

	if testFailCount < 2 {
		return nil
	}

	// Check if there's an edit between the failures (fix attempt).
	hasEditBetween := false
	for _, ev := range events {
		if ev.IsWrite {
			hasEditBetween = true
			break
		}
	}

	if !hasEditBetween {
		return nil
	}

	return &episodeSignal{
		Name:       "test_fail_fixup",
		Matched:    testFailCount,
		Total:      3,
		Confidence: float64(testFailCount) / 3.0,
		Message: fmt.Sprintf(
			"[buddy] early-warning (test_fail_fixup): Tests have failed %d times with edit attempts between runs. Consider reading the test output carefully or trying a fundamentally different approach.",
			testFailCount,
		),
	}
}

// episodeContextOverload detects when context pressure is building up
// (1 compact + high tool count in current burst) before a 2nd compact.
func (d *HookDetector) episodeContextOverload(events []sessiondb.HookEvent) *episodeSignal {
	compacts, err := d.sdb.CompactsInWindow(60)
	if err != nil || compacts < 1 {
		return nil
	}

	tc, _, _, err := d.sdb.BurstState()
	if err != nil {
		return nil
	}

	// 1 compact + high burst = building toward context overload.
	if compacts == 1 && tc >= 10 {
		return &episodeSignal{
			Name:       "context_overload",
			Matched:    1,
			Total:      2,
			Confidence: 0.6,
			Message: fmt.Sprintf(
				"[buddy] early-warning (context_overload): 1 compaction already occurred and current burst has %d tools. Consider summarizing key decisions now to preserve context before the next compaction.",
				tc,
			),
		}
	}
	return nil
}

// domainAdvice returns domain-specific guidance to append to episode warnings.
// Returns empty string if no domain-specific advice is available.
func domainAdvice(episodeName, domain string) string {
	if domain == "" || domain == "general" {
		return ""
	}
	tips := map[string]map[string]string{
		"retry_cascade": {
			"database": "For database operations, check connection state and transaction isolation before retrying.",
			"auth":     "For auth failures, verify token expiry and credential validity before retrying.",
			"api":      "For API failures, check rate limits, request payload, and endpoint availability.",
			"ui":       "For UI render failures, check component props and state management.",
			"config":   "For config failures, validate syntax and check for environment-specific overrides.",
			"infra":    "For infra failures, check service health, resource limits, and deployment state.",
		},
		"edit_fail_spiral": {
			"database": "Migration files have strict formatting. Read the exact schema before editing.",
			"config":   "Config files are whitespace-sensitive. Read with exact line range.",
			"auth":     "Auth files often have security constraints. Verify the exact token/key format.",
			"infra":    "Infrastructure files (YAML/Dockerfile) are indentation-sensitive. Re-read before editing.",
		},
		"test_fail_fixup": {
			"database": "Database test failures often stem from stale fixtures or migration state. Check test setup.",
			"auth":     "Auth test failures may need token refresh or mock credential updates.",
			"api":      "API test failures — check if the endpoint contract changed or if mock responses are stale.",
		},
		"explore_to_stuck": {
			"database": "For database exploration, focus on the schema and migrations first, then query code.",
			"auth":     "For auth exploration, trace the authentication flow from entry point to token validation.",
			"api":      "For API exploration, start with the route definitions, then trace to handlers.",
		},
	}
	if episodeTips, ok := tips[episodeName]; ok {
		if tip, ok := episodeTips[domain]; ok {
			return "\n  Domain note: " + tip
		}
	}
	return ""
}

// isReadTool returns true for tools that read but don't modify.
func isReadTool(toolName string) bool {
	switch toolName {
	case "Read", "Glob", "Grep", "WebFetch", "WebSearch":
		return true
	}
	return false
}

// isTestFailure checks if a failure type indicates a test failure.
func isTestFailure(failureType string) bool {
	return strings.Contains(failureType, "test") || strings.Contains(failureType, "Test")
}

// shortPath returns the last 2 path components for display.
func shortPath(path string) string {
	parts := strings.Split(path, "/")
	if len(parts) <= 2 {
		return path
	}
	return strings.Join(parts[len(parts)-2:], "/")
}
