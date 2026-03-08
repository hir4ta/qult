package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// ---------------------------------------------------------------------------
// SessionStart: CLAUDE.md auto-ingest + spec context injection
// ---------------------------------------------------------------------------

// handleSessionStart ingests CLAUDE.md into the knowledge DB and injects
// spec context if an active spec exists.
func handleSessionStart(ctx context.Context, ev *hookEvent) {
	if ev.ProjectPath == "" {
		return
	}
	st, err := store.OpenDefaultCached()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] warning: store open failed: %v\n", err)
		debugf("hook store open failed: %v", err)
		return
	}
	ingestProjectClaudeMD(ctx, st, ev.ProjectPath)

	// Check if knowledge base needs refreshing (background crawl).
	checkAndSpawnCrawl(st)

	// Inject spec context if active spec exists.
	// After compact, inject richer context for full recovery.
	injectSpecContext(ctx, ev.ProjectPath, ev.Source, st)
}

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
func ingestProjectClaudeMD(ctx context.Context, st *store.Store, projectPath string) {
	claudeMD := filepath.Join(projectPath, "CLAUDE.md")
	content, err := os.ReadFile(claudeMD)
	if err != nil {
		debugf("ingestProjectClaudeMD: %s not found or unreadable, skipping", claudeMD)
		return
	}

	sections := splitMarkdownSections(string(content))
	if len(sections) == 0 {
		return
	}

	url := "project://" + projectPath + "/CLAUDE.md"
	for _, sec := range sections {
		if _, _, err := st.UpsertDoc(ctx, &store.DocRow{
			URL:         url,
			SectionPath: sec.Path,
			Content:     sec.Content,
			SourceType:  store.SourceProject,
			TTLDays:     1,
		}); err != nil {
			debugf("ingestProjectClaudeMD: upsert error: %v", err)
		}
	}
	debugf("ingestProjectClaudeMD: %d sections from %s", len(sections), claudeMD)
}

// injectSpecContext outputs spec content to stdout when an active
// spec exists. After compact, injects richer context
// (all 4 files) for full recovery. On normal startup, injects only session.md.
func injectSpecContext(ctx context.Context, projectPath, source string, st *store.Store) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		debugf("injectSpecContext: no active spec for %s", projectPath)
		return
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
		buf.WriteString(fmt.Sprintf("\n--- Alfred Protocol: Recovering Task '%s' (post-compact #%d) ---\n", taskSlug, compactCount))

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
			buf.WriteString("Lightweight recovery (use spec (action=status) or knowledge tool for full spec):\n\n")
			for _, f := range []spec.SpecFile{spec.FileSession} {
				content, err := sd.ReadFile(f)
				if err != nil || strings.TrimSpace(content) == "" {
					continue
				}
				buf.WriteString(fmt.Sprintf("### %s\n%s\n\n", f, content))
			}
		}

		buf.WriteString("--- End Alfred Protocol ---\n")
		emitAdditionalContext("SessionStart", buf.String())
		notifyUser("recovered task '%s' (compact #%d)", taskSlug, compactCount)
		debugf("SessionStart(compact#%d): injected spec context for %s", compactCount, taskSlug)
	} else {
		// Normal startup/resume: inject session.md + proactive knowledge for Next Steps.
		session, err := sd.ReadFile(spec.FileSession)
		if err != nil || session == "" {
			return
		}
		var buf strings.Builder
		buf.WriteString(fmt.Sprintf("\n--- Alfred Protocol: Active Task '%s' ---\n%s\n", taskSlug, session))

		// Proactive: extract Next Steps and pre-fetch relevant knowledge.
		if hints := proactiveHintsForNextSteps(ctx, session, st); hints != "" {
			buf.WriteString(hints)
		}

		// Proactive: search past memories relevant to the current task.
		if memHints := proactiveMemoryHints(ctx, taskSlug, session, st); memHints != "" {
			buf.WriteString(memHints)
		}

		buf.WriteString("--- End Alfred Protocol ---\n")
		emitAdditionalContext("SessionStart", buf.String())
		notifyUser("injected context for task '%s'", taskSlug)
		debugf("SessionStart(%s): injected session context for %s", source, taskSlug)
	}
}

// proactiveHintsForNextSteps extracts the "## Next Steps" section from session.md,
// detects Claude Code keywords in it, and pre-fetches relevant knowledge snippets.
// This makes alfred genuinely proactive: surfacing information before the user asks.
func proactiveHintsForNextSteps(ctx context.Context, session string, st *store.Store) string {
	// Extract Next Steps section.
	nextSteps := extractSection(session, "## Next Steps")
	if nextSteps == "" || len(strings.TrimSpace(nextSteps)) < 10 {
		return ""
	}

	// Detect Claude Code keywords in the next steps.
	matched := detectClaudeCodeKeywords(nextSteps)
	if len(matched) == 0 {
		return ""
	}

	if st == nil {
		return ""
	}

	// Search FTS with matched keywords.
	var ftsTerms []string
	for _, kw := range matched {
		if en, ok := store.KatakanaToEnglish[kw]; ok {
			ftsTerms = append(ftsTerms, en)
		} else {
			ftsTerms = append(ftsTerms, kw)
		}
	}
	ftsQuery := strings.Join(ftsTerms, " OR ")
	docs, _ := st.SearchDocsFTS(ctx, ftsQuery, store.SourceDocs, 3) // FTS failure is acceptable; no docs means no hints
	if len(docs) == 0 {
		return ""
	}

	var buf strings.Builder
	buf.WriteString("\n### Proactive: Relevant knowledge for your Next Steps\n")
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		fmt.Fprintf(&buf, "- [%s] %s\n", d.SectionPath, snippet)
	}
	debugf("SessionStart: proactive injection for next steps keywords=%v, docs=%d", matched, len(docs))
	return buf.String()
}

// proactiveMemoryHints searches past memories relevant to the current task
// and returns formatted hints for injection into the session context.
func proactiveMemoryHints(ctx context.Context, taskSlug, session string, st *store.Store) string {
	if st == nil {
		return ""
	}

	// Search memories using the task slug and current work context.
	workingOn := extractSection(session, "## Currently Working On")
	if workingOn == "" {
		workingOn = extractSection(session, "## Current Position")
	}
	query := taskSlug
	if workingOn != "" {
		query = taskSlug + " " + truncateStr(workingOn, 100)
	}

	docs, err := st.SearchDocsFTS(ctx, query, store.SourceMemory, 3)
	if err != nil || len(docs) == 0 {
		return ""
	}

	var buf strings.Builder
	buf.WriteString("\n### Past Experience: Related memories\n")
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		fmt.Fprintf(&buf, "- [%s] %s\n", d.SectionPath, snippet)
	}
	notifyUser("found %d related past experience(s)", len(docs))
	debugf("SessionStart: proactive memory injection for %s, docs=%d", taskSlug, len(docs))
	return buf.String()
}

// runEmbedAsync is the entry point for the embed-async subcommand.
// It generates embeddings for a single spec file with retry on transient failures.
// Called as a background process by asyncEmbedSession.
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

	// Timeout prevents zombie process if Voyage API is unresponsive.
	// 30s accommodates 3 retries with exponential backoff (0 + 2s + 4s = 6s wait + 3 API calls ~8s each).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			debugf("embed-async: retry attempt %d for %s/%s", attempt+1, taskSlug, fileName)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		if err := spec.SyncSingleFile(ctx, sd, sf, st, emb); err != nil {
			lastErr = err
			debugf("embed-async: attempt %d failed: %v", attempt+1, err)
			continue
		}
		debugf("embed-async: success for %s/%s", taskSlug, fileName)
		return nil
	}
	return fmt.Errorf("embed-async: all retries failed for %s/%s: %w", taskSlug, fileName, lastErr)
}

// asyncEmbedDoc spawns a background process to generate embeddings for a
// doc already stored in the docs table. This mirrors asyncEmbedSession but
// works with arbitrary doc IDs rather than spec files.
func asyncEmbedDoc(docID int64) {
	exe, err := os.Executable()
	if err != nil {
		debugf("asyncEmbedDoc: executable path error: %v", err)
		return
	}

	cmd := execCommand(exe, "embed-doc", "--id", fmt.Sprintf("%d", docID))
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		debugf("asyncEmbedDoc: start error: %v", err)
		return
	}
	debugf("asyncEmbedDoc: spawned pid=%d for doc_id=%d", cmd.Process.Pid, docID)
}

// runEmbedDoc is the entry point for the embed-doc subcommand.
// Generates embeddings for a single doc by ID with retry on transient failures.
func runEmbedDoc() error {
	var docID int64
	for i := 2; i < len(os.Args)-1; i++ {
		if os.Args[i] == "--id" {
			if _, err := fmt.Sscanf(os.Args[i+1], "%d", &docID); err != nil {
				return fmt.Errorf("invalid --id: %w", err)
			}
		}
	}
	if docID == 0 {
		return fmt.Errorf("usage: alfred embed-doc --id DOC_ID")
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

	docs, err := st.GetDocsByIDs(context.Background(), []int64{docID})
	if err != nil || len(docs) == 0 {
		return fmt.Errorf("doc not found: id=%d", docID)
	}
	doc := docs[0]

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	text := doc.SectionPath + "\n" + doc.Content

	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			debugf("embed-doc: retry attempt %d for doc_id=%d", attempt+1, docID)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		vec, err := emb.EmbedForStorage(ctx, text)
		if err != nil {
			lastErr = err
			debugf("embed-doc: attempt %d failed: %v", attempt+1, err)
			continue
		}
		if err := st.InsertEmbedding("docs", docID, emb.Model(), vec); err != nil {
			return fmt.Errorf("embed-doc: insert embedding: %w", err)
		}
		debugf("embed-doc: success for doc_id=%d", docID)
		return nil
	}
	return fmt.Errorf("embed-doc: all retries failed for doc_id=%d: %w", docID, lastErr)
}

// ---------------------------------------------------------------------------
// Background auto-crawl: refresh knowledge base periodically
// ---------------------------------------------------------------------------

// defaultCrawlIntervalDays is the default interval between automatic crawls.
const defaultCrawlIntervalDays = 7

// crawlIntervalDays returns the configured crawl interval from env or default.
func crawlIntervalDays() int {
	if v := os.Getenv("ALFRED_CRAWL_INTERVAL_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultCrawlIntervalDays
}

// checkAndSpawnCrawl checks the last crawl timestamp and spawns a background
// crawl process if the knowledge base is stale. This adds ~10-20ms to
// SessionStart (DB query + optional process spawn).
func checkAndSpawnCrawl(st *store.Store) {
	lastCrawl, err := st.LastCrawledAt()
	if err != nil {
		// No docs at all — user hasn't run 'alfred init' yet.
		debugf("checkAndSpawnCrawl: no crawl timestamp: %v", err)
		return
	}

	age := time.Since(lastCrawl)
	interval := time.Duration(crawlIntervalDays()) * 24 * time.Hour
	if age < interval {
		debugf("checkAndSpawnCrawl: last crawl %s ago (interval %dd), skipping", age.Round(time.Hour), crawlIntervalDays())
		return
	}

	// Prevent concurrent crawls via a lock file.
	lockPath := crawlLockPath()
	if lockPath == "" {
		debugf("checkAndSpawnCrawl: no lock path, skipping")
		return
	}
	if isCrawlRunning(lockPath) {
		debugf("checkAndSpawnCrawl: crawl already running")
		return
	}

	debugf("checkAndSpawnCrawl: last crawl %s ago, spawning background crawl", age.Round(time.Hour))
	spawnCrawlAsync()
}

// crawlLockPath returns the path to the crawl lock file.
// Returns "" if the home directory cannot be determined.
func crawlLockPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		debugf("crawlLockPath: no home dir: %v", err)
		return ""
	}
	return filepath.Join(home, ".claude-alfred", "crawl.lock")
}

// isCrawlRunning checks if a crawl process is already running by examining
// the lock file. Returns false if the lock file is stale (process exited).
func isCrawlRunning(lockPath string) bool {
	if lockPath == "" {
		return false
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return false
	}
	// Check if process is still alive.
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Unix, FindProcess always succeeds; send signal 0 to check liveness.
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		// Process not running — stale lock file.
		_ = os.Remove(lockPath)
		return false
	}
	return true
}

// spawnCrawlAsync spawns a detached background process to crawl and refresh docs.
// Writes the lock file before spawning to prevent TOCTOU races.
func spawnCrawlAsync() {
	lockPath := crawlLockPath()
	if lockPath == "" {
		debugf("spawnCrawlAsync: no lock path, skipping")
		return
	}

	exe, err := os.Executable()
	if err != nil {
		debugf("spawnCrawlAsync: executable path error: %v", err)
		return
	}

	// Write a placeholder lock file before spawning to prevent concurrent
	// sessions from both passing the isCrawlRunning check (TOCTOU).
	// The child process will overwrite with its own PID.
	if err := os.WriteFile(lockPath, []byte("spawning"), 0o600); err != nil {
		debugf("spawnCrawlAsync: lock write error: %v", err)
		return
	}

	cmd := execCommand(exe, "crawl-async")
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		_ = os.Remove(lockPath)
		debugf("spawnCrawlAsync: start error: %v", err)
		return
	}
	_ = cmd.Process.Release()
	notifyUser("refreshing knowledge base in background (pid=%d)", cmd.Process.Pid)
	debugf("spawnCrawlAsync: spawned pid=%d", cmd.Process.Pid)
}

// runCrawlAsync is the entry point for the crawl-async subcommand.
// It fetches fresh documentation and updates the knowledge base.
func runCrawlAsync() error {
	// Acquire lock file with our PID.
	lockPath := crawlLockPath()
	if lockPath == "" {
		return fmt.Errorf("crawl-async: cannot determine home directory")
	}
	if err := os.WriteFile(lockPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return fmt.Errorf("crawl-async: acquire lock: %w", err)
	}
	defer os.Remove(lockPath)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("crawl-async: open store: %w", err)
	}
	defer st.Close()

	// Clean up expired docs first.
	if n, err := st.DeleteExpiredDocs(ctx); err == nil && n > 0 {
		debugf("crawl-async: cleaned %d expired docs", n)
	}

	// Crawl fresh docs from live sources.
	debugf("crawl-async: starting live crawl")
	sf, err := install.Crawl(nil)
	if sf == nil {
		return fmt.Errorf("crawl-async: crawl failed: %w", err)
	}
	if err != nil {
		debugf("crawl-async: crawl warning: %v", err)
	}

	// Embedder is optional — FTS-only if VOYAGE_API_KEY not set.
	var emb *embedder.Embedder
	if e, err := embedder.NewEmbedder(); err == nil {
		emb = e
	}

	res, err := install.ApplySeedData(ctx, st, emb, sf, nil)
	if err != nil {
		return fmt.Errorf("crawl-async: apply seed: %w", err)
	}

	mode := "FTS-only"
	if emb != nil {
		mode = fmt.Sprintf("with %d embeddings", res.Embedded)
	}
	debugf("crawl-async: done — %d applied, %d unchanged (%s)", res.Applied, res.Unchanged, mode)
	return nil
}

// ---------------------------------------------------------------------------
// Stop (SessionEnd): session-summary memory persistence
// ---------------------------------------------------------------------------

// handleSessionEnd persists a session summary as permanent memory when the
// session ends. Reads the active spec's session.md and saves a condensed
// summary to the docs table with source_type="memory".
func handleSessionEnd(ctx context.Context, ev *hookEvent) {
	if ev.ProjectPath == "" {
		return
	}

	taskSlug, err := spec.ReadActive(ev.ProjectPath)
	if err != nil {
		debugf("SessionEnd: no active spec, skipping")
		return
	}

	sd := &spec.SpecDir{ProjectPath: ev.ProjectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return
	}

	session, err := sd.ReadFile(spec.FileSession)
	if err != nil || strings.TrimSpace(session) == "" {
		debugf("SessionEnd: no session.md content for %s", taskSlug)
		return
	}

	persistSessionSummary(ctx, ev.ProjectPath, taskSlug, session)
}

// persistSessionSummary saves a condensed session summary as permanent memory.
// Extracts key sections from session.md and stores as source_type="memory".
func persistSessionSummary(ctx context.Context, projectPath, taskSlug, session string) {
	// Check context before doing work — Stop hook has a tight 2.5s timeout.
	if ctx.Err() != nil {
		debugf("persistSessionSummary: context already expired, skipping")
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("persistSessionSummary: DB open error: %v", err)
		return
	}

	project := projectBaseName(projectPath)
	date := time.Now().Format("2006-01-02")
	url := fmt.Sprintf("memory://user/%s/%s/%s", project, taskSlug, date)

	// Build a condensed summary from session.md sections.
	summary := buildSessionSummary(session)
	if strings.TrimSpace(summary) == "" {
		debugf("persistSessionSummary: empty summary, skipping")
		return
	}

	sectionPath := fmt.Sprintf("%s > %s > session-summary > %s",
		project, taskSlug, truncateStr(extractSummaryTitle(session), 60))

	id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
		URL:         url,
		SectionPath: sectionPath,
		Content:     summary,
		SourceType:  store.SourceMemory,
		TTLDays:     0, // permanent
	})
	if err != nil {
		debugf("persistSessionSummary: upsert error: %v", err)
		return
	}
	if changed {
		notifyUser("saved session summary to memory (%s/%s)", project, taskSlug)
		asyncEmbedDoc(id)
		debugf("persistSessionSummary: saved session summary for %s/%s", project, taskSlug)
	}
}

// buildSessionSummary extracts key information from session.md into a
// condensed text suitable for memory storage and future search.
// Strips compact markers and cleans markdown noise before extraction.
func buildSessionSummary(session string) string {
	// Strip compact markers to avoid noise in the summary.
	cleaned := stripCompactMarkers(session)

	var buf strings.Builder

	workingOn := cleanSectionContent(extractSection(cleaned, "## Currently Working On"))
	if workingOn != "" {
		buf.WriteString("Working on: " + truncateStr(workingOn, 200) + "\n")
	}

	decisions := cleanSectionContent(extractSection(cleaned, "## Recent Decisions"))
	if decisions == "" {
		decisions = cleanSectionContent(extractSection(cleaned, "## Recent Decisions (last 3)"))
	}
	if decisions != "" {
		buf.WriteString("Decisions: " + truncateStr(decisions, 200) + "\n")
	}

	nextSteps := cleanSectionContent(extractSection(cleaned, "## Next Steps"))
	if nextSteps != "" {
		buf.WriteString("Next steps: " + truncateStr(nextSteps, 200) + "\n")
	}

	modifiedFiles := cleanSectionContent(extractSection(cleaned, "## Modified Files"))
	if modifiedFiles == "" {
		modifiedFiles = cleanSectionContent(extractSection(cleaned, "## Modified Files (this session)"))
	}
	if modifiedFiles != "" {
		buf.WriteString("Modified files: " + truncateStr(modifiedFiles, 200) + "\n")
	}

	return buf.String()
}

// stripCompactMarkers removes all "## Compact Marker [...]" sections and
// their content from session.md to prevent noise in summaries.
func stripCompactMarkers(session string) string {
	const marker = "## Compact Marker ["
	for {
		start := strings.Index(session, marker)
		if start < 0 {
			return session
		}
		// Find end: next "## " heading or "---" separator or EOF.
		rest := session[start+len(marker):]
		end := -1
		for _, delim := range []string{"\n## ", "\n---"} {
			if idx := strings.Index(rest, delim); idx >= 0 {
				if end < 0 || idx < end {
					end = idx
				}
			}
		}
		if end < 0 {
			// Marker extends to EOF.
			session = strings.TrimRight(session[:start], "\n")
		} else {
			session = session[:start] + rest[end+1:]
		}
	}
}

// cleanSectionContent removes markdown noise from extracted section content.
// Strips heading prefixes, collapses whitespace, and removes separators.
func cleanSectionContent(s string) string {
	if s == "" {
		return ""
	}
	var lines []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "---" {
			continue
		}
		// Strip markdown heading prefixes (e.g., "## Foo" → "Foo").
		for _, prefix := range []string{"### ", "## ", "# "} {
			if strings.HasPrefix(line, prefix) {
				line = line[len(prefix):]
				break
			}
		}
		// Strip bold markers.
		line = strings.ReplaceAll(line, "**", "")
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "; ")
}

// extractSummaryTitle creates a short title from the session's "Currently Working On" section.
func extractSummaryTitle(session string) string {
	workingOn := extractSection(session, "## Currently Working On")
	if workingOn == "" {
		return "session"
	}
	// Take the first line as title.
	if idx := strings.IndexByte(workingOn, '\n'); idx > 0 {
		workingOn = workingOn[:idx]
	}
	return strings.TrimSpace(workingOn)
}
