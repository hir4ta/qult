package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/epic"
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
		return
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return
	}

	// Extract rich context and decisions from transcript (single read).
	var txCtx *transcriptContext
	var txData []byte
	if transcriptPath != "" {
		txCtx, txData = extractTranscriptContextRich(transcriptPath)
	} else {
		notifyUser("warning: transcript_path is empty — session context will not be captured")
	}
	if txCtx == nil && transcriptPath != "" {
		notifyUser("warning: could not extract context from transcript")
	}

	// Extract decisions from the already-read transcript data (no re-read).
	// Fallback to independent read if rich extraction failed (e.g., format guard).
	var decisions []string
	if len(txData) > 0 {
		// Limit to last 64KB for decision extraction (matching original budget).
		decData := txData
		if len(decData) > 64*1024 {
			decData = decData[len(decData)-64*1024:]
		}
		decisions = extractDecisionsFromData(decData)
	} else if transcriptPath != "" {
		decisions = extractDecisionsFromTranscript(transcriptPath)
	}

	// Auto-append decisions to decisions.md (not just session.md).
	if len(decisions) > 0 {
		autoAppendDecisions(ctx, sd, decisions)
	}

	// Persist decisions as permanent memory (survives spec deletion).
	if len(decisions) > 0 {
		persistDecisionMemory(ctx, projectPath, taskSlug, decisions)
	}

	// Suggest updating steering docs if architecture-related decisions were detected.
	if len(decisions) > 0 && spec.SteeringExists(projectPath) {
		suggestSteeringUpdate(decisions)
	}

	// Get modified files from git.
	modifiedFiles := getModifiedFiles(projectPath)

	// Persist current session as a "chapter" memory before overwriting.
	// This preserves the full context of each compact cycle, enabling
	// recall of early-session conversations after multiple compactions.
	persistChapterMemory(ctx, projectPath, taskSlug, sd, transcriptPath)

	// Build activeContext session.md with rich context, then enforce size limit.
	session := buildActiveContextSession(sd, taskSlug, txCtx, decisions, modifiedFiles, customInstructions)
	session = enforceSessionSizeLimit(session)

	if err := sd.WriteFile(ctx, spec.FileSession, session); err != nil {
		return
	}

	// Sync epic progress from session.md status.
	syncEpicProgress(projectPath, taskSlug, session)

	// Auto-complete task if session status indicates completion or all Next Steps are done.
	autoCompleteTask(projectPath, taskSlug, session)

	// Sync session.md to DB (without embedder — hook is short-lived).
	st, err := store.OpenDefaultCached()
	if err != nil {
		notifyUser("warning: DB open failed, session not synced: %v", err)
		return
	}

	// Warn about memories with very low vitality (read-only, never auto-disable).
	warnLowVitalityMemories(ctx, st)

	// Inject promotion candidates if any exist.
	injectPromotionCandidates(ctx, st)

	// Expire old chapter memories (90-day TTL).
	st.DeleteExpiredDocs(ctx)

	if err := spec.SyncSingleFile(ctx, sd, spec.FileSession, st, nil); err != nil {
		return
	}

	// Detect research/investigation patterns and suggest saving knowledge.
	if txCtx != nil {
		suggestKnowledgeSave(txCtx)
	}

	// Emit spec-aware compaction instructions to stdout.
	emitCompactionInstructions(sd, taskSlug)

	// Periodic orphan cleanup: remove embeddings for deleted records.
	if st, err := store.OpenDefaultCached(); err == nil {
		if n, err := st.CleanOrphanedEmbeddings(); err == nil && n > 0 {
			notifyUser("cleaned %d orphaned embedding(s)", n)
		}
	}

	// Async embedding generation for session.md.
	asyncEmbedSession(sd)

	// Write pending-compact breadcrumb for session continuity.
	// The next SessionStart will read this to create a session link.
	writePendingCompact(projectPath, taskSlug)

	notifyUser("saved session for task '%s'", taskSlug)
}

// significantWords extracts meaningful words (4+ runes) from lowercased text.
func significantWords(lower string) []string {
	var words []string
	for _, w := range strings.Fields(lower) {
		if len([]rune(w)) >= 4 {
			words = append(words, w)
		}
	}
	return words
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

// injectPromotionCandidates checks for memories that qualify for sub_type promotion
// and injects a notification into additionalContext during PreCompact.
func injectPromotionCandidates(ctx context.Context, st *store.Store) {
	candidates, err := st.GetPromotionCandidates(ctx)
	if err != nil || len(candidates) == 0 {
		return
	}

	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("Knowledge promotion candidates: %d memories qualify for upgrade\n", len(candidates)))
	for _, d := range candidates {
		suggested := store.SubTypePattern
		if d.SubType == store.SubTypePattern {
			suggested = store.SubTypeRule
		}
		buf.WriteString(fmt.Sprintf("- \"%s\" (hit: %d) → %s candidate [id=%d]\n",
			truncateStr(d.SectionPath, 60), d.HitCount, suggested, d.ID))
	}
	buf.WriteString("Use: ledger action=promote id=ID sub_type=TYPE\n")
	emitAdditionalContext("PreCompact", buf.String())
}

// emitCompactionInstructions outputs spec-aware instructions to stdout
// so Claude Code preserves key context during compaction.
func emitCompactionInstructions(sd *spec.SpecDir, taskSlug string) {
	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("[Alfred Protocol] Active task: %s\n", taskSlug))
	buf.WriteString("Preserve the following during compaction:\n")

	// Read primary file: bugfix.md for bugfix specs, requirements.md otherwise.
	primaryFile := spec.FileRequirements
	if bugfix, err := sd.ReadFile(spec.FileBugfix); err == nil && bugfix != "" {
		primaryFile = spec.FileBugfix
	}
	if req, err := sd.ReadFile(primaryFile); err == nil {
		label := "Requirements"
		if primaryFile == spec.FileBugfix {
			label = "Bugfix"
		}
		summary := extractFirstLines(req, 3)
		if summary != "" {
			buf.WriteString(label + ": " + summary + "\n")
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
		return
	}

	cmd := execCommand(exe, "embed-async",
		"--project", sd.ProjectPath,
		"--task", sd.TaskSlug,
		"--file", string(spec.FileSession))
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		notifyUser("warning: async embed failed: %v", err)
		return
	}
	_ = cmd.Process.Release()
}

// getModifiedFiles returns a list of files modified in the current git working tree.
// Returns nil if git is not available (non-git project).
func getModifiedFiles(projectPath string) []string {
	// Check git availability before running commands.
	if _, err := exec.LookPath("git"); err != nil {
		return nil
	}
	cmd := execCommand("git", "diff", "--name-only", "HEAD")
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		// Fallback: try unstaged only.
		cmd = execCommand("git", "diff", "--name-only")
		cmd.Dir = projectPath
		out, _ = cmd.Output()
	}

	// Also include staged files.
	cmd2 := execCommand("git", "diff", "--cached", "--name-only")
	cmd2.Dir = projectPath
	staged, _ := cmd2.Output()

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

// suggestSteeringUpdate checks if decisions contain architecture-related keywords
// and suggests updating steering docs if so.
func suggestSteeringUpdate(decisions []string) {
	archKeywords := []string{
		"package", "module", "directory", "structure", "architecture",
		"dependency", "framework", "stack", "migration", "api",
		"convention", "naming", "layout",
	}
	for _, d := range decisions {
		lower := strings.ToLower(d)
		for _, kw := range archKeywords {
			if strings.Contains(lower, kw) {
				notifyUser("hint: architecture-related decision detected — consider updating steering docs (.alfred/steering/)")
				return
			}
		}
	}
}

// autoAppendDecisions appends newly extracted decisions to decisions.md,
// deduplicating against existing content.
func autoAppendDecisions(ctx context.Context, sd *spec.SpecDir, decisions []string) {
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
		// new decision or vice versa, treat as duplicate. Only match if the
		// shorter side is at least 20 runes to avoid overly broad matching
		// from short existing entries (e.g., "use postgres" blocking unrelated decisions).
		isDup := false
		for _, el := range existingLines {
			shorter := len([]rune(el))
			if shorter > len([]rune(lower)) {
				shorter = len([]rune(lower))
			}
			if shorter >= 20 && (strings.Contains(lower, el) || strings.Contains(el, lower)) {
				isDup = true
				break
			}
		}
		if isDup {
			continue
		}

		// Check 2: significant word overlap (60%+ threshold).
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

	_ = sd.AppendFile(ctx, spec.FileDecisions, buf.String()) // best-effort
}

// buildActiveContextSession constructs session.md in activeContext format.
// It preserves existing content before any Compact Marker, then rebuilds
// the structured sections with fresh data from the rich transcript context.
func buildActiveContextSession(sd *spec.SpecDir, taskSlug string, txCtx *transcriptContext, decisions, modifiedFiles []string, customInstructions string) string {
	existing, _ := sd.ReadFile(spec.FileSession)

	// Extract existing structured fields from session.md.
	// Supports both new activeContext format and legacy format.
	existingStatus := extractSection(existing, "## Status")
	existingWorkingOn := extractSectionFallback(existing, "## Currently Working On", "## Current Position")
	existingNextSteps := extractSectionFallback(existing, "## Next Steps", "## Pending")
	existingBlockers := extractSectionFallback(existing, "## Blockers", "## Unresolved Issues")

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
	allDecisions := make([]string, 0, len(existingDecisions)+len(decisions))
	allDecisions = append(allDecisions, existingDecisions...)
	allDecisions = append(allDecisions, decisions...)
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
// search for past decisions. Also persists structured decision JSON files.
func persistDecisionMemory(ctx context.Context, projectPath, taskSlug string, decisions []string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	project := projectBaseName(projectPath)
	date := time.Now().Format("2006-01-02")
	url := fmt.Sprintf("memory://user/%s/%s/%s", project, taskSlug, date)
	now := time.Now().UTC().Format(time.RFC3339)
	sessionID := os.Getenv("CLAUDE_SESSION_ID")

	saved := 0
	var changedIDs []int64
	for i, d := range decisions {
		// Build structured decision.
		dec := store.StructuredDecision{
			ID:         fmt.Sprintf("%s-%d", taskSlug, i),
			Title:      truncateStr(d, 100),
			Decision:   d,
			Status:     "draft",
			SessionRef: sessionID,
			TaskRef:    taskSlug,
			CreatedAt:  now,
		}

		// Serialize structured data.
		structuredJSON, err := json.Marshal(dec)
		if err != nil {
			structuredJSON = nil // fall back to no structured data
		}

		sectionPath := fmt.Sprintf("%s > %s > decision > %s#%d", project, taskSlug, truncateDecision(d, 60), i)
		id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
			URL:         url,
			SectionPath: sectionPath,
			Content:     dec.ToContent(),
			SourceType:  store.SourceMemory,
			SubType:     store.SubTypeDecision,
			TTLDays:     0, // permanent
			Structured:  string(structuredJSON),
		})
		if err != nil {
			continue
		}
		if changed {
			saved++
			changedIDs = append(changedIDs, id)
		}

		// Save structured JSON file (best-effort).
		if _, err := store.SaveDecision(projectPath, &dec); err != nil {
			fmt.Fprintf(os.Stderr, "alfred: save decision file: %v\n", err)
		}
	}
	// asyncEmbedDocs spawns a single detached background process (non-blocking cmd.Start).
	// It runs independently after this hook exits, so it doesn't consume our
	// 10s PreCompact timeout budget.
	asyncEmbedDocs(changedIDs)
	if saved > 0 {
		notifyUser("persisted %d decision(s) to memory (%s/%s)", saved, project, taskSlug)
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

// ---------------------------------------------------------------------------
// Chapter memory: compact-cycle snapshots for multi-compact session recall
// ---------------------------------------------------------------------------

// maxChapterSectionBytes caps each chapter section (individual user message or
// session state) at 32KB. Large enough for ~800-line markdown files or JSON
// payloads, while preventing extreme outliers from bloating the DB.
const maxChapterSectionBytes = 32 * 1024

// chapterMemoryTTLDays is the TTL for chapter memory entries (90 days).
// Chapter memories are verbose per-compact-cycle snapshots; unlike condensed
// session summaries (permanent), they auto-expire to prevent DB bloat.
// Expiration is enforced by DeleteExpiredDocs, called during PreCompact.
const chapterMemoryTTLDays = 90

// persistChapterMemory saves the current session context as permanent memory
// "chapter" sections before session.md is overwritten by the new compact cycle.
//
// Unlike a single monolithic doc, each user message and the session state are
// stored as separate docs. This enables:
// - Individual FTS/vector search per section (better recall precision)
// - No artificial size cap on total chapter (sum of sections can be large)
// - Each section gets its own embedding (search finds the specific passage)
func persistChapterMemory(ctx context.Context, projectPath, taskSlug string, sd *spec.SpecDir, transcriptPath string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Determine chapter number from existing compact markers.
	existing, _ := sd.ReadFile(spec.FileSession)
	chapterNum := strings.Count(existing, "## Compact Marker [") + 1

	project := projectBaseName(projectPath)
	ts := time.Now().Format("2006-01-02T15:04:05")
	baseURL := fmt.Sprintf("memory://user/%s/%s/chapter-%d", project, taskSlug, chapterNum)

	// Create a concise label for timeline display.
	workingOn := extractSection(existing, "## Currently Working On")
	if workingOn == "" {
		workingOn = extractSectionFallback(existing, "## Current Position", "## Status")
	}
	label := truncateStr(workingOn, 120)
	if label == "" {
		label = fmt.Sprintf("chapter %d", chapterNum)
	}

	var savedCount int
	var changedIDs []int64

	// Section 1: Structured session state (JSON for better search recall).
	if existing != "" {
		structured := buildStructuredChapter(existing, projectPath, taskSlug, chapterNum)
		// Truncate large fields before marshaling to avoid byte-boundary corruption.
		if len(structured.Goal) > 1024 {
			structured.Goal = structured.Goal[:1024]
		}
		if len(structured.NextSteps) > 20 {
			structured.NextSteps = structured.NextSteps[:20]
		}
		if len(structured.ModifiedFiles) > 50 {
			structured.ModifiedFiles = structured.ModifiedFiles[:50]
		}
		content, err := json.Marshal(structured)
		if err != nil {
			// Fallback to raw markdown with UTF-8-safe truncation.
			raw := existing
			if len(raw) > maxChapterSectionBytes {
				raw = safeTruncateBytes(raw, maxChapterSectionBytes)
			}
			content = []byte(raw)
		}

		// Build StructuredSession from chapter data.
		now := time.Now().UTC().Format(time.RFC3339)
		sessID := fmt.Sprintf("ch%d-%s-%s", chapterNum, taskSlug, time.Now().Format("20060102T150405"))
		discussions := make([]store.Discussion, 0, len(structured.Decisions))
		for _, d := range structured.Decisions {
			discussions = append(discussions, store.Discussion{Topic: d})
		}
		filesModified := make([]store.FileChange, 0, len(structured.ModifiedFiles))
		for _, f := range structured.ModifiedFiles {
			filesModified = append(filesModified, store.FileChange{Path: f, Action: "edit"})
		}
		sess := store.StructuredSession{
			ID:        sessID,
			Title:     structured.Goal,
			CreatedAt: now,
			Context: store.SessionContext{
				ProjectName: project,
				TaskSlug:    taskSlug,
			},
			Summary: store.SessionSummary{
				Goal:    structured.Goal,
				Outcome: structured.Status,
			},
			Discussions:   discussions,
			Technologies:  structured.Technologies,
			FilesModified: filesModified,
			Handoff:       &store.SessionHandoff{NextSteps: structured.NextSteps},
		}

		// Serialize StructuredSession for the Structured field.
		structuredJSON, jsonErr := json.Marshal(sess)
		var structuredStr string
		if jsonErr == nil {
			structuredStr = string(structuredJSON)
		}

		// Use ToContent for human-readable DB content.
		dbContent := sess.ToContent()
		if dbContent == "" {
			dbContent = string(content) // fallback to chapter JSON
		}

		sectionPath := fmt.Sprintf("%s > %s > chapter-%d > %s", project, taskSlug, chapterNum, label)
		id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
			URL:         baseURL + "/session-state",
			SectionPath: sectionPath,
			Content:     dbContent,
			SourceType:  store.SourceMemory,
			TTLDays:     chapterMemoryTTLDays,
			Structured:  structuredStr,
		})
		if err == nil && changed {
			savedCount++
			changedIDs = append(changedIDs, id)
		}

		// Save structured session JSON file (best-effort).
		if _, err := store.SaveSession(projectPath, &sess); err != nil {
			fmt.Fprintf(os.Stderr, "alfred: save session file: %v\n", err)
		}
	}

	// Section 2+: Early conversation context — each user message as a separate doc.
	// User's initial messages contain reference materials, design docs, JSON payloads,
	// and task context that would be lost after compact.
	if transcriptPath != "" {
		earlyMsgs := extractEarlyUserMessages(transcriptPath)
		for i, msg := range earlyMsgs {
			content := msg
			if len(content) > maxChapterSectionBytes {
				content = safeTruncateBytes(content, maxChapterSectionBytes) + "\n... (truncated at 32KB)"
			}
			msgLabel := truncateStr(content, 80)
			sectionPath := fmt.Sprintf("%s > %s > chapter-%d > user-context-%d > %s", project, taskSlug, chapterNum, i+1, msgLabel)
			id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
				URL:         fmt.Sprintf("%s/user-context-%d", baseURL, i+1),
				SectionPath: sectionPath,
				Content:     content,
				SourceType:  store.SourceMemory,
				TTLDays:     chapterMemoryTTLDays,
			})
			if err != nil {
				continue
			}
			if changed {
				savedCount++
				changedIDs = append(changedIDs, id)
			}
		}
	}

	// Async embed all changed docs in a single batch process (non-blocking).
	asyncEmbedDocs(changedIDs)
	if savedCount > 0 {
		notifyUser("saved chapter %d (%d sections) for task '%s' (%s)", chapterNum, savedCount, taskSlug, ts)
	}
}

// structuredChapter is the JSON schema for chapter memory.
// Replaces raw session.md markdown with fields optimized for search and recall.
type structuredChapter struct {
	Chapter       int      `json:"chapter"`
	Task          string   `json:"task"`
	Project       string   `json:"project"`
	Status        string   `json:"status"`
	Goal          string   `json:"goal"`
	Technologies  []string `json:"technologies,omitempty"`
	ModifiedFiles []string `json:"modified_files,omitempty"`
	Decisions     []string `json:"decisions,omitempty"`
	Blockers      []string `json:"blockers,omitempty"`
	NextSteps     []string `json:"next_steps,omitempty"`
	CompletedAt   string   `json:"completed_at"`
}

// buildStructuredChapter extracts structured fields from session.md content.
func buildStructuredChapter(sessionContent, projectPath, taskSlug string, chapterNum int) structuredChapter {
	ch := structuredChapter{
		Chapter:     chapterNum,
		Task:        taskSlug,
		Project:     projectBaseName(projectPath),
		CompletedAt: time.Now().UTC().Format(time.RFC3339),
	}

	// Status.
	ch.Status = strings.TrimSpace(extractSection(sessionContent, "## Status"))

	// Goal = "Currently Working On".
	ch.Goal = strings.TrimSpace(extractSectionFallback(sessionContent, "## Currently Working On", "## Current Position"))

	// Modified files.
	modSection := ""
	for _, header := range []string{"## Modified Files", "## Modified Files (this session)"} {
		modSection = extractSection(sessionContent, header)
		if modSection != "" {
			break
		}
	}
	if modSection != "" {
		for _, line := range strings.Split(modSection, "\n") {
			f := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
			if f != "" {
				ch.ModifiedFiles = append(ch.ModifiedFiles, f)
			}
		}
	}

	// Decisions.
	decSection := extractSection(sessionContent, "## Recent Decisions")
	if decSection == "" {
		decSection = extractSection(sessionContent, "## Recent Decisions (last 3)")
	}
	if decSection != "" {
		for _, line := range strings.Split(decSection, "\n") {
			d := strings.TrimSpace(line)
			// Strip numbered prefix like "1. ".
			if len(d) > 3 && d[0] >= '0' && d[0] <= '9' && (d[1] == '.' || (d[1] >= '0' && d[1] <= '9' && d[2] == '.')) {
				idx := strings.Index(d, ". ")
				if idx > 0 {
					d = strings.TrimSpace(d[idx+2:])
				}
			}
			if d != "" {
				ch.Decisions = append(ch.Decisions, d)
			}
		}
	}

	// Blockers.
	blockSection := extractSectionFallback(sessionContent, "## Blockers", "## Unresolved Issues")
	if blockSection != "" {
		lower := strings.ToLower(strings.TrimSpace(blockSection))
		if lower != "none" && lower != "なし" && lower != "" {
			for _, line := range strings.Split(blockSection, "\n") {
				b := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
				if b != "" {
					ch.Blockers = append(ch.Blockers, b)
				}
			}
		}
	}

	// Next steps (unchecked only).
	nsSection := extractSection(sessionContent, "## Next Steps")
	if nsSection != "" {
		for _, line := range strings.Split(nsSection, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "- [ ] ") {
				ch.NextSteps = append(ch.NextSteps, strings.TrimPrefix(trimmed, "- [ ] "))
			}
		}
	}

	// Technologies — extract from modified file extensions and content keywords.
	ch.Technologies = extractTechnologies(sessionContent, ch.ModifiedFiles)

	return ch
}

// extractTechnologies infers technology keywords from file extensions and content.
func extractTechnologies(content string, files []string) []string {
	seen := make(map[string]bool)
	// From file extensions.
	extMap := map[string]string{
		".go": "go", ".ts": "typescript", ".js": "javascript",
		".py": "python", ".rs": "rust", ".sql": "sqlite",
		".yaml": "yaml", ".yml": "yaml", ".json": "json",
		".md": "markdown",
	}
	for _, f := range files {
		for ext, tech := range extMap {
			if strings.HasSuffix(f, ext) {
				seen[tech] = true
			}
		}
	}
	// From content keywords.
	lower := strings.ToLower(content)
	keywords := map[string]string{
		"sqlite": "sqlite", "voyage": "voyage-ai", "bubbletea": "bubbletea",
		"lipgloss": "lipgloss", "fts5": "fts5", "onnx": "onnx",
		"docker": "docker", "github actions": "github-actions",
	}
	for kw, tech := range keywords {
		if strings.Contains(lower, kw) {
			seen[tech] = true
		}
	}
	result := make([]string, 0, len(seen))
	for t := range seen {
		result = append(result, t)
	}
	return result
}

// extractEarlyUserMessages reads the first portion of the transcript and returns
// individual user messages — reference materials, design docs, JSON payloads,
// and task context that are typically passed at session start.
// Returns up to 10 messages, each preserving full content (no per-message truncation).
func extractEarlyUserMessages(transcriptPath string) []string {
	// Read the first 512KB of the transcript — enough for large reference materials.
	data, err := readFileHead(transcriptPath, 512*1024)
	if err != nil {
		return nil
	}

	lines := strings.Split(string(data), "\n")
	if !checkTranscriptFormat(lines) {
		return nil
	}

	var msgs []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		var entry transcriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		role := entry.Role
		if role == "" {
			role = entry.Message.Role
		}
		// Only capture user messages (where reference materials live).
		if role != "user" && entry.Type != "human" {
			continue
		}

		text := extractTextContent(entry)
		if text == "" {
			continue
		}

		msgs = append(msgs, text)

		// Capture first 10 user messages — covers most initial context passing.
		if len(msgs) >= 10 {
			break
		}
	}

	return msgs
}

// syncEpicProgress updates the task's status in its parent epic based on session.md content.
// This is called during PreCompact to keep epic progress in sync automatically.
func syncEpicProgress(projectPath, taskSlug, sessionContent string) {
	// Parse status from session.md.
	status := parseSessionStatusFromContent(sessionContent)
	if status == "" {
		return
	}

	// Map session status to epic task status.
	var epicStatus string
	switch {
	case status == "active" || status == "in-progress" || strings.HasPrefix(status, "implementation") || strings.HasPrefix(status, "design"):
		epicStatus = epic.StatusInProgress
	case status == "completed" || status == "done":
		epicStatus = epic.StatusCompleted
	case status == "blocked":
		epicStatus = epic.StatusBlocked
	default:
		epicStatus = epic.StatusInProgress
	}

	if epic.SyncTaskStatus(projectPath, taskSlug, epicStatus) {
		notifyUser("synced epic progress for task '%s' → %s", taskSlug, epicStatus)
	}
}

// autoCompleteTask marks a task as completed if session signals indicate it's done.
// Two signals trigger auto-completion:
//  1. session.md "## Status" is "completed" or "done"
//  2. All Next Steps items are checked (no unchecked "- [ ]" remaining)
func autoCompleteTask(projectPath, taskSlug, session string) {
	if taskSlug == "" {
		return
	}
	status := parseSessionStatusFromContent(session)
	statusDone := status == "completed" || status == "done"

	nextSteps := extractSection(session, "## Next Steps")
	allStepsDone := nextSteps != "" && allNextStepsCompleted(nextSteps)

	if !statusDone && !allStepsDone {
		return
	}

	newPrimary, err := spec.CompleteTask(projectPath, taskSlug)
	if err != nil {
		// Already completed or not found — not an error worth reporting.
		return
	}

	reason := "session status = " + status
	if allStepsDone && !statusDone {
		reason = "all Next Steps completed"
	}
	notifyUser("auto-completed task '%s' (%s)", taskSlug, reason)
	if newPrimary != "" {
		notifyUser("switched primary to '%s'", newPrimary)
	}
}

// allNextStepsCompleted returns true if every checklist item is checked.
// Returns false if there are no items at all.
func allNextStepsCompleted(nextSteps string) bool {
	hasItems := false
	for _, line := range strings.Split(nextSteps, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			hasItems = true
			continue
		}
		if strings.HasPrefix(trimmed, "- [ ] ") {
			return false // unchecked item found
		}
	}
	return hasItems
}

// pendingCompact is the breadcrumb written by PreCompact for session linking.
type pendingCompact struct {
	ClaudeSessionID string `json:"claude_session_id"`
	TaskSlug        string `json:"task_slug"`
	Timestamp       string `json:"timestamp"`
}

// pendingCompactPath returns the path to the pending-compact breadcrumb file.
func pendingCompactPath(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", ".pending-compact.json")
}

// writePendingCompact writes a breadcrumb file so the next SessionStart
// can link the new Claude session back to the current master session.
func writePendingCompact(projectPath, taskSlug string) {
	sessionID := os.Getenv("CLAUDE_SESSION_ID")
	if sessionID == "" {
		return
	}

	pc := pendingCompact{
		ClaudeSessionID: sessionID,
		TaskSlug:        taskSlug,
		Timestamp:       time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(pc)
	if err != nil {
		return
	}
	if err := os.WriteFile(pendingCompactPath(projectPath), data, 0o600); err != nil {
		notifyUser("warning: breadcrumb write failed: %v", err)
	}
}

// parseSessionStatusFromContent extracts the status value from session.md content.
func parseSessionStatusFromContent(content string) string {
	return strings.TrimSpace(extractSection(content, "## Status"))
}

// warnLowVitalityMemories logs a warning for memories with very low vitality
// and no recent access. This is a read-only operation — memories are never
// auto-disabled (DEC-6).
func warnLowVitalityMemories(ctx context.Context, st *store.Store) {
	docs, err := st.ListLowVitality(ctx, 25, 50)
	if err != nil || len(docs) == 0 {
		return
	}

	// Filter to those not accessed in 180+ days.
	cutoff := time.Now().AddDate(0, 0, -180)
	var stale []store.LowVitalityDoc
	for _, d := range docs {
		lastDate := d.LastAccessed
		if lastDate == "" {
			lastDate = d.CrawledAt
		}
		if t, err := time.Parse(time.RFC3339, lastDate); err == nil && t.Before(cutoff) {
			stale = append(stale, d)
		}
	}

	if len(stale) == 0 {
		return
	}

	// Build warning with count and top 3 labels.
	labels := make([]string, 0, 3)
	for i, d := range stale {
		if i >= 3 {
			break
		}
		label := d.SectionPath
		if len([]rune(label)) > 60 {
			label = string([]rune(label)[:60]) + "..."
		}
		labels = append(labels, label)
	}

	notifyUser("%d memories with very low vitality (< 10) and no access in 180+ days: %s — consider reviewing via 'ledger action=stale'",
		len(stale), strings.Join(labels, "; "))
}

// researchPatterns are keywords indicating research/investigation activity in the session.
var researchPatterns = []string{
	"調査結果", "比較結果", "分析結果", "ベンチマーク結果", "競合調査",
	"investigate", "research findings", "benchmark results", "competitive analysis",
	"compared to", "analysis results", "key findings", "lessons learned",
}

// suggestKnowledgeSave checks if the session contains research patterns
// and emits a reminder to save knowledge before compaction.
func suggestKnowledgeSave(txCtx *transcriptContext) {
	// Combine user messages and assistant actions for pattern detection.
	var combined strings.Builder
	for _, msg := range txCtx.UserMessages {
		combined.WriteString(strings.ToLower(msg))
		combined.WriteByte(' ')
	}
	for _, action := range txCtx.AssistantActions {
		combined.WriteString(strings.ToLower(action))
		combined.WriteByte(' ')
	}
	text := combined.String()

	hits := 0
	for _, pattern := range researchPatterns {
		if strings.Contains(text, pattern) {
			hits++
		}
	}

	// Require 2+ pattern hits to reduce false positives.
	if hits < 2 {
		return
	}

	notifyUser("knowledge detected: this session contains research/analysis patterns. " +
		"Consider saving key findings with `ledger action=save` before context is compacted.")
}
