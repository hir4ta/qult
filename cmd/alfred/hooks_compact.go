package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// handlePreCompact saves session state before context compaction.
// This is the core of compact resilience — it reads the conversation transcript
// to extract key context (recent user messages, decisions, blockers) and saves
// them to session.md before the context is summarized.
func handlePreCompact(ctx context.Context, projectPath, transcriptPath, customInstructions string) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		debugf("PreCompact: no active spec, skipping")
		return
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		debugf("PreCompact: spec dir missing for %s", taskSlug)
		return
	}

	// Extract rich context from transcript.
	var txCtx *transcriptContext
	if transcriptPath != "" {
		txCtx = extractTranscriptContextRich(transcriptPath)
	} else {
		fmt.Fprintf(os.Stderr, "[alfred] warning: transcript_path is empty — session context will not be captured\n")
		debugf("PreCompact: transcript_path is empty")
	}
	if txCtx == nil && transcriptPath != "" {
		fmt.Fprintf(os.Stderr, "[alfred] warning: could not extract context from transcript\n")
		debugf("PreCompact: empty context from transcript %s", transcriptPath)
	}

	// Extract decisions from transcript.
	var decisions []string
	if transcriptPath != "" {
		decisions = extractDecisionsFromTranscript(transcriptPath)
	}

	// Auto-append decisions to decisions.md (not just session.md).
	if len(decisions) > 0 {
		autoAppendDecisions(sd, decisions)
	}

	// Persist decisions as permanent memory (survives spec deletion).
	if len(decisions) > 0 {
		persistDecisionMemory(projectPath, taskSlug, decisions)
	}

	// Get modified files from git.
	modifiedFiles := getModifiedFiles(projectPath)

	// Build activeContext session.md with rich context, then enforce size limit.
	session := buildActiveContextSession(sd, taskSlug, txCtx, decisions, modifiedFiles, customInstructions)
	session = enforceSessionSizeLimit(session)
	if err := sd.WriteFile(spec.FileSession, session); err != nil {
		debugf("PreCompact: write session error: %v", err)
		return
	}

	// Sync session.md to DB (without embedder — hook is short-lived).
	st, err := store.OpenDefaultCached()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] warning: DB open failed, session not synced: %v\n", err)
		debugf("PreCompact: DB open error: %v", err)
		return
	}
	if err := spec.SyncSingleFile(ctx, sd, spec.FileSession, st, nil); err != nil {
		debugf("PreCompact: sync error: %v", err)
		return
	}

	// Emit spec-aware compaction instructions to stdout.
	emitCompactionInstructions(sd, taskSlug)

	// Async embedding generation for session.md.
	asyncEmbedSession(sd)

	ctxSize := 0
	if txCtx != nil {
		ctxSize = len(txCtx.LastAssistantWork) + len(txCtx.LastUserDirective)
	}
	debugf("PreCompact: saved session for %s (context: %d bytes)", taskSlug, ctxSize)
}

// rotateCompactMarkers keeps only the last maxMarkers compact markers in session.md.
func rotateCompactMarkers(content string, maxMarkers int) string {
	const markerPrefix = "## Compact Marker ["

	// Split content into pre-marker content and markers.
	lines := strings.Split(content, "\n")
	var preMarkerLines []string
	var markers []string
	var currentMarker strings.Builder
	inMarker := false

	for _, line := range lines {
		if strings.HasPrefix(line, markerPrefix) {
			if inMarker {
				markers = append(markers, currentMarker.String())
				currentMarker.Reset()
			}
			inMarker = true
			currentMarker.WriteString(line + "\n")
		} else if inMarker {
			currentMarker.WriteString(line + "\n")
		} else {
			preMarkerLines = append(preMarkerLines, line)
		}
	}
	if inMarker {
		markers = append(markers, currentMarker.String())
	}

	// Keep only the last maxMarkers.
	if len(markers) > maxMarkers {
		markers = markers[len(markers)-maxMarkers:]
	}

	var result strings.Builder
	result.WriteString(strings.Join(preMarkerLines, "\n"))
	for _, m := range markers {
		result.WriteString(m)
	}
	return result.String()
}

// emitCompactionInstructions outputs spec-aware instructions to stdout
// so Claude Code preserves key context during compaction.
func emitCompactionInstructions(sd *spec.SpecDir, taskSlug string) {
	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("[Alfred Protocol] Active task: %s\n", taskSlug))
	buf.WriteString("Preserve the following during compaction:\n")

	if req, err := sd.ReadFile(spec.FileRequirements); err == nil {
		summary := extractFirstLines(req, 3)
		if summary != "" {
			buf.WriteString("Requirements: " + summary + "\n")
		}
	}
	if design, err := sd.ReadFile(spec.FileDesign); err == nil {
		summary := extractFirstLines(design, 3)
		if summary != "" {
			buf.WriteString("Design: " + summary + "\n")
		}
	}
	if session, err := sd.ReadFile(spec.FileSession); err == nil {
		// Extract "Currently Working On" from activeContext format.
		lines := strings.Split(session, "\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "## Currently Working On") {
				for j := i + 1; j < len(lines); j++ {
					pos := strings.TrimSpace(lines[j])
					if pos == "" || strings.HasPrefix(pos, "## ") {
						break
					}
					buf.WriteString("Current position: " + pos + "\n")
					break
				}
				break
			}
		}
	}

	fmt.Fprint(os.Stdout, buf.String())
	debugf("PreCompact: emitted compaction instructions for %s", taskSlug)
}

// extractFirstLines returns the first n non-empty, non-header lines of content.
func extractFirstLines(content string, n int) string {
	var lines []string
	for line := range strings.SplitSeq(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "<!--") {
			continue
		}
		lines = append(lines, line)
		if len(lines) >= n {
			break
		}
	}
	return strings.Join(lines, " | ")
}

// asyncEmbedSession spawns a background process to generate embeddings for session.md.
func asyncEmbedSession(sd *spec.SpecDir) {
	exe, err := os.Executable()
	if err != nil {
		debugf("asyncEmbedSession: executable path error: %v", err)
		return
	}

	cmd := execCommand(exe, "embed-async",
		"--project", sd.ProjectPath,
		"--task", sd.TaskSlug,
		"--file", string(spec.FileSession))
	cmd.Stdout = nil
	cmd.Stderr = nil
	// Detach the child process so it runs independently.
	// The hook handler exits shortly after; the OS reparents the child to init.
	// No goroutine needed — cmd.Wait() is intentionally not called.
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] warning: async embed failed: %v\n", err)
		debugf("asyncEmbedSession: start error: %v", err)
		return
	}
	debugf("asyncEmbedSession: spawned pid=%d for %s/%s", cmd.Process.Pid, sd.TaskSlug, spec.FileSession)
}

// getModifiedFiles returns a list of files modified in the current git working tree.
// Returns nil if git is not available (non-git project).
func getModifiedFiles(projectPath string) []string {
	// Check git availability before running commands.
	if _, err := exec.LookPath("git"); err != nil {
		debugf("getModifiedFiles: git not found in PATH")
		return nil
	}
	cmd := execCommand("git", "diff", "--name-only", "HEAD")
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		// Fallback: try unstaged only.
		cmd = execCommand("git", "diff", "--name-only")
		cmd.Dir = projectPath
		out, err = cmd.Output()
		if err != nil {
			debugf("git diff unstaged: %v", err)
		}
	}

	// Also include staged files.
	cmd2 := execCommand("git", "diff", "--cached", "--name-only")
	cmd2.Dir = projectPath
	staged, err := cmd2.Output()
	if err != nil {
		debugf("git diff cached: %v", err)
	}

	seen := make(map[string]bool)
	var files []string
	for _, chunk := range [][]byte{out, staged} {
		for _, f := range strings.Split(strings.TrimSpace(string(chunk)), "\n") {
			f = strings.TrimSpace(f)
			if f != "" && !seen[f] {
				seen[f] = true
				files = append(files, f)
			}
		}
	}
	return files
}

// autoAppendDecisions appends newly extracted decisions to decisions.md,
// deduplicating against existing content.
func autoAppendDecisions(sd *spec.SpecDir, decisions []string) {
	existing, _ := sd.ReadFile(spec.FileDecisions)
	existingLower := strings.ToLower(existing)

	// Extract existing decision lines for substring matching.
	var existingLines []string
	for line := range strings.SplitSeq(existingLower, "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "- ")
		if len([]rune(line)) >= 8 && !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "<!--") {
			existingLines = append(existingLines, line)
		}
	}

	var newDecisions []string
	for _, d := range decisions {
		lower := strings.ToLower(d)

		// Check 1: substring match — if any existing line is contained in the
		// new decision or vice versa, treat as duplicate.
		isDup := false
		for _, el := range existingLines {
			if strings.Contains(lower, el) || strings.Contains(el, lower) {
				isDup = true
				break
			}
		}
		if isDup {
			continue
		}

		// Check 2: significant word overlap (60%+ threshold).
		// Use tokenizePrompt for proper Japanese word segmentation.
		sigWords := significantWords(lower)
		if len(sigWords) > 0 {
			hits := 0
			for _, w := range sigWords {
				if strings.Contains(existingLower, w) {
					hits++
				}
			}
			if float64(hits)/float64(len(sigWords)) >= 0.6 {
				continue
			}
		}
		newDecisions = append(newDecisions, d)
	}

	if len(newDecisions) == 0 {
		return
	}

	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("\n## [%s] Auto-extracted from conversation\n", time.Now().Format("2006-01-02")))
	for _, d := range newDecisions {
		buf.WriteString(fmt.Sprintf("- %s\n", d))
	}

	if err := sd.AppendFile(spec.FileDecisions, buf.String()); err != nil {
		debugf("autoAppendDecisions: %v", err)
	} else {
		debugf("autoAppendDecisions: added %d decisions", len(newDecisions))
	}
}

// buildActiveContextSession constructs session.md in activeContext format.
// It preserves existing content before any Compact Marker, then rebuilds
// the structured sections with fresh data from the rich transcript context.
func buildActiveContextSession(sd *spec.SpecDir, taskSlug string, txCtx *transcriptContext, decisions, modifiedFiles []string, customInstructions string) string {
	existing, _ := sd.ReadFile(spec.FileSession)

	// Extract existing structured fields from session.md.
	// Supports both new activeContext format and legacy format.
	existingStatus := extractSection(existing, "## Status")
	existingWorkingOn := extractSection(existing, "## Currently Working On")
	if existingWorkingOn == "" {
		existingWorkingOn = extractSection(existing, "## Current Position")
	}
	existingNextSteps := extractSection(existing, "## Next Steps")
	if existingNextSteps == "" {
		existingNextSteps = extractSection(existing, "## Pending")
	}
	existingBlockers := extractSection(existing, "## Blockers")
	if existingBlockers == "" {
		existingBlockers = extractSection(existing, "## Unresolved Issues")
	}

	if existingStatus == "" {
		existingStatus = "active"
	}

	// Build "Currently Working On" from the last assistant message.
	workingOn := existingWorkingOn
	if txCtx != nil && txCtx.LastAssistantWork != "" {
		workingOn = txCtx.LastAssistantWork
	}

	// Build "Recent Decisions" from existing + newly extracted.
	existingDecisions := extractListItems(existing, "## Recent Decisions")
	allDecisions := append(existingDecisions, decisions...)
	if len(allDecisions) > 3 {
		allDecisions = allDecisions[len(allDecisions)-3:]
	}

	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("# Session: %s\n\n", taskSlug))

	buf.WriteString("## Status\n")
	buf.WriteString(existingStatus + "\n\n")

	buf.WriteString("## Currently Working On\n")
	if workingOn != "" {
		buf.WriteString(workingOn + "\n")
	}
	buf.WriteString("\n")

	buf.WriteString("## Recent Decisions (last 3)\n")
	for i, d := range allDecisions {
		buf.WriteString(fmt.Sprintf("%d. %s\n", i+1, d))
	}
	buf.WriteString("\n")

	buf.WriteString("## Next Steps\n")
	if existingNextSteps != "" {
		if txCtx != nil {
			existingNextSteps = updateNextStepsCompletion(existingNextSteps, txCtx)
		}
		buf.WriteString(existingNextSteps + "\n")
	}
	buf.WriteString("\n")

	buf.WriteString("## Blockers\n")
	if existingBlockers != "" {
		buf.WriteString(existingBlockers + "\n")
	} else {
		buf.WriteString("None\n")
	}
	buf.WriteString("\n")

	buf.WriteString("## Modified Files (this session)\n")
	for _, f := range modifiedFiles {
		buf.WriteString("- " + f + "\n")
	}

	// Add compact marker with rich context.
	buf.WriteString(fmt.Sprintf("## Compact Marker [%s]\n", time.Now().Format("2006-01-02 15:04:05")))
	if customInstructions != "" {
		buf.WriteString(fmt.Sprintf("User compact instructions: %s\n", customInstructions))
	}

	// Rich pre-compact context snapshot.
	if txCtx != nil {
		buf.WriteString("### Pre-Compact Context Snapshot\n")

		if txCtx.LastUserDirective != "" {
			buf.WriteString("Last user directive:\n")
			buf.WriteString(txCtx.LastUserDirective + "\n\n")
		}

		if len(txCtx.AssistantActions) > 0 {
			buf.WriteString("Recent assistant actions:\n")
			for _, s := range txCtx.AssistantActions {
				buf.WriteString("- " + s + "\n")
			}
			buf.WriteString("\n")
		}

		if len(txCtx.RunningAgents) > 0 {
			buf.WriteString("Running background agents (may still be active):\n")
			for _, a := range txCtx.RunningAgents {
				buf.WriteString("- " + a + "\n")
			}
			buf.WriteString("\n")
		}

		if len(txCtx.RecentToolUses) > 0 {
			buf.WriteString("Recent tool calls:\n")
			for _, t := range txCtx.RecentToolUses {
				buf.WriteString("- " + t + "\n")
			}
			buf.WriteString("\n")
		}

		if len(txCtx.ToolErrors) > 0 {
			buf.WriteString("Recent errors (dead ends):\n")
			for _, e := range txCtx.ToolErrors {
				buf.WriteString("- " + e + "\n")
			}
			buf.WriteString("\n")
		}
	}
	buf.WriteString("---\n\n")

	return rotateCompactMarkers(buf.String(), 3)
}

// maxSessionBytes is the upper size limit for session.md (512KB).
// Long-running tasks accumulate compact markers and context snapshots; beyond
// this size the file becomes unwieldy and costly for spec injection.
const maxSessionBytes = 512 * 1024

// enforceSessionSizeLimit trims session.md if it exceeds maxSessionBytes by
// removing the oldest compact markers until it fits.
func enforceSessionSizeLimit(content string) string {
	if len(content) <= maxSessionBytes {
		return content
	}
	// Progressively remove oldest compact markers until within limit.
	for len(content) > maxSessionBytes {
		prev := content
		content = removeOldestCompactMarker(content)
		if content == prev {
			break // no more markers to remove
		}
	}
	return content
}

// removeOldestCompactMarker removes the first (oldest) compact marker section.
func removeOldestCompactMarker(content string) string {
	const markerPrefix = "## Compact Marker ["
	start := strings.Index(content, markerPrefix)
	if start < 0 {
		return content
	}
	// Find the end of this marker section (next ## heading or EOF).
	rest := content[start+len(markerPrefix):]
	end := strings.Index(rest, "\n## ")
	if end < 0 {
		// Last marker — remove everything from start.
		return strings.TrimRight(content[:start], "\n")
	}
	// content[:start] already ends with \n from the preceding section;
	// skip the \n in "\n## " to avoid a double newline.
	return content[:start] + content[start+len(markerPrefix)+end+1:]
}

// updateNextStepsCompletion scans transcript context for completion signals
// and updates unchecked Next Steps items to checked.
// Matches assistant messages containing "完了" / "completed" / "done" patterns
// against each Next Steps item text.
func updateNextStepsCompletion(nextSteps string, txCtx *transcriptContext) string {
	// Build combined text from recent assistant actions for matching.
	var assistantText strings.Builder
	for _, a := range txCtx.AssistantActions {
		assistantText.WriteString(strings.ToLower(a))
		assistantText.WriteByte('\n')
	}
	if txCtx.LastAssistantWork != "" {
		assistantText.WriteString(strings.ToLower(txCtx.LastAssistantWork))
	}
	combined := assistantText.String()

	lines := strings.Split(nextSteps, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "- [ ] ") {
			continue
		}
		itemText := strings.TrimPrefix(trimmed, "- [ ] ")
		if isItemCompleted(itemText, combined) {
			lines[i] = strings.Replace(line, "- [ ] ", "- [x] ", 1)
		}
	}
	return strings.Join(lines, "\n")
}

// isItemCompleted checks if a Next Steps item appears completed in the transcript.
// Extracts significant words from the item and checks if they appear near
// completion markers in the assistant text.
func isItemCompleted(itemText, assistantTextLower string) bool {
	completionMarkers := []string{
		"完了", "done", "completed", "finished", "✓", "✅",
		"complete", "実装完了", "対応完了",
	}

	// Extract significant words from the item (skip short particles).
	itemLower := strings.ToLower(itemText)
	words := significantWords(itemLower)
	if len(words) == 0 {
		return false
	}

	// Check if enough item words appear near a completion marker.
	for _, marker := range completionMarkers {
		markerIdx := strings.Index(assistantTextLower, marker)
		if markerIdx < 0 {
			continue
		}
		// Look at a window around the marker (500 chars before/after).
		start := max(0, markerIdx-500)
		end := min(len(assistantTextLower), markerIdx+500)
		window := assistantTextLower[start:end]

		hits := 0
		for _, w := range words {
			if strings.Contains(window, w) {
				hits++
			}
		}
		// Require 50%+ word overlap for completion match.
		if float64(hits)/float64(len(words)) >= 0.5 {
			return true
		}
	}
	return false
}

// persistDecisionMemory saves extracted decisions as permanent memory docs
// (source_type="memory"). These survive spec deletion and enable cross-session
// search for past decisions.
func persistDecisionMemory(projectPath, taskSlug string, decisions []string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("persistDecisionMemory: DB open error: %v", err)
		return
	}

	project := projectBaseName(projectPath)
	date := time.Now().Format("2006-01-02")
	url := fmt.Sprintf("memory://user/%s/%s/%s", project, taskSlug, date)

	saved := 0
	for _, d := range decisions {
		sectionPath := fmt.Sprintf("%s > %s > decision > %s", project, taskSlug, truncateDecision(d, 60))
		_, changed, err := st.UpsertDoc(&store.DocRow{
			URL:         url,
			SectionPath: sectionPath,
			Content:     d,
			SourceType:  "memory",
			TTLDays:     0, // permanent
		})
		if err != nil {
			debugf("persistDecisionMemory: upsert error: %v", err)
			continue
		}
		if changed {
			saved++
		}
	}
	if saved > 0 {
		debugf("persistDecisionMemory: saved %d decisions for %s/%s", saved, project, taskSlug)
	}
}

// projectBaseName extracts the project directory name from an absolute path.
func projectBaseName(projectPath string) string {
	parts := strings.Split(strings.TrimRight(projectPath, "/"), "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "unknown"
}

// truncateDecision shortens a decision string for use in section_path.
func truncateDecision(d string, maxLen int) string {
	runes := []rune(d)
	if len(runes) <= maxLen {
		return d
	}
	return string(runes[:maxLen])
}

