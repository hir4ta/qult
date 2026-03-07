package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// handlePreCompact saves session state before context compaction.
// This is the core of compact resilience — it reads the conversation transcript
// to extract key context (recent user messages, decisions, blockers) and saves
// them to session.md before the context is summarized.
func handlePreCompact(projectPath, transcriptPath, customInstructions string) {
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

	// Extract recent conversation context from transcript.
	var contextSnapshot string
	if transcriptPath != "" {
		contextSnapshot = extractTranscriptContext(transcriptPath)
	} else {
		fmt.Fprintf(os.Stderr, "[alfred] warning: transcript_path is empty — session context will not be captured\n")
		debugf("PreCompact: transcript_path is empty")
	}
	if contextSnapshot == "" && transcriptPath != "" {
		fmt.Fprintf(os.Stderr, "[alfred] warning: could not extract context from transcript\n")
		debugf("PreCompact: empty context from transcript %s", transcriptPath)
	}

	// Extract decisions from transcript.
	var decisions []string
	if transcriptPath != "" {
		decisions = extractDecisionsFromTranscript(transcriptPath)
	}

	// Get modified files from git.
	modifiedFiles := getModifiedFiles(projectPath)

	// Build activeContext session.md.
	session := buildActiveContextSession(sd, taskSlug, contextSnapshot, decisions, modifiedFiles, customInstructions)
	if err := sd.WriteFile(spec.FileSession, session); err != nil {
		debugf("PreCompact: write session error: %v", err)
		return
	}

	// Sync session.md to DB (without embedder — hook is short-lived).
	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("PreCompact: DB open error: %v", err)
		return
	}
	if err := spec.SyncSingleFile(context.Background(), sd, spec.FileSession, st, nil); err != nil {
		debugf("PreCompact: sync error: %v", err)
		return
	}

	// Emit spec-aware compaction instructions to stdout.
	emitCompactionInstructions(sd, taskSlug)

	// Async embedding generation for session.md.
	asyncEmbedSession(sd)

	debugf("PreCompact: saved session for %s (context: %d bytes)", taskSlug, len(contextSnapshot))
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
	buf.WriteString(fmt.Sprintf("[Butler Protocol] Active task: %s\n", taskSlug))
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
	if err := cmd.Start(); err != nil {
		debugf("asyncEmbedSession: start error: %v", err)
		return
	}
	// Wait in background and log result.
	go func() {
		if err := cmd.Wait(); err != nil {
			debugf("asyncEmbedSession: pid=%d error: %v", cmd.Process.Pid, err)
		} else {
			debugf("asyncEmbedSession: pid=%d completed", cmd.Process.Pid)
		}
	}()
	debugf("asyncEmbedSession: spawned pid=%d for %s/%s", cmd.Process.Pid, sd.TaskSlug, spec.FileSession)
}

// ---------------------------------------------------------------------------
// Decision extraction from transcript
// ---------------------------------------------------------------------------

// trivialVerbs are verbs that follow decision keywords but indicate
// routine actions rather than real design decisions.
var trivialVerbs = []string{
	"read ", "check ", "look ", "run ", "open ", "try ", "start ",
	"continue ", "proceed ", "skip ", "move ", "fix ", "update ",
	"install ", "build ", "test ", "debug ", "print ", "log ",
	"add ", "remove ", "delete ", "rename ", "import ", "copy ",
	"format ", "lint ", "commit ", "push ", "pull ", "merge ",
	"revert ", "rebase ",
}

// rationaleMarkers indicate the sentence contains a reason/justification,
// which strongly suggests a real design decision.
var rationaleMarkers = []string{
	"because ", "since ", "due to ", "given that ", "in order to ",
	"so that ", "for better ", "to ensure ", "to avoid ", "to reduce ",
	"to improve ", "to support ", "for the sake of ",
}

// alternativeMarkers indicate the sentence compares options,
// which is a strong signal for a design decision.
var alternativeMarkers = []string{
	" over ", " instead of ", " rather than ", " vs ", " versus ",
	" compared to ", " as opposed to ",
}

// architectureTerms boost confidence when the sentence mentions design concepts.
var architectureTerms = []string{
	"architecture", "pattern", "approach", "strategy", "trade-off",
	"tradeoff", "schema", "interface", "protocol", "abstraction",
	"design", "api ", "migration", "infrastructure",
}

// scoreDecisionConfidence returns a confidence score (0.0-1.0) for whether
// a sentence represents a real design decision vs an implementation action.
func scoreDecisionConfidence(sentence string) float64 {
	lower := strings.ToLower(sentence)
	score := 0.4 // base score for having a decision keyword

	// Rationale clause: strong positive signal.
	for _, marker := range rationaleMarkers {
		if strings.Contains(lower, marker) {
			score += 0.25
			break
		}
	}

	// Alternative comparison: strong positive signal.
	for _, marker := range alternativeMarkers {
		if strings.Contains(lower, marker) {
			score += 0.3
			break
		}
	}

	// Architecture vocabulary: moderate positive signal.
	for _, term := range architectureTerms {
		if strings.Contains(lower, term) {
			score += 0.15
			break
		}
	}

	// Code artifact penalty: backticks, file paths, camelCase.
	if strings.Contains(sentence, "`") {
		score -= 0.15
	}
	if strings.Contains(sentence, "/") && strings.Contains(sentence, ".") {
		// Likely a file path like "src/main.go".
		score -= 0.1
	}

	// Hedging words penalty: "just", "simply", "quickly".
	for _, hedge := range []string{"just ", "simply ", "quickly ", "also "} {
		if strings.Contains(lower, hedge) {
			score -= 0.1
			break
		}
	}

	return min(max(score, 0), 1.0)
}

// isTrivialDecision returns true if the sentence describes a routine action
// rather than a meaningful design/architecture decision.
func isTrivialDecision(sentence string) bool {
	lower := strings.ToLower(sentence)
	for _, v := range trivialVerbs {
		// Check if a trivial verb follows a decision keyword.
		for _, kw := range []string{"decided to ", "chose to ", "going to "} {
			if strings.Contains(lower, kw+v) {
				return true
			}
		}
	}
	// Too short to be a real decision.
	if len(sentence) < 30 {
		return true
	}
	return false
}

// extractDecisionsFromTranscript scans the transcript for meaningful design decisions
// from the assistant. Uses keyword matching + structured pattern detection + trivial filtering.
func extractDecisionsFromTranscript(transcriptPath string) []string {
	data, err := readFileTail(transcriptPath, 64*1024)
	if err != nil {
		return nil
	}

	// Keyword patterns that indicate design decisions (not routine actions).
	decisionKeywords := []string{
		"decided to ", "chose ", "going with ", "selected ",
		"decision: ", "we'll use ", "opting for ",
		"settled on ", "choosing ", "picked ",
	}

	// Structured patterns from spec format or explicit decision markers.
	structuredPrefixes := []string{
		"**chosen:**", "**decision:**", "**selected:**",
		"- chosen: ", "- decision: ", "- selected: ",
	}

	type scoredDecision struct {
		text       string
		confidence float64
	}
	var decisions []scoredDecision
	for _, line := range strings.Split(string(data), "\n") {
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
		if role != "assistant" && entry.Type != "assistant" {
			continue
		}

		text := extractTextContent(entry)
		if text == "" {
			continue
		}
		textLower := strings.ToLower(text)

		// Strategy 1: Structured patterns (high confidence = 0.9).
		for _, prefix := range structuredPrefixes {
			idx := strings.Index(textLower, prefix)
			if idx < 0 {
				continue
			}
			rest := strings.TrimSpace(text[idx+len(prefix):])
			end := strings.IndexAny(rest, "\n")
			if end < 0 {
				end = min(len(rest), 200)
			}
			value := strings.TrimSpace(rest[:end])
			if len(value) > 5 {
				decisions = append(decisions, scoredDecision{value, 0.9})
			}
			break
		}

		// Strategy 2: Keyword matching with confidence scoring.
		for _, kw := range decisionKeywords {
			idx := strings.Index(textLower, kw)
			if idx < 0 {
				continue
			}
			start := strings.LastIndexAny(text[:idx], ".!?\n") + 1
			end := strings.IndexAny(text[idx:], ".!?\n")
			if end < 0 {
				end = min(len(text)-idx, 200)
			}
			sentence := strings.TrimSpace(text[start : idx+end])
			if len(sentence) > 10 && len(sentence) < 300 && !isTrivialDecision(sentence) {
				conf := scoreDecisionConfidence(sentence)
				if conf >= 0.4 {
					decisions = append(decisions, scoredDecision{sentence, conf})
				}
			}
			break // one decision per entry
		}
	}

	// Deduplicate, keeping the highest confidence version.
	seen := make(map[string]int) // key -> index in unique
	var unique []scoredDecision
	for _, d := range decisions {
		key := strings.ToLower(d.text)
		if len(key) > 80 {
			key = key[:80]
		}
		if idx, ok := seen[key]; ok {
			if d.confidence > unique[idx].confidence {
				unique[idx] = d
			}
		} else {
			seen[key] = len(unique)
			unique = append(unique, d)
		}
	}

	// Sort by confidence descending, keep last 5.
	sort.Slice(unique, func(i, j int) bool {
		return unique[i].confidence > unique[j].confidence
	})
	if len(unique) > 5 {
		unique = unique[:5]
	}

	result := make([]string, len(unique))
	for i, d := range unique {
		result[i] = d.text
	}
	return result
}

// getModifiedFiles returns a list of files modified in the current git working tree.
func getModifiedFiles(projectPath string) []string {
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

// buildActiveContextSession constructs session.md in activeContext format.
// It preserves existing content before any Compact Marker, then rebuilds
// the structured sections with fresh data.
func buildActiveContextSession(sd *spec.SpecDir, taskSlug, contextSnapshot string, decisions, modifiedFiles []string, customInstructions string) string {
	existing, _ := sd.ReadFile(spec.FileSession)

	// Extract existing structured fields from session.md.
	// Supports both new activeContext format and legacy format.
	existingStatus := extractSection(existing, "## Status")
	existingWorkingOn := extractSection(existing, "## Currently Working On")
	if existingWorkingOn == "" {
		// Legacy format fallback.
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

	// Build "Currently Working On" from recent assistant actions in transcript.
	workingOn := existingWorkingOn
	if contextSnapshot != "" {
		// Extract the most recent assistant action as "currently working on".
		inAssistantSection := false
		for _, line := range strings.Split(contextSnapshot, "\n") {
			if line == "Recent assistant actions:" {
				inAssistantSection = true
				continue
			}
			if !strings.HasPrefix(line, "- ") && strings.TrimSpace(line) != "" {
				inAssistantSection = false
			}
			if inAssistantSection && strings.HasPrefix(line, "- ") {
				workingOn = strings.TrimPrefix(line, "- ")
			}
		}
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
	buf.WriteString("\n")

	// Add compact marker.
	buf.WriteString(fmt.Sprintf("## Compact Marker [%s]\n", time.Now().Format("2006-01-02 15:04:05")))
	if customInstructions != "" {
		buf.WriteString(fmt.Sprintf("User compact instructions: %s\n", customInstructions))
	}
	if contextSnapshot != "" {
		buf.WriteString("### Pre-Compact Context Snapshot\n")
		buf.WriteString(contextSnapshot)
		buf.WriteString("\n")
	}
	buf.WriteString("---\n")

	return rotateCompactMarkers(buf.String(), 3)
}

// ---------------------------------------------------------------------------
// Transcript context extraction
// ---------------------------------------------------------------------------

// extractTranscriptContext reads the tail of a conversation transcript and
// extracts the most valuable context: recent user messages, assistant summaries,
// and tool errors that would otherwise be lost during compaction.
func extractTranscriptContext(transcriptPath string) string {
	// Read last 64KB of transcript (conversation can be huge).
	data, err := readFileTail(transcriptPath, 64*1024)
	if err != nil {
		debugf("PreCompact: read transcript error: %v", err)
		return ""
	}

	lines := strings.Split(string(data), "\n")

	var userMessages []string
	var assistantSummaries []string
	var toolErrors []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		var entry transcriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		text := extractTextContent(entry)
		if text == "" {
			continue
		}

		switch {
		case entry.Type == "human" || entry.Role == "user" ||
			(entry.Message.Role == "user"):
			// Keep last 5 user messages.
			userMessages = append(userMessages, truncateStr(text, 200))
			if len(userMessages) > 5 {
				userMessages = userMessages[len(userMessages)-5:]
			}
		case entry.Type == "assistant" || entry.Role == "assistant" ||
			(entry.Message.Role == "assistant"):
			// Keep last 3 assistant summaries (first 150 chars only).
			summary := truncateStr(text, 150)
			assistantSummaries = append(assistantSummaries, summary)
			if len(assistantSummaries) > 3 {
				assistantSummaries = assistantSummaries[len(assistantSummaries)-3:]
			}
		case entry.Type == "tool_error" || entry.Type == "error":
			toolErrors = append(toolErrors, truncateStr(text, 150))
			if len(toolErrors) > 3 {
				toolErrors = toolErrors[len(toolErrors)-3:]
			}
		}
	}

	var buf strings.Builder
	if len(userMessages) > 0 {
		buf.WriteString("Recent user requests:\n")
		for _, m := range userMessages {
			buf.WriteString("- " + m + "\n")
		}
	}
	if len(assistantSummaries) > 0 {
		buf.WriteString("Recent assistant actions:\n")
		for _, s := range assistantSummaries {
			buf.WriteString("- " + s + "\n")
		}
	}
	if len(toolErrors) > 0 {
		buf.WriteString("Recent errors (dead ends):\n")
		for _, e := range toolErrors {
			buf.WriteString("- " + e + "\n")
		}
	}
	return buf.String()
}
