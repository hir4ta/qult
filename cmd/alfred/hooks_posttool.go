package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// handlePostToolUse fires after a tool executes.
// Two responsibilities:
//  1. On Bash failure: search memory for similar errors and inject solutions.
//  2. On Bash success: check if the command completes a Next Steps item in session.md.
func handlePostToolUse(ctx context.Context, ev *hookEvent) {
	if ev.ToolName != "Bash" {
		return
	}

	// Parse tool_input to get the command.
	var input struct {
		Command string `json:"command"`
	}
	_ = json.Unmarshal(ev.ToolInput, &input) // best-effort

	// Parse tool_response to check for errors.
	var resp struct {
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
		ExitCode int    `json:"exitCode"`
	}
	if err := json.Unmarshal(ev.ToolResponse, &resp); err != nil {
		return
	}

	// On success: try to auto-check Next Steps + warn if all done but task still active.
	if resp.ExitCode == 0 {
		tryAutoCheckNextSteps(ctx, ev.ProjectPath, input.Command, resp.Stdout)
		warnIfAllStepsDoneButActive(ev.ProjectPath)
		tryDetectSpecDrift(ctx, ev.ProjectPath, input.Command)
		return
	}

	// Extract error keywords from stderr (or stdout if stderr is empty).
	errorText := resp.Stderr
	if errorText == "" {
		errorText = resp.Stdout
	}
	if len(errorText) > 2000 {
		errorText = errorText[:2000]
	}

	keywords := extractErrorKeywords(errorText)
	if len(keywords) == 0 {
		return
	}

	// Search memory for related past errors.
	query := strings.Join(keywords, " ")
	st, err := openStore()
	if err != nil {
		return
	}

	docs, err := st.SearchMemoriesFTS(ctx, query, 2)
	if err != nil || len(docs) == 0 {
		return
	}

	var buf strings.Builder
	buf.WriteString("Related past experience for this error:\n")
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 300)
		buf.WriteString(fmt.Sprintf("- [%s] %s\n", d.SectionPath, snippet))
	}

	emitAdditionalContext("PostToolUse", buf.String())
}

// warnIfAllStepsDoneButActive checks if all Next Steps are completed
// but the task is still active, and emits a reminder to call dossier complete.
func warnIfAllStepsDoneButActive(projectPath string) {
	if projectPath == "" {
		return
	}
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return
	}
	state, err := spec.ReadActiveState(projectPath)
	if err != nil {
		return
	}
	// Check if the task is still active.
	for _, t := range state.Tasks {
		if t.Slug == taskSlug && !t.IsActive() {
			return // already completed
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		return
	}
	nextSteps := extractSection(session, "## Next Steps")
	if nextSteps == "" {
		return
	}
	if !allNextStepsCompleted(nextSteps) {
		return
	}
	// All steps done but task is still active — emit warning.
	emitAdditionalContext("PostToolUse",
		fmt.Sprintf("WARNING: All Next Steps for '%s' are completed but the task is still active.\n"+
			"Please call `dossier action=complete task_slug=%s` to close the task, "+
			"or update session.md if there are remaining steps.", taskSlug, taskSlug))
}

// extractErrorKeywords pulls meaningful terms from error output.
// Looks for common error patterns: package names, function names, error types.
func extractErrorKeywords(text string) []string {
	// Take first 5 lines of error (most relevant).
	lines := strings.Split(text, "\n")
	if len(lines) > 5 {
		lines = lines[:5]
	}

	seen := make(map[string]bool)
	var keywords []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Extract words that look meaningful (4+ chars, not common noise).
		for _, word := range strings.Fields(line) {
			// Clean punctuation.
			word = strings.Trim(word, ".:;,()[]{}\"'`")
			lower := strings.ToLower(word)
			if len(lower) < 4 || isNoiseWord(lower) || seen[lower] {
				continue
			}
			seen[lower] = true
			keywords = append(keywords, lower)
			if len(keywords) >= 8 {
				return keywords
			}
		}
	}
	return keywords
}

// isNoiseWord returns true for common words that don't help search.
func isNoiseWord(w string) bool {
	noise := map[string]bool{
		"error": true, "fatal": true, "failed": true, "cannot": true,
		"could": true, "would": true, "should": true, "that": true,
		"this": true, "with": true, "from": true, "have": true,
		"line": true, "file": true, "exit": true, "code": true,
		"status": true, "expected": true, "unexpected": true,
	}
	return noise[w]
}

// actionSignals maps command patterns to completion signal words.
// When a Bash command matches a pattern, its signal words are used
// to match against Next Steps items.
var actionSignals = []struct {
	cmdContains string   // substring to match in the command
	signals     []string // words that indicate what was accomplished
}{
	{"git commit", []string{"commit", "コミット"}},
	{"git push", []string{"push", "プッシュ"}},
	{"go test", []string{"test", "テスト"}},
	{"go vet", []string{"vet", "lint", "静的解析"}},
	{"go install", []string{"install", "build", "ビルド", "インストール"}},
	{"go build", []string{"build", "ビルド"}},
	{"npm test", []string{"test", "テスト"}},
	{"npm run build", []string{"build", "ビルド"}},
	{"gh pr create", []string{"pr", "pull request", "プルリクエスト"}},
}

// tryAutoCheckNextSteps checks if a successful Bash command completes
// any Next Steps item in session.md and marks it as done.
func tryAutoCheckNextSteps(ctx context.Context, projectPath, command, stdout string) {
	if projectPath == "" || command == "" {
		return
	}

	// Read active task's session.md.
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return
	}
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		return
	}

	nextSteps := extractSection(session, "## Next Steps")
	if nextSteps == "" || !strings.Contains(nextSteps, "- [ ] ") {
		return
	}

	// Build context text from command + stdout + action signals.
	cmdLower := strings.ToLower(command)
	var contextBuf strings.Builder
	contextBuf.WriteString(cmdLower)
	contextBuf.WriteByte(' ')

	// Add action-specific signal words.
	for _, sig := range actionSignals {
		if strings.Contains(cmdLower, sig.cmdContains) {
			for _, s := range sig.signals {
				contextBuf.WriteString(s)
				contextBuf.WriteByte(' ')
			}
		}
	}

	// Add first 500 chars of stdout (may contain useful context like commit messages).
	if len(stdout) > 500 {
		stdout = stdout[:500]
	}
	contextBuf.WriteString(strings.ToLower(stdout))
	contextText := contextBuf.String()

	// Check each unchecked item against the context.
	lines := strings.Split(nextSteps, "\n")
	updated := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "- [ ] ") {
			continue
		}
		itemText := strings.TrimPrefix(trimmed, "- [ ] ")
		if isStepMatchedByAction(itemText, contextText) {
			lines[i] = strings.Replace(line, "- [ ] ", "- [x] ", 1)
			updated = true
		}
	}

	if !updated {
		return
	}

	// Write updated session.md with synced sections.
	updatedNextSteps := strings.Join(lines, "\n")
	updatedSession := replaceSection(session, "## Next Steps", updatedNextSteps)
	updatedSession = syncSessionProgress(updatedSession)
	if err := sd.WriteFile(ctx, spec.FileSession, updatedSession); err != nil {
		return
	}

	// Check if all steps are now done → auto-complete task.
	if allNextStepsCompleted(updatedNextSteps) {
		autoCompleteTask(projectPath, taskSlug, updatedSession)
	}
}

// stepTokenDelimiters splits on whitespace and common delimiters
// (including full-width Japanese punctuation) for better tokenization.
var stepTokenDelimiters = strings.NewReplacer(
	"（", " ", "）", " ", "＆", " ", "、", " ",
	"(", " ", ")", " ", "&", " ", "/", " ",
	"—", " ", ":", " ", "：", " ",
)

// isStepMatchedByAction checks if a Next Steps item text matches
// the action context (command + signals + stdout).
// Splits on whitespace + delimiters, requires 50%+ of 3+ rune tokens to match.
func isStepMatchedByAction(itemText, contextText string) bool {
	normalized := stepTokenDelimiters.Replace(strings.ToLower(itemText))
	var tokens []string
	for _, w := range strings.Fields(normalized) {
		if len([]rune(w)) >= 3 {
			tokens = append(tokens, w)
		}
	}
	if len(tokens) == 0 {
		return false
	}
	hits := 0
	for _, w := range tokens {
		if strings.Contains(contextText, w) {
			hits++
		}
	}
	return float64(hits)/float64(len(tokens)) >= 0.5
}

// syncSessionProgress moves checked items from Next Steps to Completed Steps
// and updates "Currently Working On" to reflect the next unchecked step.
// This keeps the dashboard accurate without relying on the AI to manually update.
func syncSessionProgress(session string) string {
	nextSteps := extractSection(session, "## Next Steps")
	if nextSteps == "" {
		return session
	}

	var checked, unchecked []string
	for _, line := range strings.Split(nextSteps, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			checked = append(checked, trimmed)
		} else if strings.HasPrefix(trimmed, "- [ ] ") {
			unchecked = append(unchecked, trimmed)
		} else if trimmed != "" && !strings.HasPrefix(trimmed, "<!--") {
			unchecked = append(unchecked, trimmed) // preserve non-checkbox lines
		}
	}

	if len(checked) == 0 {
		return session
	}

	// Move checked items to Completed Steps.
	existingCompleted := extractSectionFallback(session, "## Completed Steps", "## Completed")
	var completedBuf strings.Builder
	if existingCompleted != "" {
		completedBuf.WriteString(existingCompleted)
		completedBuf.WriteByte('\n')
	}
	for _, item := range checked {
		// Avoid duplicates.
		if existingCompleted == "" || !strings.Contains(existingCompleted, item) {
			completedBuf.WriteString(item)
			completedBuf.WriteByte('\n')
		}
	}

	// Update Completed Steps section (try both names).
	updated := session
	completedBody := completedBuf.String()
	if strings.Contains(session, "## Completed Steps") {
		updated = replaceSection(updated, "## Completed Steps", completedBody)
	} else if strings.Contains(session, "## Completed") {
		updated = replaceSection(updated, "## Completed", completedBody)
	} else {
		// Insert Completed Steps section before Next Steps.
		updated = strings.Replace(updated,
			"## Next Steps",
			"## Completed Steps\n"+completedBody+"\n## Next Steps",
			1)
	}

	// Replace Next Steps with only unchecked items.
	var nextBuf strings.Builder
	for _, item := range unchecked {
		nextBuf.WriteString(item)
		nextBuf.WriteByte('\n')
	}
	updated = replaceSection(updated, "## Next Steps", nextBuf.String())

	// Update "Currently Working On" to the first unchecked step.
	if len(unchecked) > 0 {
		first := strings.TrimSpace(unchecked[0])
		first = strings.TrimPrefix(first, "- [ ] ")
		// Strip task ID prefix like "T-1.1 [S] " to get just the description.
		updated = replaceSection(updated, "## Currently Working On", first+"\n")
	} else {
		updated = replaceSection(updated, "## Currently Working On", "All steps completed\n")
	}

	return updated
}

// replaceSection replaces the content under a ## heading with new content.
func replaceSection(content, heading, newBody string) string {
	lines := strings.Split(content, "\n")
	var result []string
	inSection := false
	replaced := false
	for _, line := range lines {
		if line == heading || strings.HasPrefix(line, heading+" ") {
			inSection = true
			result = append(result, line)
			result = append(result, newBody)
			replaced = true
			continue
		}
		if inSection {
			if strings.HasPrefix(line, "## ") {
				inSection = false
				result = append(result, line)
			}
			// Skip old content in section.
			continue
		}
		result = append(result, line)
	}
	if !replaced {
		return content
	}
	return strings.Join(result, "\n")
}

// ---------------------------------------------------------------------------
// Spec drift detection (PostToolUse — after successful git commit)
// ---------------------------------------------------------------------------

// driftActionSpec is the audit action for spec file drift.
const driftActionSpec = "drift.spec"

// driftActionConvention is the audit action for convention drift.
const driftActionConvention = "drift.convention"

// driftResolutionUnresolved is the default resolution status for drift events.
const driftResolutionUnresolved = "unresolved"

// tryDetectSpecDrift runs after a successful git commit command.
// Compares changed files against the active spec's file references and
// emits additionalContext warnings for untracked files or modified components.
func tryDetectSpecDrift(ctx context.Context, projectPath, command string) {
	if projectPath == "" || command == "" {
		return
	}

	cmdLower := strings.ToLower(command)
	if !strings.Contains(cmdLower, "git commit") {
		return
	}

	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return // no active task — skip silently
	}

	changed := extractChangedFiles(ctx, projectPath)
	if len(changed) == 0 {
		return
	}

	specRefs := parseSpecFileRefs(projectPath, taskSlug)
	if len(specRefs) == 0 {
		return // no file references in spec — nothing to compare
	}

	// Read tasks.md for reverse FR mapping.
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	tasksContent, _ := sd.ReadFile(spec.FileTasks) // best-effort

	var untracked []string
	var modifiedComponents []string

	for _, f := range changed {
		component, inSpec := specRefs[f]
		if !inSpec {
			// Check if the file's package matches a component.
			if comp := matchComponentByPackage(f, specRefs); comp != "" {
				modifiedComponents = append(modifiedComponents, comp)
			} else {
				untracked = append(untracked, f)
			}
		} else if component != "" {
			modifiedComponents = append(modifiedComponents, component)
		}
	}

	if len(untracked) == 0 && len(modifiedComponents) == 0 {
		return
	}

	var buf strings.Builder
	if len(untracked) > 0 {
		buf.WriteString("SPEC DRIFT: The following changed files are not referenced in the active spec:\n")
		for _, f := range untracked {
			severity := classifyDriftSeverity(f, false)
			frHint := ""
			if frs := reverseMapFileToFR(f, tasksContent); len(frs) > 0 {
				frHint = fmt.Sprintf(" (related: %s)", strings.Join(frs, ", "))
			}
			buf.WriteString(fmt.Sprintf("  - %s [%s]%s\n", f, severity, frHint))
		}
		buf.WriteString("Consider updating design.md or tasks.md to include these files.\n")

		// Log drift event.
		logDriftEvent(projectPath, driftActionSpec, taskSlug, map[string]any{
			"type":       "spec-drift",
			"severity":   highestSeverity(untracked, false),
			"files":      untracked,
			"spec_task":  taskSlug,
			"resolution": driftResolutionUnresolved,
		})
	}

	if len(modifiedComponents) > 0 {
		buf.WriteString("SPEC UPDATE SUGGESTED: The following spec components were modified:\n")
		seen := make(map[string]bool)
		for _, c := range modifiedComponents {
			if seen[c] {
				continue
			}
			seen[c] = true
			buf.WriteString(fmt.Sprintf("  - %s — consider updating design.md\n", c))
		}

		logDriftEvent(projectPath, driftActionSpec, taskSlug, map[string]any{
			"type":                "spec-drift",
			"severity":            "critical",
			"components_affected": uniqueStrings(modifiedComponents),
			"spec_task":           taskSlug,
			"resolution":          driftResolutionUnresolved,
		})
	}

	emitAdditionalContext("PostToolUse", buf.String())
}

// extractChangedFiles runs `git diff --name-only HEAD~1` with a 500ms timeout.
// Returns nil on error (fail-open). Handles merge commits by using HEAD^..HEAD.
func extractChangedFiles(ctx context.Context, projectPath string) []string {
	ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()

	// First try HEAD~1 (regular commits).
	out, err := runGitDiff(ctx, projectPath, "HEAD~1")
	if err != nil {
		// May be a merge commit or initial commit — try HEAD^ as fallback.
		out, err = runGitDiff(ctx, projectPath, "HEAD^")
		if err != nil {
			return nil // fail-open
		}
	}

	var files []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files
}

// runGitDiff executes git diff --name-only against a ref.
func runGitDiff(ctx context.Context, projectPath, ref string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "diff", "--name-only", ref)
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// specFileRefRe matches "**File**: path" or "**File:** path" in design.md.
var specFileRefRe = regexp.MustCompile(`\*\*File\*?\*?:\s*` + "`?" + `([^` + "`" + `\n]+)` + "`?")

// taskFilesRefRe matches "Files: path1, path2" in tasks.md.
var taskFilesRefRe = regexp.MustCompile(`(?i)Files?:\s*(.+)`)

// parseSpecFileRefs reads design.md and tasks.md to extract referenced file paths.
// Returns map[string]string: filePath → componentName (empty string for tasks.md refs).
func parseSpecFileRefs(projectPath, taskSlug string) map[string]string {
	refs := make(map[string]string)
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	// Parse design.md for component file references.
	if design, err := sd.ReadFile(spec.FileDesign); err == nil {
		parseDesignFileRefs(design, refs)
	}

	// Parse tasks.md for file references.
	if tasks, err := sd.ReadFile(spec.FileTasks); err == nil {
		parseTasksFileRefs(tasks, refs)
	}

	return refs
}

// componentNameRe matches "### Component: Name" headers in design.md.
var componentNameRe = regexp.MustCompile(`(?m)^###\s+Component:\s*(.+)`)

// parseDesignFileRefs extracts file references from design.md content.
// Associates each file with its component name.
func parseDesignFileRefs(content string, refs map[string]string) {
	lines := strings.Split(content, "\n")
	currentComponent := ""

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Track current component.
		if m := componentNameRe.FindStringSubmatch(trimmed); len(m) > 1 {
			currentComponent = strings.TrimSpace(m[1])
			continue
		}

		// Match file references.
		if m := specFileRefRe.FindStringSubmatch(trimmed); len(m) > 1 {
			path := strings.TrimSpace(m[1])
			path = strings.Trim(path, "`")
			if path != "" {
				refs[path] = currentComponent
			}
		}
	}
}

// parseTasksFileRefs extracts file references from tasks.md content.
func parseTasksFileRefs(content string, refs map[string]string) {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)

		// Match "_Requirements: ... | Files: path1, path2_" pattern.
		if !strings.Contains(trimmed, "Files:") && !strings.Contains(trimmed, "files:") {
			continue
		}
		if m := taskFilesRefRe.FindStringSubmatch(trimmed); len(m) > 1 {
			filesStr := strings.TrimSuffix(strings.TrimSpace(m[1]), "_")
			for _, f := range strings.Split(filesStr, ",") {
				f = strings.TrimSpace(f)
				f = strings.Trim(f, "`")
				if f != "" && !strings.Contains(f, " ") {
					if _, exists := refs[f]; !exists {
						refs[f] = "" // no component association for tasks.md refs
					}
				}
			}
		}
	}
}

// classifyDriftSeverity returns "info", "warning", or "critical" based on file type.
// Test files are info, source files not in spec are warning,
// core component modifications are critical.
func classifyDriftSeverity(filePath string, isComponent bool) string {
	if isComponent {
		return "critical"
	}
	if strings.HasSuffix(filePath, "_test.go") {
		return "info"
	}
	return "warning"
}

// highestSeverity returns the highest severity among a list of files.
func highestSeverity(files []string, isComponent bool) string {
	highest := "info"
	for _, f := range files {
		s := classifyDriftSeverity(f, isComponent)
		if s == "critical" {
			return "critical"
		}
		if s == "warning" {
			highest = "warning"
		}
	}
	return highest
}

// logDriftEvent writes a drift event to audit.jsonl.
func logDriftEvent(projectPath, action, target string, detail map[string]any) {
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return
	}
	spec.AppendAudit(projectPath, spec.AuditEntry{
		Action: action,
		Target: target,
		Detail: string(detailJSON),
		User:   "hook",
	})
}

// matchComponentByPackage checks if a file's directory path matches any component's
// file path prefix in the spec refs. This allows detecting component-level drift
// even when the exact file isn't listed in the spec.
func matchComponentByPackage(filePath string, specRefs map[string]string) string {
	// Extract the directory of the changed file.
	fileDir := filePath
	if idx := strings.LastIndex(filePath, "/"); idx >= 0 {
		fileDir = filePath[:idx]
	}

	// Check if any spec ref shares the same directory prefix.
	for refPath, component := range specRefs {
		if component == "" {
			continue
		}
		refDir := refPath
		if idx := strings.LastIndex(refPath, "/"); idx >= 0 {
			refDir = refPath[:idx]
		}
		if fileDir == refDir || strings.HasPrefix(fileDir, refDir+"/") {
			return component
		}
	}
	return ""
}

// reverseMapFileToFR finds FR-N references associated with a file path
// by parsing tasks.md "_Requirements: FR-N | Files: path_" entries.
func reverseMapFileToFR(filePath, tasksContent string) []string {
	if tasksContent == "" {
		return nil
	}

	var frs []string
	seen := map[string]bool{}

	for _, line := range strings.Split(tasksContent, "\n") {
		trimmed := strings.TrimSpace(line)
		// Match lines containing both Files: and Requirements:.
		if !strings.Contains(trimmed, "Files:") && !strings.Contains(trimmed, "files:") {
			continue
		}
		if !strings.Contains(trimmed, filePath) {
			continue
		}
		// Extract FR-N from Requirements field.
		if m := taskReqPattern.FindStringSubmatch(trimmed); len(m) > 1 {
			for _, fr := range frIDPattern.FindAllString(m[1], -1) {
				if !seen[fr] {
					seen[fr] = true
					frs = append(frs, fr)
				}
			}
		}
	}
	return frs
}

// frIDPattern matches FR-N identifiers (reuse from spec package pattern).
var frIDPattern = regexp.MustCompile(`FR-(\d+)`)

// taskReqPattern matches Requirements: FR-N entries in tasks.md.
var taskReqPattern = regexp.MustCompile(`Requirements:\s*(FR-\d+(?:\s*,\s*FR-\d+)*)`)

// uniqueStrings returns deduplicated strings preserving order.
func uniqueStrings(ss []string) []string {
	seen := make(map[string]bool, len(ss))
	result := make([]string, 0, len(ss))
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			result = append(result, s)
		}
	}
	return result
}

