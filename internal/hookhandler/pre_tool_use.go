package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
		fmt.Fprintf(os.Stderr, "[buddy] PreToolUse: open session db: %v\n", err)
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
	// (buddy_guidance, buddy_knowledge, buddy_diagnose).
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

// buildContextQuery builds a search query string from tool context.
// Combines session intent with file/command keywords for targeted pattern search.
func buildContextQuery(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) string {
	intent, _ := sdb.GetWorkingSet("intent")

	var fileKeyword string
	switch toolName {
	case "Edit", "Write", "Read":
		var fi struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(toolInput, &fi) == nil && fi.FilePath != "" {
			fileKeyword = filepath.Base(fi.FilePath)
		}
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && bi.Command != "" {
			fileKeyword = extractCmdSignature(bi.Command)
		}
	}

	parts := make([]string, 0, 2)
	if intent != "" {
		// Take first few words of intent to avoid overly broad queries.
		words := strings.Fields(intent)
		if len(words) > 5 {
			words = words[:5]
		}
		parts = append(parts, strings.Join(words, " "))
	}
	if fileKeyword != "" {
		parts = append(parts, fileKeyword)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " ")
}

// searchContextualPatterns searches for relevant patterns using FTS5 with
// keyword fallback and formats them as a concise context string.
func searchContextualPatterns(query string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	// Try FTS5 first, then keyword fallback.
	results, _ := st.SearchPatternsByFTS(query, "", 2)
	if len(results) == 0 {
		results, _ = st.SearchPatternsByKeyword(query, "", 2)
	}
	if len(results) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("[buddy] Relevant context:")
	for _, p := range results {
		text := p.Content
		if len([]rune(text)) > 100 {
			text = string([]rune(text)[:100]) + "..."
		}
		fmt.Fprintf(&b, "\n  - [%s] %s", p.PatternType, text)
	}
	return b.String()
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
	return corrected, "[buddy] Replaced --force with --force-with-lease to prevent overwriting others' work"
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
	return corrected, "[buddy] Added -count=1 to disable test caching with -race"
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
	return narrowed, "[buddy] Narrowed test scope to changed packages: " + strings.Join(pkgs, ", ")
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
	return narrowed, fmt.Sprintf("[buddy] Scoped git add to %d tracked working set files", len(relFiles))
}

var cliToolPattern = regexp.MustCompile(`\b(grep|rg|find)\s`)

// suggestDedicatedTool hints when Bash is used for operations with dedicated tools.
func suggestDedicatedTool(toolInput json.RawMessage) string {
	var bi struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(toolInput, &bi) != nil || bi.Command == "" {
		return ""
	}
	if !cliToolPattern.MatchString(bi.Command) {
		return ""
	}
	return "[buddy] Consider using dedicated Grep/Glob tools instead of CLI grep/rg/find for better integration"
}

// proactiveSolutionLookup searches past failure resolutions using a 3-axis
// priority search and surfaces them as context before the action is taken.
// Axes (in priority order): error_signature → file_path → failure_type.
func proactiveSolutionLookup(sdb *sessiondb.SessionDB, _ string, toolInput json.RawMessage) string {
	filePath := extractFilePath(toolInput)
	if filePath == "" {
		return ""
	}

	cooldownKey := "solution_lookup:" + filepath.Base(filePath)
	on, _ := sdb.IsOnCooldown(cooldownKey)
	if on {
		return ""
	}

	unresolved, failureType, errorSig, _ := sdb.UnresolvedFailureDetail(filePath)
	if !unresolved {
		return ""
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	// 3-axis search in priority order: error_signature (highest precision) →
	// file_path (file-specific) → failure_type (broadest match).
	var solutions []store.FailureSolution

	// Axis 1: error_signature exact match (with optional failureType filter).
	if errorSig != "" {
		solutions, _ = st.SearchFailureSolutionsWithDiff(failureType, errorSig, 1)
	}

	// Axis 2: file_path specific solutions.
	if len(solutions) == 0 {
		solutions, _ = st.SearchFailureSolutionsByFile(filePath, 1)
	}

	// Axis 3: failure_type broadest match.
	if len(solutions) == 0 {
		solutions, _ = st.SearchFailureSolutionsByType(failureType, 1)
	}

	if len(solutions) == 0 {
		return ""
	}

	_ = sdb.SetCooldown(cooldownKey, 10*time.Minute)

	sol := solutions[0]

	// Track surfacing: increment times_surfaced counter.
	_ = st.IncrementTimesSurfaced(sol.ID)

	// Track via suggestion outcome for effectiveness measurement.
	patternKey := "past-solution:" + filepath.Base(filePath)
	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}
	outcomeID, _ := st.InsertSuggestionOutcome(sessionID, patternKey, sol.SolutionText)
	if outcomeID > 0 {
		_ = sdb.SetContext("last_nudge_outcome_id", fmt.Sprintf("%d", outcomeID))
		_ = sdb.SetContext("last_nudge_pattern", "past-solution")
	}

	_ = sdb.SetContext("last_surfaced_solution_id", fmt.Sprintf("%d", sol.ID))

	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Past resolution for %s (%s)", filepath.Base(filePath), failureType)

	diffShown := false
	if sol.ResolutionDiff != "" {
		var diff struct {
			Old string `json:"old"`
			New string `json:"new"`
		}
		if json.Unmarshal([]byte(sol.ResolutionDiff), &diff) == nil && diff.Old != "" {
			old := truncate(diff.Old, 60)
			new_ := truncate(diff.New, 60)
			fmt.Fprintf(&b, "\n→ Previous fix: `%s` → `%s`", old, new_)
			diffShown = true
		}
	}

	chainSig := failureType + ":" + errorSig
	chains, _ := st.SearchSolutionChains(chainSig, 1)
	if len(chains) > 0 {
		fmt.Fprintf(&b, "\n→ Playbook (%d steps): %s", chains[0].StepCount, chains[0].ToolSequence)
	} else if !diffShown {
		text := sol.SolutionText
		if len([]rune(text)) > 150 {
			text = string([]rune(text)[:150]) + "..."
		}
		b.WriteString("\n→ ")
		b.WriteString(text)
	}

	return b.String() + SkillHintForPattern("past-solution")
}

// domainRiskCheck returns a domain-specific risk warning for high-risk operations.
// Only fires for combinations where the domain + action is genuinely risky.
func domainRiskCheck(sdb *sessiondb.SessionDB, domain, toolName string, toolInput json.RawMessage) string {
	cooldownKey := "domain_risk:" + domain + ":" + toolName
	on, _ := sdb.IsOnCooldown(cooldownKey)
	if on {
		return ""
	}

	filePath := extractFilePath(toolInput)
	baseName := strings.ToLower(filepath.Base(filePath))

	var warning string

	switch domain {
	case "auth":
		if (toolName == "Edit" || toolName == "Write") && filePath != "" {
			if containsAny(baseName, "password", "secret", "credential", "token", "key", "auth") {
				warning = "[buddy] domain-risk (auth): Editing security-sensitive file. Verify no credentials are hardcoded and secrets use environment variables.\n  WHY: Auth file changes can expose credentials or break authentication for all users."
			}
		}
	case "database":
		if toolName == "Bash" {
			var bi struct {
				Command string `json:"command"`
			}
			if json.Unmarshal(toolInput, &bi) == nil {
				cmd := strings.ToLower(bi.Command)
				if containsAny(cmd, "migrate", "drop", "alter table", "truncate", "delete from") {
					warning = "[buddy] domain-risk (database): Running a schema-modifying or destructive database command. Ensure you have a backup or rollback plan.\n  WHY: Database schema changes are often irreversible in production. Verify on a test database first."
				}
			}
		}
	case "infra":
		if (toolName == "Edit" || toolName == "Write") && filePath != "" {
			ext := strings.ToLower(filepath.Ext(filePath))
			if ext == ".yml" || ext == ".yaml" || baseName == "dockerfile" || strings.HasSuffix(baseName, ".tf") {
				warning = "[buddy] domain-risk (infra): Editing infrastructure configuration. Changes may affect deployment pipelines or production services.\n  WHY: Infrastructure misconfigurations can cause outages. Review the change scope and test in a staging environment."
			}
		}
	case "api":
		if (toolName == "Edit" || toolName == "Write") && filePath != "" {
			if containsAny(baseName, "route", "handler", "endpoint", "middleware", "controller") {
				warning = "[buddy] domain-risk (api): Editing an API endpoint handler. Consider backward compatibility for existing clients.\n  WHY: Breaking API contracts affects all downstream consumers. Check if the endpoint is versioned."
			}
		}
	}

	if warning == "" {
		return ""
	}

	_ = sdb.SetCooldown(cooldownKey, 15*time.Minute)
	return warning
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

