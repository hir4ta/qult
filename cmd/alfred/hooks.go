package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// execCommand is a variable so tests can stub it out.
var execCommand = exec.Command

// debugWriter is set when ALFRED_DEBUG is non-empty.
// Log file: ~/.claude-alfred/debug.log
var debugWriter io.Writer

func init() {
	if os.Getenv("ALFRED_DEBUG") == "" {
		return
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".claude-alfred")
	_ = os.MkdirAll(dir, 0755)
	f, err := os.OpenFile(filepath.Join(dir, "debug.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	debugWriter = f
}

func debugf(format string, args ...any) {
	if debugWriter == nil {
		return
	}
	fmt.Fprintf(debugWriter, time.Now().Format("15:04:05.000")+" "+format+"\n", args...)
}

// hookEvent is the minimal structure of a Claude Code hook stdin payload.
// Fields are populated depending on the event type:
//   - SessionStart: ProjectPath, Source, TranscriptPath
//   - PreCompact:   ProjectPath, TranscriptPath, Trigger, CustomInstructions
//   - PreToolUse:   ProjectPath, ToolName, ToolInput
//   - UserPromptSubmit: ProjectPath, Prompt
type hookEvent struct {
	ProjectPath        string         `json:"cwd"`
	Source             string         `json:"source"`              // SessionStart: startup/resume/clear/compact
	TranscriptPath     string         `json:"transcript_path"`     // path to conversation JSONL
	Trigger            string         `json:"trigger"`             // PreCompact: manual/auto
	CustomInstructions string         `json:"custom_instructions"` // PreCompact: user's /compact instructions
	ToolName           string         `json:"tool_name"`
	ToolInput          map[string]any `json:"tool_input"`
	Prompt             string         `json:"prompt"`
}

// configReminder is the additionalContext message injected when Claude Code
// accesses configuration files or the user's prompt mentions them.
const configReminder = `This task involves Claude Code configuration. alfred's MCP tools have specialized, up-to-date knowledge:
- knowledge: Best practices for .claude/ files, CLAUDE.md, hooks, skills, rules, agents, MCP
- review: Project-wide .claude/ configuration audit
Call these BEFORE reading or modifying configuration files directly.`

// runHook handles hook events.
func runHook(event string) error {
	debugf("hook event=%s", event)
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		debugf("hook decode error: %v", err)
		return nil
	}
	debugf("hook project=%s", ev.ProjectPath)

	switch event {
	case "SessionStart":
		if ev.ProjectPath != "" {
			st, err := store.OpenDefaultCached()
			if err != nil {
				debugf("hook store open failed: %v", err)
				return nil
			}
			ingestProjectClaudeMD(st, ev.ProjectPath)

			// Inject spec context if active spec exists.
			// After compact, inject richer context for full recovery.
			injectButlerContext(ev.ProjectPath, ev.Source)
		}
	case "PreCompact":
		if ev.ProjectPath != "" {
			handlePreCompact(ev.ProjectPath, ev.TranscriptPath, ev.CustomInstructions)
		}
	case "PreToolUse":
		handlePreToolUse(&ev)
	case "UserPromptSubmit":
		handleUserPromptSubmit(&ev)
	}

	return nil
}

// ---------------------------------------------------------------------------
// PreToolUse: .claude/ config access reminder
// ---------------------------------------------------------------------------

// isClaudeConfigPath reports whether path refers to a Claude Code configuration
// file or directory (.claude/, CLAUDE.md, MEMORY.md, .mcp.json).
func isClaudeConfigPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ".claude/") ||
		strings.Contains(lower, "claude.md") ||
		strings.Contains(lower, "memory.md") ||
		strings.Contains(lower, ".mcp.json")
}

// shouldRemind reports whether a tool's input targets Claude Code configuration.
// Checks file_path (Read/Edit/Write), path (Grep/Glob), and pattern (Glob).
func shouldRemind(toolInput map[string]any) bool {
	for _, key := range []string{"file_path", "path", "pattern"} {
		if v, ok := toolInput[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				if isClaudeConfigPath(s) {
					return true
				}
			}
		}
	}
	return false
}

// handlePreToolUse emits a reminder when Claude accesses .claude/ config files.
func handlePreToolUse(ev *hookEvent) {
	if !shouldRemind(ev.ToolInput) {
		return
	}
	debugf("PreToolUse: reminding about alfred for %v", ev.ToolInput)
	fmt.Print(configReminder)
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: Claude Code config keyword detection
// ---------------------------------------------------------------------------

// shouldRemindPrompt reports whether the user's prompt mentions Claude Code
// configuration paths (.claude, CLAUDE.md, MEMORY.md, .mcp.json).
func shouldRemindPrompt(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, term := range []string{".claude", "claude.md", "memory.md", ".mcp.json"} {
		if strings.Contains(lower, term) {
			return true
		}
	}
	return false
}

// domainSynonyms maps user terms to related knowledge base terms for query expansion.
var domainSynonyms = map[string][]string{
	"hook":        {"hooks", "lifecycle", "event handler", "PreToolUse", "SessionStart", "PreCompact"},
	"hooks":       {"hook", "lifecycle", "event handler"},
	"mcp":         {"model context protocol", "tool server", "MCP server"},
	"compact":     {"compaction", "context window", "token limit", "PreCompact"},
	"compaction":  {"compact", "context window", "PreCompact"},
	"rule":        {"rules", "instructions", "glob patterns"},
	"rules":       {"rule", "instructions", "glob patterns"},
	"skill":       {"skills", "slash command", "SKILL.md"},
	"skills":      {"skill", "slash command", "SKILL.md"},
	"memory":      {"MEMORY.md", "auto memory", "persistence", "context"},
	"agent":       {"agents", "subagent", "custom agent"},
	"agents":      {"agent", "subagent", "custom agent"},
	"config":      {"configuration", "CLAUDE.md", ".claude/", "settings"},
	"configure":   {"configuration", "CLAUDE.md", ".claude/", "setup"},
	"setup":       {"configure", "initialize", "wizard"},
	"worktree":    {"worktrees", "git worktree", "isolation"},
	"review":      {"code review", "audit", "inspect"},
	"spec":        {"specification", "butler protocol", "requirements"},
	"embed":       {"embedding", "vector", "semantic search"},
	"embedding":   {"embed", "vector", "semantic search"},
	"search":      {"FTS", "full text search", "vector search", "hybrid"},
	"test":        {"testing", "test runner"},
	"debug":       {"debugging", "troubleshoot", "ALFRED_DEBUG"},
	"permission":  {"permissions", "allowed tools", "security"},
	"permissions": {"permission", "allowed tools", "security"},
}

// expandQuery adds domain synonyms to a keyword query for better FTS recall.
func expandQuery(keywords string) string {
	words := strings.Fields(keywords)
	var expanded []string
	expanded = append(expanded, words...)
	for _, w := range words {
		if syns, ok := domainSynonyms[strings.ToLower(w)]; ok {
			// Add up to 2 synonyms to avoid overly broad queries.
			for i, s := range syns {
				if i >= 2 {
					break
				}
				expanded = append(expanded, s)
			}
		}
	}
	return strings.Join(expanded, " ")
}

// extractSearchKeywords extracts meaningful keywords from a prompt for FTS search.
// Filters out common stop words and short words, returns up to maxWords.
func extractSearchKeywords(prompt string, maxWords int) string {
	stopWords := map[string]bool{
		"the": true, "a": true, "an": true, "is": true, "are": true,
		"was": true, "were": true, "be": true, "been": true, "being": true,
		"have": true, "has": true, "had": true, "do": true, "does": true,
		"did": true, "will": true, "would": true, "could": true, "should": true,
		"may": true, "might": true, "can": true, "this": true, "that": true,
		"these": true, "those": true, "with": true, "from": true, "into": true,
		"for": true, "and": true, "but": true, "not": true, "what": true,
		"how": true, "when": true, "where": true, "which": true, "who": true,
		"about": true, "some": true, "want": true, "need": true, "like": true,
		"make": true, "just": true, "also": true, "more": true, "very": true,
		"please": true, "help": true, "using": true, "used": true, "use": true,
	}

	var keywords []string
	for _, word := range strings.Fields(strings.ToLower(prompt)) {
		// Strip punctuation.
		word = strings.Trim(word, ".,!?;:\"'`()[]{}/-")
		if len(word) < 3 || stopWords[word] {
			continue
		}
		keywords = append(keywords, word)
		if len(keywords) >= maxWords {
			break
		}
	}
	return strings.Join(keywords, " ")
}

// scoreRelevance computes a relevance score (0.0-1.0) between a prompt and a document.
// Uses section_path matching, content keyword overlap with position weighting,
// and coverage bonus for multiple distinct keyword matches.
func scoreRelevance(promptLower string, doc store.DocRow) float64 {
	promptWords := strings.Fields(promptLower)
	if len(promptWords) == 0 {
		return 0
	}

	// Filter to meaningful words (4+ chars, not stop words).
	var meaningful []string
	for _, w := range promptWords {
		if len(w) >= 4 {
			meaningful = append(meaningful, w)
		}
	}
	if len(meaningful) == 0 {
		return 0
	}

	// Section path match: high value signal.
	pathLower := strings.ToLower(doc.SectionPath)
	pathHits := 0
	for _, w := range meaningful {
		if strings.Contains(pathLower, w) {
			pathHits++
		}
	}
	pathScore := float64(pathHits) * 0.25

	// Content match with position weighting.
	contentLower := strings.ToLower(doc.Content)
	firstLine := contentLower
	if idx := strings.IndexByte(firstLine, '\n'); idx > 0 {
		firstLine = firstLine[:idx]
	}

	contentHits := 0
	earlyHits := 0 // matches in first line get bonus
	for _, w := range meaningful {
		if strings.Contains(contentLower, w) {
			contentHits++
			if strings.Contains(firstLine, w) {
				earlyHits++
			}
		}
	}

	coverage := float64(contentHits) / float64(len(meaningful))
	earlyBonus := float64(earlyHits) * 0.1

	// Coverage bonus: reward matching multiple distinct keywords.
	coverageBonus := 0.0
	if contentHits >= 3 {
		coverageBonus = 0.15
	} else if contentHits >= 2 {
		coverageBonus = 0.05
	}

	return min(pathScore+coverage+earlyBonus+coverageBonus, 1.0)
}

// handleUserPromptSubmit emits config reminders and proactively injects
// relevant knowledge from the FTS index based on the user's prompt.
func handleUserPromptSubmit(ev *hookEvent) {
	if shouldRemindPrompt(ev.Prompt) {
		debugf("UserPromptSubmit: reminding about alfred for prompt")
		fmt.Print(configReminder)
		return // config reminder is sufficient, skip knowledge injection
	}

	// Proactive knowledge injection: search FTS for relevant best practices.
	prompt := strings.TrimSpace(ev.Prompt)
	if len([]rune(prompt)) < 10 {
		return // too short to search meaningfully (rune-based for CJK)
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("UserPromptSubmit: store open failed: %v", err)
		return
	}

	// Strategy 1: Search with extracted keywords + synonym expansion.
	keywords := extractSearchKeywords(prompt, 8)
	var allDocs []store.DocRow

	if keywords != "" {
		expanded := expandQuery(keywords)
		docs, err := st.SearchDocsFTS(expanded, "", 5)
		if err == nil {
			allDocs = append(allDocs, docs...)
		}
	}

	// Strategy 2: Search with raw prompt (catches phrase matches).
	rawQuery := prompt
	if len(rawQuery) > 150 {
		rawQuery = rawQuery[:150]
	}
	docs, err := st.SearchDocsFTS(rawQuery, "", 3)
	if err == nil {
		allDocs = append(allDocs, docs...)
	}

	if len(allDocs) == 0 {
		debugf("UserPromptSubmit: FTS search returned 0 results")
		return
	}

	// Deduplicate by doc ID.
	seen := make(map[int64]bool)
	var uniqueDocs []store.DocRow
	for _, d := range allDocs {
		if !seen[d.ID] {
			seen[d.ID] = true
			uniqueDocs = append(uniqueDocs, d)
		}
	}

	// Score and filter by relevance.
	promptLower := strings.ToLower(prompt)
	type scored struct {
		doc   store.DocRow
		score float64
	}
	var candidates []scored
	for _, doc := range uniqueDocs {
		s := scoreRelevance(promptLower, doc)
		if s >= 0.15 {
			candidates = append(candidates, scored{doc, s})
		}
	}
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches (all below threshold)")
		return
	}

	// Sort by score descending, take top 2.
	for i := 0; i < len(candidates)-1; i++ {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].score > candidates[i].score {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}
	if len(candidates) > 2 {
		candidates = candidates[:2]
	}

	var buf strings.Builder
	buf.WriteString("Relevant best practices from alfred knowledge base:\n")
	for _, c := range candidates {
		snippet := c.doc.Content
		if len(snippet) > 300 {
			snippet = snippet[:300] + "..."
		}
		fmt.Fprintf(&buf, "- [%s] %s\n", c.doc.SectionPath, snippet)
	}
	fmt.Print(buf.String())
	debugf("UserPromptSubmit: injected %d knowledge snippets (scores: %.2f+)", len(candidates), candidates[0].score)
}

// ---------------------------------------------------------------------------
// SessionStart: CLAUDE.md auto-ingest
// ---------------------------------------------------------------------------

type mdSection struct {
	Path    string
	Content string
}

// splitMarkdownSections splits markdown by ## headers (or # for root).
func splitMarkdownSections(md string) []mdSection {
	lines := strings.Split(md, "\n")
	var sections []mdSection
	var currentPath string
	var buf strings.Builder

	flush := func() {
		content := strings.TrimSpace(buf.String())
		if currentPath != "" && content != "" {
			sections = append(sections, mdSection{Path: currentPath, Content: content})
		}
		buf.Reset()
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			flush()
			currentPath = strings.TrimSpace(strings.TrimPrefix(line, "## "))
		} else if strings.HasPrefix(line, "# ") && currentPath == "" {
			currentPath = strings.TrimSpace(strings.TrimPrefix(line, "# "))
		} else {
			if currentPath != "" {
				buf.WriteString(line)
				buf.WriteByte('\n')
			}
		}
	}
	flush()
	return sections
}

// ingestProjectClaudeMD reads CLAUDE.md from the project root and upserts
// each markdown section into the docs table for knowledge search.
// Silently skips if the file doesn't exist or is empty.
func ingestProjectClaudeMD(st *store.Store, projectPath string) {
	claudeMD := filepath.Join(projectPath, "CLAUDE.md")
	content, err := os.ReadFile(claudeMD)
	if err != nil {
		return // CLAUDE.md doesn't exist or unreadable — silently skip
	}

	sections := splitMarkdownSections(string(content))
	if len(sections) == 0 {
		return
	}

	url := "project://" + projectPath + "/CLAUDE.md"
	for _, sec := range sections {
		st.UpsertDoc(&store.DocRow{
			URL:         url,
			SectionPath: sec.Path,
			Content:     sec.Content,
			SourceType:  "project",
			TTLDays:     1,
		})
	}
	debugf("ingestProjectClaudeMD: %d sections from %s", len(sections), claudeMD)
}

// ---------------------------------------------------------------------------
// PreCompact: spec session persistence
// ---------------------------------------------------------------------------

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
	// Detach — don't wait for completion.
	go func() { _ = cmd.Wait() }()
	debugf("asyncEmbedSession: spawned pid=%d for %s/%s", cmd.Process.Pid, sd.TaskSlug, spec.FileSession)
}

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
	for i := 0; i < len(unique)-1; i++ {
		for j := i + 1; j < len(unique); j++ {
			if unique[j].confidence > unique[i].confidence {
				unique[i], unique[j] = unique[j], unique[i]
			}
		}
	}
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

// extractSection extracts the content under a ## heading until the next ## heading.
func extractSection(content, heading string) string {
	lines := strings.Split(content, "\n")
	var result []string
	inSection := false
	for _, line := range lines {
		if line == heading || strings.HasPrefix(line, heading+" ") {
			inSection = true
			continue
		}
		if inSection && strings.HasPrefix(line, "## ") {
			break
		}
		if inSection {
			result = append(result, line)
		}
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

// extractListItems extracts numbered or bulleted list items from a section.
func extractListItems(content, heading string) []string {
	section := extractSection(content, heading)
	if section == "" {
		return nil
	}
	var items []string
	for _, line := range strings.Split(section, "\n") {
		trimmed := strings.TrimSpace(line)
		// Strip leading "1. ", "2. ", "- " etc.
		if len(trimmed) > 2 {
			if trimmed[0] >= '0' && trimmed[0] <= '9' {
				if idx := strings.Index(trimmed, ". "); idx >= 0 && idx < 4 {
					items = append(items, trimmed[idx+2:])
					continue
				}
			}
			if strings.HasPrefix(trimmed, "- ") {
				items = append(items, trimmed[2:])
			}
		}
	}
	return items
}

// transcriptEntry represents a single line from the Claude Code conversation JSONL.
type transcriptEntry struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []ContentBlock
	Message struct {
		Role    string `json:"role"`
		Content any    `json:"content"`
	} `json:"message"`
}

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

// extractTextContent extracts readable text from a transcript entry.
// Handles both string content and structured content blocks.
func extractTextContent(entry transcriptEntry) string {
	// Try direct content field.
	if s, ok := entry.Content.(string); ok && s != "" {
		return s
	}
	// Try message.content field.
	if s, ok := entry.Message.Content.(string); ok && s != "" {
		return s
	}
	// Try content blocks (array of {type, text}).
	if blocks, ok := entry.Content.([]any); ok {
		for _, b := range blocks {
			if block, ok := b.(map[string]any); ok {
				if text, ok := block["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	if blocks, ok := entry.Message.Content.([]any); ok {
		for _, b := range blocks {
			if block, ok := b.(map[string]any); ok {
				if text, ok := block["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	return ""
}

// readFileTail reads the last n bytes of a file.
func readFileTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	size := info.Size()
	if size <= n {
		return os.ReadFile(path)
	}

	buf := make([]byte, n)
	_, err = f.ReadAt(buf, size-n)
	if err != nil {
		return nil, err
	}

	// Skip to first complete line.
	if idx := strings.IndexByte(string(buf), '\n'); idx >= 0 {
		buf = buf[idx+1:]
	}
	return buf, nil
}

// truncateStr truncates a string to maxLen runes, adding "..." if truncated.
func truncateStr(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	// Remove newlines for single-line output.
	s = strings.ReplaceAll(s, "\n", " ")
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// ---------------------------------------------------------------------------
// SessionStart: spec context injection
// ---------------------------------------------------------------------------

// injectButlerContext outputs spec content to stdout when an active
// spec exists. After compact, injects richer context
// (all 4 files) for full recovery. On normal startup, injects only session.md.
func injectButlerContext(projectPath, source string) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return // no active spec — silently skip
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return
	}

	if source == "compact" {
		// Adaptive recovery: count compact markers to decide injection depth.
		session, _ := sd.ReadFile(spec.FileSession)
		compactCount := strings.Count(session, "## Compact Marker [")

		var buf strings.Builder
		buf.WriteString(fmt.Sprintf("\n--- Butler Protocol: Recovering Task '%s' (post-compact #%d) ---\n", taskSlug, compactCount))

		if compactCount <= 1 {
			// First compact: inject all spec files for full context recovery.
			buf.WriteString("Full context recovery (first compact):\n\n")
			recoveryOrder := []spec.SpecFile{
				spec.FileSession,
				spec.FileRequirements,
				spec.FileDesign,
				spec.FileDecisions,
			}
			for _, f := range recoveryOrder {
				content, err := sd.ReadFile(f)
				if err != nil || strings.TrimSpace(content) == "" {
					continue
				}
				buf.WriteString(fmt.Sprintf("### %s\n%s\n\n", f, content))
			}
		} else {
			// Subsequent compacts: inject only session.md (lightweight).
			buf.WriteString("Lightweight recovery (use spec-status or knowledge tool for full spec):\n\n")
			for _, f := range []spec.SpecFile{spec.FileSession} {
				content, err := sd.ReadFile(f)
				if err != nil || strings.TrimSpace(content) == "" {
					continue
				}
				buf.WriteString(fmt.Sprintf("### %s\n%s\n\n", f, content))
			}
		}

		buf.WriteString("--- End Butler Protocol ---\n")
		fmt.Fprint(os.Stdout, buf.String())
		debugf("SessionStart(compact#%d): injected butler context for %s", compactCount, taskSlug)
	} else {
		// Normal startup/resume: inject session.md only (lightweight).
		session, err := sd.ReadFile(spec.FileSession)
		if err != nil || session == "" {
			return
		}
		fmt.Fprintf(os.Stdout, "\n--- Butler Protocol: Active Task '%s' ---\n%s\n--- End Butler Protocol ---\n", taskSlug, session)
		debugf("SessionStart(%s): injected session context for %s", source, taskSlug)
	}
}

// runEmbedAsync is the entry point for the embed-async subcommand.
// It generates embeddings for a single spec file. Called as a background process by asyncEmbedSession.
func runEmbedAsync() error {
	var projectPath, taskSlug, fileName string
	for i := 2; i < len(os.Args)-1; i++ {
		switch os.Args[i] {
		case "--project":
			projectPath = os.Args[i+1]
		case "--task":
			taskSlug = os.Args[i+1]
		case "--file":
			fileName = os.Args[i+1]
		}
	}
	if projectPath == "" || taskSlug == "" || fileName == "" {
		return fmt.Errorf("usage: alfred embed-async --project PATH --task SLUG --file FILE")
	}

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	emb, err := embedder.NewEmbedder()
	if err != nil {
		return fmt.Errorf("embedder: %w", err)
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	sf := spec.SpecFile(fileName)
	return spec.SyncSingleFile(context.Background(), sd, sf, st, emb)
}
