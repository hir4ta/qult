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

	// Silent auto-correction: improve tool inputs before execution.
	if out := autoCorrectTool(sdb, in.ToolName, in.ToolInput, in.CWD); out != nil {
		return out, nil
	}

	// Auto-apply high-confidence code fixes (>=0.9) on Edit for Go files.
	if out := autoApplyCodeFix(sdb, in.ToolName, in.ToolInput); out != nil {
		return out, nil
	}

	// Episode early-warning: detect emerging anti-patterns BEFORE tool execution.
	// retry_cascade and edit_fail_spiral are blocked (deny); others are advisory.
	det := &HookDetector{sdb: sdb}
	if sig := det.detectEpisodes(); sig != nil {
		switch sig.Name {
		case "retry_cascade", "edit_fail_spiral":
			return makeDenyOutput(sig.Message), nil
		default:
			return makeOutput("PreToolUse", sig.Message), nil
		}
	}

	// Velocity wall look-ahead: warn when velocity variance is high and health declining.
	// Gated by ewmv_velocity_var > 4.0 to avoid unnecessary PredictHealthTrend calls (~4ms).
	if ewmvVar := getFloat(sdb, "ewmv_velocity_var"); ewmvVar > 4.0 {
		if trend := PredictHealthTrend(sdb); trend != nil && trend.Trend == "declining" && trend.ToolsToThreshold > 0 && trend.ToolsToThreshold < 30 {
			set, _ := sdb.TrySetCooldown("velocity_wall_warn", 10*time.Minute)
			if set {
				return makeOutput("PreToolUse", fmt.Sprintf(
					"[buddy] Signal: Velocity variance high (%.1f). Health declining — ~%d tool calls until threshold. Consider pausing to reassess approach.",
					ewmvVar, trend.ToolsToThreshold)), nil
			}
		}
	}

	// --- JARVIS advisor: present alternatives before action ---
	var signals []string
	if safetyWarning != "" {
		signals = append(signals, safetyWarning)
	}

	if alts := presentAlternatives(sdb, in.ToolName, in.ToolInput); alts != "" {
		signals = append(signals, alts)
	}

	// Pre-action coaching: risk-aware guidance before specific tool invocations.
	var inputMap map[string]any
	_ = json.Unmarshal(in.ToolInput, &inputMap)
	if coaching := preActionCoaching(sdb, in.ToolName, inputMap); coaching != "" {
		signals = append(signals, coaching)
	}

	// Suggest dedicated tools when CLI equivalents used in Bash.
	if in.ToolName == "Bash" {
		on, _ := sdb.IsOnCooldown("cli_tool_hint")
		if !on {
			if hint := suggestDedicatedTool(in.ToolInput); hint != "" {
				_ = sdb.SetCooldown("cli_tool_hint", 30*time.Minute)
				signals = append(signals, hint)
			}
		}
	}

	// High-failure-rate gate: ask user for confirmation on Edit/Write when
	// the tool+file combination has historically high failure probability.
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		var fi struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &fi) == nil && fi.FilePath != "" {
			prob, total, _ := sdb.FailureProbability(in.ToolName, fi.FilePath)
			if prob >= 0.8 && total >= 5 {
				reason := fmt.Sprintf("[buddy] High failure rate (%.0f%% over %d attempts) for %s on %s. Consider reading the file first to verify current content.",
					prob*100, total, in.ToolName, filepath.Base(fi.FilePath))
				return makeAskOutput(reason), nil
			}
		}
	}

	// Impact preview for Edit/Write (shows importers, test files).
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		var ei struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ei) == nil && ei.FilePath != "" {
			impactKey := "impact:" + filepath.Base(ei.FilePath)
			on, _ := sdb.IsOnCooldown(impactKey)
			if !on {
				if info := analyzeImpact(sdb, ei.FilePath, in.CWD); info != nil {
					if text := formatImpact(info); text != "" {
						_ = sdb.SetCooldown(impactKey, 15*time.Minute)
						signals = append(signals, fmt.Sprintf("[buddy] Impact: %s", text))
					}
				}
			}
		}
	}

	// Co-change hint: suggest frequently co-changed files when editing.
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		var ci struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ci) == nil && ci.FilePath != "" {
			coKey := "cochange:" + filepath.Base(ci.FilePath)
			on, _ := sdb.IsOnCooldown(coKey)
			if !on {
				if hint := coChangeHint(ci.FilePath); hint != "" {
					_ = sdb.SetCooldown(coKey, 15*time.Minute)
					signals = append(signals, hint)
				}
			}
		}
	}

	// Proactive solution lookup: surface past resolution playbooks before action.
	if in.ToolName == "Edit" || in.ToolName == "Write" || in.ToolName == "Bash" {
		if hint := proactiveSolutionLookup(sdb, in.ToolName, in.ToolInput); hint != "" {
			signals = append(signals, hint)
		}
	}

	// Pattern-based contextual guidance: search for relevant patterns
	// using FTS5 when intent + tool context are available.
	if sig := buildContextQuery(sdb, in.ToolName, in.ToolInput); sig != "" {
		ctxKey := "pattern-ctx:" + sig
		on, _ := sdb.IsOnCooldown(ctxKey)
		if !on {
			if ctx := searchContextualPatterns(sig); ctx != "" {
				_ = sdb.SetCooldown(ctxKey, 10*time.Minute)
				signals = append(signals, ctx)
			}
		}
	}

	// Domain-aware risk warnings for high-risk operations.
	if domain, _ := sdb.GetWorkingSet("domain"); domain != "" && domain != "general" {
		if risk := domainRiskCheck(sdb, domain, in.ToolName, in.ToolInput); risk != "" {
			signals = append(signals, risk)
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

	return makeOutput("PreToolUse", budgetJoin(parts, 2000)), nil
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
	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

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

// autoApplyCodeFix runs high-confidence Go code fixers on Edit operations.
// Only applies fixes with confidence >= 0.9 (nil-error-wrap, defer-in-loop).
// Lower-confidence fixes (empty-error-return 0.85, error-shadow 0.7) are excluded.
func autoApplyCodeFix(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) *HookOutput {
	if toolName != "Edit" {
		return nil
	}

	var edit struct {
		FilePath   string `json:"file_path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all,omitempty"`
	}
	if json.Unmarshal(toolInput, &edit) != nil || edit.FilePath == "" {
		return nil
	}
	if filepath.Ext(edit.FilePath) != ".go" || strings.HasSuffix(edit.FilePath, "_test.go") {
		return nil
	}

	// Read file and simulate the edit result for AST analysis.
	content, err := os.ReadFile(edit.FilePath)
	if err != nil {
		return nil
	}
	simulated := strings.Replace(string(content), edit.OldString, edit.NewString, 1)

	// Run high-confidence fixers on simulated content.
	fixer := &goFixer{}
	fixedNew := edit.NewString
	var fixes []string

	for _, check := range []struct {
		rule    string
		message string
	}{
		{"go_nil_error_wrap", "wrapping nil"},
		{"go_defer_in_loop", "defer` inside loop"},
	} {
		finding := Finding{File: edit.FilePath, Rule: check.rule, Message: check.message}
		fix := fixer.Fix(finding, []byte(simulated))
		if fix == nil || fix.Confidence < 0.9 {
			continue
		}
		// Only apply if the fix's Before is within the new_string region.
		if !strings.Contains(fixedNew, fix.Before) {
			continue
		}
		fixedNew = strings.Replace(fixedNew, fix.Before, fix.After, 1)
		fixes = append(fixes, check.rule)
	}

	if len(fixes) == 0 {
		return nil
	}

	// Track auto-fix for revert detection in subsequent edits.
	_ = sdb.SetContext("last_auto_fix_pattern", strings.Join(fixes, ","))
	_ = sdb.SetContext("last_auto_fix_file", edit.FilePath)

	updated, _ := json.Marshal(struct {
		FilePath   string `json:"file_path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all,omitempty"`
	}{edit.FilePath, edit.OldString, fixedNew, edit.ReplaceAll})
	return makeUpdatedInputOutput(updated,
		fmt.Sprintf("[buddy] Auto-applied code fix: %s", strings.Join(fixes, ", ")))
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

// proactiveSolutionLookup searches past failure resolutions for the target file
// and surfaces them as context before the action is taken.
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

	// Check if this file has an unresolved failure in the current session.
	unresolved, failureType, errorSig, _ := sdb.UnresolvedFailureDetail(filePath)
	if !unresolved {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	// Search for past solutions with resolution diffs (most actionable).
	solutions, _ := st.SearchFailureSolutionsWithDiff(failureType, errorSig, 1)
	if len(solutions) == 0 {
		// Fall back to file-specific solutions.
		solutions, _ = st.SearchFailureSolutionsByFile(filePath, 1)
	}
	if len(solutions) == 0 {
		return ""
	}

	_ = sdb.SetCooldown(cooldownKey, 10*time.Minute)

	sol := solutions[0]
	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Past resolution for %s (%s)", filepath.Base(filePath), failureType)

	// Parse and display the exact resolution diff when available.
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

	// Search for solution chains (multi-step playbooks) for this failure.
	chainSig := failureType + ":" + errorSig
	chains, _ := st.SearchSolutionChains(chainSig, 1)
	if len(chains) > 0 {
		fmt.Fprintf(&b, "\n→ Playbook (%d steps): %s", chains[0].StepCount, chains[0].ToolSequence)
	} else if !diffShown {
		// Fall back to solution text when neither diff nor chain is available.
		text := sol.SolutionText
		if len([]rune(text)) > 150 {
			text = string([]rune(text)[:150]) + "..."
		}
		b.WriteString("\n→ ")
		b.WriteString(text)
	}

	// Track surfaced solution for effectiveness measurement.
	_ = sdb.SetContext("last_surfaced_solution_id", fmt.Sprintf("%d", sol.ID))

	return b.String()
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

// budgetJoin joins parts with newline separator, respecting a character budget.
// Earlier entries have higher priority (signals are ordered by importance).
func budgetJoin(parts []string, budget int) string {
	var b strings.Builder
	for i, p := range parts {
		needed := len(p)
		if i > 0 {
			needed++ // newline separator
		}
		if b.Len()+needed > budget {
			break
		}
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(p)
	}
	return b.String()
}
