package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// SkillContext holds aggregated session data tailored for a specific skill.
type SkillContext struct {
	SkillName     string            `json:"skill_name"`
	SessionID     string            `json:"session_id"`
	TaskType      string            `json:"task_type,omitempty"`
	Intent        string            `json:"intent,omitempty"`
	Branch        string            `json:"branch,omitempty"`
	HealthScore   float64           `json:"health_score"`
	ModifiedFiles []string          `json:"modified_files,omitempty"`
	Context       map[string]string `json:"context,omitempty"`
	Alerts        []string          `json:"alerts,omitempty"`
	Suggestions   []string          `json:"suggestions,omitempty"`
}

func skillContextHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		skillName := req.GetString("skill_name", "")
		if skillName == "" {
			return mcp.NewToolResultError("skill_name is required"), nil
		}

		sessionID := req.GetString("session_id", "")
		var fullSessionID string
		if sessionID != "" {
			sessions, _ := watcher.ListSessions(claudeHome)
			for _, s := range sessions {
				if strings.HasPrefix(s.SessionID, sessionID) {
					fullSessionID = s.SessionID
					break
				}
			}
		} else {
			if s := findLatestSession(claudeHome); s != nil {
				fullSessionID = s.SessionID
			}
		}

		if fullSessionID == "" {
			return mcp.NewToolResultError("no active session found"), nil
		}

		dbPath := sessiondb.DBPath(fullSessionID)
		if _, err := os.Stat(dbPath); err != nil {
			return mcp.NewToolResultError("session database not found"), nil
		}

		sdb, err := sessiondb.Open(fullSessionID)
		if err != nil {
			return mcp.NewToolResultError("failed to open session db: " + err.Error()), nil
		}
		defer sdb.Close()

		sid := fullSessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}

		sc := SkillContext{
			SkillName: skillName,
			SessionID: sid,
		}

		// Common session data.
		sc.Intent, _ = sdb.GetWorkingSet("intent")
		sc.TaskType, _ = sdb.GetWorkingSet("task_type")
		sc.Branch, _ = sdb.GetWorkingSet("git_branch")
		sc.ModifiedFiles, _ = sdb.GetWorkingSetFiles()
		sc.HealthScore = computeHealthScore(sdb)

		// Skill-specific enrichment.
		switch skillName {
		case "buddy-review":
			sc.Context, sc.Alerts, sc.Suggestions = enrichForReview(sdb)
		case "buddy-before-commit":
			sc.Context, sc.Alerts, sc.Suggestions = enrichForCommit(sdb)
		case "buddy-unstuck":
			sc.Context, sc.Alerts, sc.Suggestions = enrichForUnstuck(sdb)
		case "buddy-checkpoint":
			sc.Context, sc.Alerts, sc.Suggestions = enrichForCheckpoint(sdb)
		default:
			sc.Context = map[string]string{"note": "generic context"}
		}

		data, _ := json.MarshalIndent(sc, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func computeHealthScore(sdb *sessiondb.SessionDB) float64 {
	score := 1.0

	// Deductions for error rate.
	errRateStr, _ := sdb.GetContext("ewma_error_rate")
	if errRateStr != "" {
		var errRate float64
		if _, err := fmt.Sscanf(errRateStr, "%f", &errRate); err == nil && errRate > 0.2 {
			score -= errRate * 0.5
		}
	}

	// Deductions for unresolved failures (cap total failure deductions at 0.3).
	failures, _ := sdb.RecentFailures(3)
	failureDeduction := 0.0
	for _, f := range failures {
		if f.FilePath == "" || time.Since(f.Timestamp) > 10*time.Minute {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			failureDeduction += 0.15
		}
	}
	if failureDeduction > 0.3 {
		failureDeduction = 0.3
	}
	score -= failureDeduction

	return max(0, score)
}

func enrichForReview(sdb *sessiondb.SessionDB) (map[string]string, []string, []string) {
	ctx := make(map[string]string)
	var alerts, suggestions []string

	// Test status.
	if v, _ := sdb.GetContext("last_test_passed"); v == "true" {
		ctx["tests"] = "passed"
	} else if v == "false" {
		ctx["tests"] = "failed"
		alerts = append(alerts, "Tests are currently failing")
	} else {
		ctx["tests"] = "not run"
	}

	if v, _ := sdb.GetContext("last_build_passed"); v == "false" {
		alerts = append(alerts, "Build is currently failing")
	}

	// Find patterns for modified files.
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) > 0 {
		st, err := store.OpenDefault()
		if err == nil {
			defer st.Close()
			for _, f := range files {
				patterns, _ := st.SearchPatternsByFile(f, 1)
				for _, p := range patterns {
					text := p.Content
					if len([]rune(text)) > 80 {
						text = string([]rune(text)[:80]) + "..."
					}
					suggestions = append(suggestions, fmt.Sprintf("[%s] %s: %s", p.PatternType, filepath.Base(f), text))
				}
				if len(suggestions) >= 5 {
					break
				}
			}
		}
	}

	return ctx, alerts, suggestions
}

func enrichForCommit(sdb *sessiondb.SessionDB) (map[string]string, []string, []string) {
	ctx := make(map[string]string)
	var alerts, suggestions []string

	// Test and build status.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	lastBuildPassed, _ := sdb.GetContext("last_build_passed")

	ctx["tests_run"] = hasTestRun
	ctx["tests_passed"] = lastTestPassed
	ctx["build_passed"] = lastBuildPassed

	if hasTestRun != "true" {
		alerts = append(alerts, "Tests have not been run in this session")
	} else if lastTestPassed == "false" {
		alerts = append(alerts, "Tests are currently failing — fix before committing")
	}

	if lastBuildPassed == "false" {
		alerts = append(alerts, "Build is failing — fix before committing")
	}

	// Unresolved failures.
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			alerts = append(alerts, fmt.Sprintf("Unresolved %s in %s", failType, filepath.Base(f.FilePath)))
		}
	}

	if len(alerts) == 0 {
		suggestions = append(suggestions, "All checks passed — safe to commit")
	}

	return ctx, alerts, suggestions
}

func enrichForUnstuck(sdb *sessiondb.SessionDB) (map[string]string, []string, []string) {
	ctx := make(map[string]string)
	var alerts, suggestions []string

	// Error rate.
	errRateStr, _ := sdb.GetContext("ewma_error_rate")
	if errRateStr != "" {
		ctx["error_rate"] = errRateStr
	}

	// Recent failures.
	failures, _ := sdb.RecentFailures(5)
	for _, f := range failures {
		if f.FilePath != "" {
			alerts = append(alerts, fmt.Sprintf("%s in %s: %s",
				f.FailureType, filepath.Base(f.FilePath), truncate(f.ErrorSig, 60)))
		}
	}

	// Find past solutions for recent errors.
	st, err := store.OpenDefault()
	if err == nil {
		defer st.Close()
		for _, f := range failures {
			if f.ErrorSig == "" {
				continue
			}
			solutions, _ := st.SearchFailureSolutions(f.FailureType, f.ErrorSig, 1)
			for _, sol := range solutions {
				suggestions = append(suggestions, fmt.Sprintf("Past solution: %s", truncate(sol.SolutionText, 80)))
			}
			if len(suggestions) >= 3 {
				break
			}
		}
	}

	// Burst state.
	tc, hasWrite, _, _ := sdb.BurstState()
	ctx["tool_count"] = fmt.Sprintf("%d", tc)
	if hasWrite {
		ctx["has_edits"] = "true"
	}

	return ctx, alerts, suggestions
}

func enrichForCheckpoint(sdb *sessiondb.SessionDB) (map[string]string, []string, []string) {
	ctx := make(map[string]string)
	var alerts, suggestions []string

	tc, hasWrite, _, _ := sdb.BurstState()
	ctx["tool_count"] = fmt.Sprintf("%d", tc)
	if hasWrite {
		ctx["has_edits"] = "true"
	}

	velStr, _ := sdb.GetContext("ewma_tool_velocity")
	if velStr != "" {
		ctx["velocity"] = velStr
	}

	errRateStr, _ := sdb.GetContext("ewma_error_rate")
	if errRateStr != "" {
		ctx["error_rate"] = errRateStr
	}

	files, _ := sdb.GetWorkingSetFiles()
	ctx["files_modified"] = fmt.Sprintf("%d", len(files))

	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun != "true" && len(files) > 2 {
		suggestions = append(suggestions, "Consider running tests — multiple files modified")
	}

	return ctx, alerts, suggestions
}

