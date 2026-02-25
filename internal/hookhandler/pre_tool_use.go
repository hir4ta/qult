package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type preToolUseInput struct {
	CommonInput
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
}

func handlePreToolUse(input []byte) (*HookOutput, error) {
	var in preToolUseInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Destructive command gate for Bash.
	if in.ToolName == "Bash" {
		var toolInput struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(in.ToolInput, &toolInput); err == nil && toolInput.Command != "" {
			obs, sugg, matched := analyzer.MatchDestructiveCommand(toolInput.Command)
			if matched {
				reason := fmt.Sprintf("[buddy] %s\n→ %s", obs, sugg)
				return makeDenyOutput(reason), nil
			}
		}
	}

	// Open session DB for context-aware checks and nudge delivery.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PreToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// --- JARVIS advisor signals (proactive, before action) ---
	// Collect all applicable signals and return them combined.
	var signals []string

	// Bash: past failure warning.
	if in.ToolName == "Bash" {
		if warning := pastFailureWarning(sdb, in.ToolInput); warning != "" {
			signals = append(signals, warning)
		}
	}

	// Edit/Write: failure prediction + stale read + git dirty + related decisions.
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		if warning := editFailurePrediction(sdb, in.ToolInput); warning != "" {
			signals = append(signals, warning)
		}
		if guidance := staleReadCheck(sdb, in.ToolInput); guidance != "" {
			signals = append(signals, guidance)
		}
		if warning := preExistingChangesWarning(sdb, in.ToolInput); warning != "" {
			signals = append(signals, warning)
		}
		if decision := relatedDecisionSurfacing(sdb, in.ToolInput); decision != "" {
			signals = append(signals, decision)
		}
	}

	// Bash: compile/test failure prediction.
	if in.ToolName == "Bash" {
		if warning := bashFailurePrediction(sdb, in.ToolInput); warning != "" {
			signals = append(signals, warning)
		}
	}

	// Dequeue pending nudges as additionalContext.
	nudges, _ := sdb.DequeueNudges(1)
	if len(nudges) == 0 && len(signals) == 0 {
		return nil, nil
	}

	// Record delivery for effectiveness tracking.
	recordNudgeDelivery(sdb, in.SessionID, nudges)

	// Combine advisor signals and nudges into a single context string.
	var parts []string
	parts = append(parts, signals...)

	for _, n := range nudges {
		parts = append(parts, fmt.Sprintf("[buddy] %s (%s): %s\n→ %s",
			n.Pattern, n.Level, n.Observation, n.Suggestion))
	}

	return makeOutput("PreToolUse", strings.Join(parts, "\n")), nil
}

// staleReadCheck warns when an Edit/Write targets a file whose last Read
// was many tool calls ago, suggesting the content may be stale.
func staleReadCheck(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	lastSeq, _ := sdb.FileLastReadSeq(ei.FilePath)
	if lastSeq == 0 {
		// File was never Read in this session — warn.
		key := "stale_read:" + ei.FilePath
		on, _ := sdb.IsOnCooldown(key)
		if on {
			return ""
		}
		_ = sdb.SetCooldown(key, 10*time.Minute)
		return "[buddy] This file has not been Read in this session. Consider reading it first to ensure old_string matches current content."
	}

	currentSeq, _ := sdb.CurrentEventSeq()
	distance := currentSeq - lastSeq
	if distance < 8 {
		return ""
	}

	key := "stale_read:" + ei.FilePath
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}
	_ = sdb.SetCooldown(key, 10*time.Minute)

	return fmt.Sprintf(
		"[buddy] This file was last Read %d tool calls ago. Content may have changed — consider re-reading before editing.",
		distance,
	)
}

// pastFailureWarning checks if a similar Bash command failed recently in this session.
func pastFailureWarning(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var bi struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(toolInput, &bi) != nil || bi.Command == "" {
		return ""
	}

	sig := extractCmdSignature(bi.Command)
	if sig == "" {
		return ""
	}

	key := "past_failure:" + sig
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	summary, _ := sdb.FindSimilarFailure(sig)
	if summary == "" {
		return ""
	}

	_ = sdb.SetCooldown(key, 5*time.Minute)

	if len([]rune(summary)) > 100 {
		summary = string([]rune(summary)[:100]) + "..."
	}
	return fmt.Sprintf("[buddy] A similar command failed earlier in this session: %s", summary)
}

// extractCmdSignature extracts the base command pattern from a Bash command.
// "go test ./internal/store/..." → "go test"
// "npm install lodash" → "npm install"
func extractCmdSignature(command string) string {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return ""
	}
	if len(parts) >= 2 {
		return parts[0] + " " + parts[1]
	}
	return parts[0]
}

// preExistingChangesWarning warns when editing a file that had uncommitted changes
// at session start, indicating it may have been modified outside this session.
func preExistingChangesWarning(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	key := "git_dirty:" + filepath.Base(ei.FilePath)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	dirtyFiles, _ := sdb.GetWorkingSet("git_dirty_files")
	if dirtyFiles == "" {
		return ""
	}

	// Check if any dirty file path matches the target.
	target := ei.FilePath
	for _, dirty := range strings.Split(dirtyFiles, "\n") {
		if dirty == "" {
			continue
		}
		// Match by full path suffix or exact base name.
		if strings.HasSuffix(target, dirty) || filepath.Base(target) == filepath.Base(dirty) {
			_ = sdb.SetCooldown(key, 30*time.Minute)
			branch, _ := sdb.GetWorkingSet("git_branch")
			if branch != "" {
				return fmt.Sprintf("[buddy] %s had uncommitted changes at session start (branch: %s). Consider committing or stashing before further edits.", filepath.Base(ei.FilePath), branch)
			}
			return fmt.Sprintf("[buddy] %s had uncommitted changes at session start. Consider committing or stashing before further edits.", filepath.Base(ei.FilePath))
		}
	}

	return ""
}

// editFailurePrediction warns when a file has a history of edit failures in this session.
func editFailurePrediction(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	key := "edit_predict:" + filepath.Base(ei.FilePath)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	// Check failure probability from tool outcomes.
	prob, total, _ := sdb.FailureProbability("Edit", ei.FilePath)
	if total >= 3 && prob > 0.5 {
		_ = sdb.SetCooldown(key, 5*time.Minute)
		return fmt.Sprintf(
			"[buddy] Edit on this file has failed %.0f%% of the time (%d attempts). Read the file first to get exact content.",
			prob*100, total,
		)
	}

	// Check recent failure log for this specific file.
	failures, _ := sdb.RecentFailuresForFile(ei.FilePath, 3)
	mismatchCount := 0
	for _, f := range failures {
		if f.FailureType == "edit_mismatch" && time.Since(f.Timestamp) < 10*time.Minute {
			mismatchCount++
		}
	}
	if mismatchCount >= 2 {
		_ = sdb.SetCooldown(key, 5*time.Minute)
		return fmt.Sprintf(
			"[buddy] %d recent edit mismatches on this file. The content may have changed — Read the file before editing.",
			mismatchCount,
		)
	}

	return ""
}

// bashFailurePrediction warns when a Bash command is likely to fail based on session history.
func bashFailurePrediction(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var bi struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(toolInput, &bi) != nil || bi.Command == "" {
		return ""
	}

	// Check if the last failure was a compile error and the file hasn't been edited.
	failures, _ := sdb.RecentFailures(1)
	if len(failures) > 0 {
		f := failures[0]
		if f.FailureType == "compile_error" && time.Since(f.Timestamp) < 5*time.Minute && f.FilePath != "" {
			// Check if the file was edited since the failure.
			unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
			if unresolved && isCompileCommand(bi.Command) {
				key := "compile_predict:" + f.FilePath
				on, _ := sdb.IsOnCooldown(key)
				if !on {
					_ = sdb.SetCooldown(key, 3*time.Minute)
					return fmt.Sprintf(
						"[buddy] Last compile failed in %s and it hasn't been edited yet. Fix the file first.",
						filepath.Base(f.FilePath),
					)
				}
			}
		}

		if f.FailureType == "test_failure" && time.Since(f.Timestamp) < 5*time.Minute {
			// Check if any related file was edited since the test failure.
			files, _ := sdb.GetWorkingSetFiles()
			if len(files) == 0 && isTestCommand(bi.Command) {
				key := "test_predict"
				on, _ := sdb.IsOnCooldown(key)
				if !on {
					_ = sdb.SetCooldown(key, 3*time.Minute)
					return "[buddy] Tests failed recently and no files have been edited since. Fix the code first, then re-run tests."
				}
			}
		}
	}

	// Check tool sequence prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		outcome, count, _ := sdb.PredictOutcome(prevTool, "Bash")
		if outcome == "failure" && count >= 5 {
			key := "seq_predict:" + prevTool
			on, _ := sdb.IsOnCooldown(key)
			if !on {
				_ = sdb.SetCooldown(key, 5*time.Minute)
				return fmt.Sprintf(
					"[buddy] The pattern %s→Bash has failed %d times in this session. Consider a different approach.",
					prevTool, count,
				)
			}
		}
	}

	return ""
}

var compileCmdPattern = regexp.MustCompile(`\b(go build|go install|make|gcc|g\+\+|cargo build|npm run build|tsc)\b`)

func isCompileCommand(cmd string) bool {
	return compileCmdPattern.MatchString(cmd)
}

// isTestCommand reuses testCmdPattern from intent.go.
func isTestCommand(cmd string) bool {
	return testCmdPattern.MatchString(cmd)
}

// relatedDecisionSurfacing checks for past design decisions related to the target file.
func relatedDecisionSurfacing(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	key := "decision_surfacing:" + filepath.Base(ei.FilePath)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	decisions, _ := st.SearchDecisionsByFile(ei.FilePath, 2)
	if len(decisions) == 0 {
		return ""
	}

	_ = sdb.SetCooldown(key, 15*time.Minute)

	var b strings.Builder
	b.WriteString("[buddy] Past decisions for this file:\n")
	for _, d := range decisions {
		text := d.DecisionText
		if len([]rune(text)) > 120 {
			text = string([]rune(text)[:120]) + "..."
		}
		fmt.Fprintf(&b, "  - %s\n", text)
	}
	return b.String()
}
