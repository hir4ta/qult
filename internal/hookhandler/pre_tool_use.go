package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/analyzer"
	"github.com/hir4ta/claude-alfred/internal/sessiondb"
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
				reason := fmt.Sprintf("[alfred] %s\n→ %s", obs, sugg)
				if note := patternSavingsNote("destructive-command"); note != "" {
					reason += "\n  " + note
				}
				return makeDenyOutput(reason), nil
			}
		}
	}

	// Safety check: inject -i for bare rm commands, warn for git stash drop.
	var safetyWarning string
	if in.ToolName == "Bash" {
		if sr := checkBashSafety(in.ToolInput); sr != nil {
			if sr.UpdatedInput != nil {
				return makeUpdatedInputOutput(sr.UpdatedInput, sr.Warning), nil
			}
			safetyWarning = sr.Warning
		}
	}

	// Open session DB for context-aware checks and nudge delivery.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] PreToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Clear pending question followup flag — Claude is taking an action.
	_ = sdb.SetContext("awaiting_question_followup", "")

	// Lightweight mode: skip heavy analysis during subagent activity or in agent sessions.
	// Agent sessions (spawned by Agent tool) have their own sessiondb with count=0,
	// so we also check the is_agent_session flag set at SessionStart.
	// Safety checks (destructive gate, bash safety) already ran above.
	isAgent, _ := sdb.GetContext("is_agent_session")
	if sdb.ActiveSubagentCount() > 0 || isAgent == "true" {
		if safetyWarning != "" {
			return makeOutput("PreToolUse", safetyWarning), nil
		}
		return nil, nil
	}

	// Silent auto-correction: improve tool inputs before execution.
	if out := autoCorrectTool(sdb, in.ToolName, in.ToolInput, in.CWD); out != nil {
		return out, nil
	}

	// Auto-apply high-confidence code fixes (>=0.9) on Edit for Go files.

	// Light mode: safety gates + auto-corrections only.
	// Advisory intelligence is available on-demand via MCP tools
	// (alfred_guidance, alfred_knowledge, alfred_diagnose).
	if safetyWarning != "" {
		return makeOutput("PreToolUse", safetyWarning), nil
	}

	return nil, nil
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

var compileCmdPattern = regexp.MustCompile(`\b(go build|go install|make|gcc|g\+\+|cargo build|npm run build|tsc)\b`)

func isCompileCommand(cmd string) bool {
	return compileCmdPattern.MatchString(cmd)
}


// --- Auto-correction (JARVIS mode) ---

// autoCorrectTool silently improves tool inputs before execution.
func autoCorrectTool(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage, cwd string) *HookOutput {
	if toolName != "Bash" {
		return nil
	}

	var bi struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(toolInput, &bi); err != nil || bi.Command == "" {
		return nil
	}

	// go test ./... → narrowed to changed packages.
	if corrected, ctx := narrowTestScope(sdb, bi.Command, cwd); corrected != "" {
		updated, _ := json.Marshal(map[string]string{"command": corrected})
		return makeUpdatedInputOutput(updated, ctx)
	}

	// git add . → scoped to working set files.
	if corrected, ctx := scopeGitAdd(sdb, bi.Command, cwd); corrected != "" {
		updated, _ := json.Marshal(map[string]string{"command": corrected})
		return makeUpdatedInputOutput(updated, ctx)
	}

	// go test -race → add -count=1 to disable test caching.
	if corrected, ctx := fixGoTestRaceCache(bi.Command); corrected != "" {
		updated, _ := json.Marshal(map[string]string{"command": corrected})
		return makeUpdatedInputOutput(updated, ctx)
	}

	// git push --force → --force-with-lease (safer).
	if corrected, ctx := fixForcePush(bi.Command); corrected != "" {
		updated, _ := json.Marshal(map[string]string{"command": corrected})
		return makeUpdatedInputOutput(updated, ctx)
	}

	return nil
}

// fixForcePush replaces git push --force with --force-with-lease.
func fixForcePush(cmd string) (string, string) {
	if !strings.Contains(cmd, "git push") {
		return "", ""
	}
	if !strings.Contains(cmd, "--force") || strings.Contains(cmd, "--force-with-lease") {
		return "", ""
	}
	corrected := strings.Replace(cmd, "--force", "--force-with-lease", 1)
	return corrected, "[alfred] Replaced --force with --force-with-lease to prevent overwriting others' work"
}

// fixGoTestRaceCache adds -count=1 to go test -race commands to disable test caching,
// which can mask race conditions.
func fixGoTestRaceCache(cmd string) (string, string) {
	if !strings.Contains(cmd, "go test") || !strings.Contains(cmd, "-race") {
		return "", ""
	}
	if strings.Contains(cmd, "-count") {
		return "", "" // already has -count flag
	}
	corrected := strings.Replace(cmd, "-race", "-race -count=1", 1)
	return corrected, "[alfred] Added -count=1 to disable test caching with -race"
}


// narrowTestScope replaces go test ./... with specific changed packages.
func narrowTestScope(sdb *sessiondb.SessionDB, cmd, cwd string) (string, string) {
	if !strings.Contains(cmd, "./...") || !strings.Contains(cmd, "go test") {
		return "", ""
	}

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return "", ""
	}

	pkgSet := make(map[string]bool)
	for _, f := range files {
		if !strings.HasSuffix(f, ".go") {
			continue
		}
		dir := filepath.Dir(f)
		rel, err := filepath.Rel(cwd, dir)
		if err != nil {
			continue
		}
		if rel == "." {
			pkgSet["."] = true
		} else {
			pkgSet["./"+rel+"/..."] = true
		}
	}

	if len(pkgSet) == 0 || len(pkgSet) > 5 {
		return "", ""
	}

	pkgs := make([]string, 0, len(pkgSet))
	for p := range pkgSet {
		pkgs = append(pkgs, p)
	}
	sort.Strings(pkgs)

	narrowed := strings.Replace(cmd, "./...", strings.Join(pkgs, " "), 1)
	return narrowed, "[alfred] Narrowed test scope to changed packages: " + strings.Join(pkgs, ", ")
}

// scopeGitAdd replaces git add . with specific working set files.
func scopeGitAdd(sdb *sessiondb.SessionDB, cmd, cwd string) (string, string) {
	trimmed := strings.TrimSpace(cmd)

	var prefix string
	var rest string
	for _, pattern := range []string{"git add --all", "git add -A", "git add ."} {
		if strings.HasPrefix(trimmed, pattern) {
			prefix = pattern
			rest = trimmed[len(pattern):]
			break
		}
	}
	if prefix == "" {
		return "", ""
	}

	// Ensure the pattern is followed by end-of-string or a command separator.
	if rest != "" && rest[0] != ' ' && rest[0] != '&' && rest[0] != ';' && rest[0] != '|' {
		return "", ""
	}

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 || len(files) > 20 {
		return "", ""
	}

	relFiles := make([]string, 0, len(files))
	for _, f := range files {
		rel, err := filepath.Rel(cwd, f)
		if err != nil {
			rel = f
		}
		if strings.ContainsAny(rel, " '\"") {
			rel = fmt.Sprintf("%q", rel)
		}
		relFiles = append(relFiles, rel)
	}

	narrowed := "git add " + strings.Join(relFiles, " ") + rest
	return narrowed, fmt.Sprintf("[alfred] Scoped git add to %d tracked working set files", len(relFiles))
}

// containsAny returns true if s contains any of the substrings.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

