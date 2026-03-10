package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

	// Ensure rules are installed in ~/.claude/rules/ (auto-install on first run).
	ensureUserRules()

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

		// Inject chapter timeline: past compact snapshots stored as memories.
		// Enables recall of early session context even after 5+ compactions.
		if timeline := buildChapterTimeline(ctx, projectPath, taskSlug, st); timeline != "" {
			buf.WriteString(timeline)
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

		// Proactive hints: skip in quiet mode (spec context above is structural, always injected).
		if os.Getenv("ALFRED_QUIET") != "1" {
			// Proactive: extract Next Steps and pre-fetch relevant knowledge.
			if hints := proactiveHintsForNextSteps(ctx, session, st); hints != "" {
				buf.WriteString(hints)
			}

			// Proactive: search past memories relevant to the current task.
			if memHints := proactiveMemoryHints(ctx, taskSlug, session, st); memHints != "" {
				buf.WriteString(memHints)
			}

			// Proactive: search memories from other projects for cross-project patterns.
			currentProject := projectBaseName(projectPath)
			if crossHints := proactiveCrossProjectHints(ctx, currentProject, taskSlug, session, st); crossHints != "" {
				buf.WriteString(crossHints)
			}
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
		if en, ok := store.TranslateTerm(kw); ok {
			ftsTerms = append(ftsTerms, en)
		} else {
			ftsTerms = append(ftsTerms, kw)
		}
	}
	ftsQuery := store.JoinFTS5Terms(ftsTerms)
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
	workingOn := extractSectionFallback(session, "## Currently Working On", "## Current Position")
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

// buildChapterTimeline queries stored chapter memories for the active task and
// returns a compact timeline showing what happened in each compact cycle.
// This enables Claude to understand the full session history even after many
// compactions, and to use the recall tool for detailed context from any chapter.
func buildChapterTimeline(ctx context.Context, projectPath, taskSlug string, st *store.Store) string {
	if st == nil {
		return ""
	}
	project := projectBaseName(projectPath)
	chapterPrefix := fmt.Sprintf("%s > %s > chapter-", project, taskSlug)

	// Use URL prefix search instead of FTS to avoid tokenization issues,
	// duplicate entries from multi-section chapters, and result cap limits.
	urlPrefix := fmt.Sprintf("memory://user/%s/%s/chapter-", project, taskSlug)
	docs, err := st.SearchDocsByURLPrefix(ctx, urlPrefix, 200)
	if err != nil {
		debugf("buildChapterTimeline: URL prefix search error: %v", err)
		return ""
	}

	// Deduplicate by chapter number. Use session-state docs for labels
	// (skip user-context docs which have less descriptive labels).
	type chapterEntry struct {
		num   int
		label string
	}
	seen := make(map[int]string) // chapterNum → label
	for _, d := range docs {
		if !strings.HasPrefix(d.SectionPath, chapterPrefix) {
			continue
		}
		rest := strings.TrimPrefix(d.SectionPath, chapterPrefix)
		parts := strings.SplitN(rest, " > ", 2)
		num := 0
		fmt.Sscanf(parts[0], "%d", &num)
		if num == 0 {
			continue
		}
		// Prefer session-state label over user-context label.
		label := ""
		if len(parts) > 1 {
			label = parts[1]
		}
		if _, exists := seen[num]; !exists || !strings.HasPrefix(label, "user-context-") {
			if !strings.HasPrefix(label, "user-context-") {
				seen[num] = label
			}
		}
	}

	if len(seen) == 0 {
		return ""
	}

	// Collect and sort by chapter number.
	chapters := make([]chapterEntry, 0, len(seen))
	for num, label := range seen {
		chapters = append(chapters, chapterEntry{num: num, label: label})
	}
	sort.Slice(chapters, func(i, j int) bool { return chapters[i].num < chapters[j].num })

	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("\n### Session Timeline (%d past compact cycles)\n", len(chapters)))
	buf.WriteString("Previous session context is stored as permanent memory. Use the `recall` tool to search for details from any chapter.\n\n")
	for _, ch := range chapters {
		label := ch.label
		if label == "" {
			label = "(no summary)"
		}
		fmt.Fprintf(&buf, "- **Chapter %d**: %s\n", ch.num, label)
	}
	buf.WriteString("\n")

	debugf("buildChapterTimeline: %d chapters for %s/%s", len(chapters), project, taskSlug)
	return buf.String()
}

// proactiveCrossProjectHints searches memories from other projects for patterns
// relevant to the current task. Returns formatted hint string or "".
func proactiveCrossProjectHints(ctx context.Context, currentProject, taskSlug string, session string, st *store.Store) string {
	if st == nil {
		return ""
	}

	// Build a search query from current work context.
	workingOn := extractSectionFallback(session, "## Currently Working On", "## Current Position")
	nextSteps := extractSection(session, "## Next Steps")

	// Combine task slug with context keywords for a meaningful search.
	query := taskSlug
	if workingOn != "" {
		query += " " + truncateStr(workingOn, 80)
	}
	if nextSteps != "" {
		query += " " + truncateStr(nextSteps, 80)
	}
	if len(strings.TrimSpace(query)) < 5 {
		return ""
	}

	// Search memories broadly (fetch extra to allow filtering).
	docs, err := st.SearchDocsFTS(ctx, query, store.SourceMemory, 10)
	if err != nil || len(docs) == 0 {
		return ""
	}

	// Filter out results from the current project.
	// Memory URLs are like: memory://user/{project}/{task-slug}/{date}
	// Section paths are like: {project} > {task-slug} > session-summary > ...
	currentPrefix := currentProject + " > "
	var crossDocs []store.DocRow
	for _, d := range docs {
		if strings.HasPrefix(d.SectionPath, currentPrefix) {
			continue
		}
		crossDocs = append(crossDocs, d)
		if len(crossDocs) >= 2 {
			break
		}
	}
	if len(crossDocs) == 0 {
		return ""
	}

	var buf strings.Builder
	buf.WriteString("\n### Cross-project insights\n")
	for _, d := range crossDocs {
		// Extract project name from section_path (first segment before " > ").
		project := d.SectionPath
		if idx := strings.Index(project, " > "); idx > 0 {
			project = project[:idx]
		}
		snippet := safeSnippet(d.Content, 200)
		fmt.Fprintf(&buf, "- [%s] %s\n", project, snippet)
	}
	debugf("SessionStart: cross-project memory injection, docs=%d", len(crossDocs))
	return buf.String()
}

// runEmbedAsync is the entry point for the embed-async subcommand.
// It generates embeddings for a single spec file with retry on transient failures.
// Called as a background process by asyncEmbedSession.
func runEmbedAsync() error {
	var projectPath, taskSlug, fileName string
	for i := 2; i < len(os.Args); i++ {
		if i+1 >= len(os.Args) {
			break
		}
		switch os.Args[i] {
		case "--project":
			i++
			projectPath = os.Args[i]
		case "--task":
			i++
			taskSlug = os.Args[i]
		case "--file":
			i++
			fileName = os.Args[i]
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
	st.ExpectedDims = emb.Dims()

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

// asyncEmbedDocs spawns a single background process to generate embeddings
// for multiple docs already stored in the docs table. Batching avoids
// spawning N processes (and N Voyage API connections) per compact cycle.
func asyncEmbedDocs(docIDs []int64) {
	if len(docIDs) == 0 {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		debugf("asyncEmbedDocs: executable path error: %v", err)
		return
	}

	args := []string{"embed-doc"}
	for _, id := range docIDs {
		args = append(args, "--id", fmt.Sprintf("%d", id))
	}
	cmd := execCommand(exe, args...)
	cmd.Stdout = nil
	// Route child stderr to a log file so failures are diagnosable without ALFRED_DEBUG.
	logW := asyncEmbedLogWriter()
	cmd.Stderr = logW
	if err := cmd.Start(); err != nil {
		if logW != nil {
			logW.Close()
		}
		debugf("asyncEmbedDocs: start error: %v", err)
		return
	}
	// Close parent's copy — the child inherited its own fd via fork/exec.
	if logW != nil {
		logW.Close()
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	debugf("asyncEmbedDocs: spawned pid=%d for %d doc(s)", pid, len(docIDs))
}

// runEmbedDoc is the entry point for the embed-doc subcommand.
// Generates embeddings for one or more docs by ID with retry on transient failures.
// Accepts multiple --id flags: alfred embed-doc --id 1 --id 2 --id 3
func runEmbedDoc() error {
	var docIDs []int64
	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "--id" {
			if i+1 >= len(os.Args) {
				return fmt.Errorf("--id requires a value")
			}
			i++
			var id int64
			if _, err := fmt.Sscanf(os.Args[i], "%d", &id); err != nil {
				return fmt.Errorf("invalid --id %q: %w", os.Args[i], err)
			}
			docIDs = append(docIDs, id)
		}
	}
	if len(docIDs) == 0 {
		return fmt.Errorf("usage: alfred embed-doc --id DOC_ID [--id DOC_ID ...]")
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
	st.ExpectedDims = emb.Dims()

	docs, err := st.GetDocsByIDs(context.Background(), docIDs)
	if err != nil {
		return fmt.Errorf("load docs: %w", err)
	}
	if len(docs) < len(docIDs) {
		debugf("embed-doc: requested %d docs, found %d (some may have been deleted)", len(docIDs), len(docs))
	}

	// Timeout scales with batch size: 30s base + 10s per additional doc.
	timeout := 30*time.Second + time.Duration(max(len(docs)-1, 0))*10*time.Second
	if timeout > 5*time.Minute {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var errs []string
	for _, doc := range docs {
		text := doc.SectionPath + "\n" + doc.Content
		if err := embedDocWithRetry(ctx, st, emb, doc.ID, text); err != nil {
			errs = append(errs, fmt.Sprintf("doc_id=%d: %v", doc.ID, err))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("embed-doc: %d/%d failed: %s", len(errs), len(docs), strings.Join(errs, "; "))
	}
	debugf("embed-doc: all %d docs embedded successfully", len(docs))
	return nil
}

func embedDocWithRetry(ctx context.Context, st *store.Store, emb *embedder.Embedder, docID int64, text string) error {
	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			debugf("embed-doc: retry attempt %d for doc_id=%d", attempt+1, docID)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		vec, err := emb.EmbedForStorage(ctx, text)
		if err != nil {
			lastErr = err
			debugf("embed-doc: attempt %d failed for doc_id=%d: %v", attempt+1, docID, err)
			continue
		}
		if err := st.InsertEmbedding("docs", docID, emb.Model(), vec); err != nil {
			return fmt.Errorf("insert embedding: %w", err)
		}
		debugf("embed-doc: success for doc_id=%d", docID)
		return nil
	}
	return fmt.Errorf("all retries failed: %w", lastErr)
}

// ---------------------------------------------------------------------------
// Background auto-crawl: refresh knowledge base periodically
// ---------------------------------------------------------------------------

// defaultCrawlIntervalDays is the default interval between automatic crawls.
const defaultCrawlIntervalDays = 7

// crawlIntervalDays returns the configured crawl interval from env or default.
func crawlIntervalDays() int {
	return envInt("ALFRED_CRAWL_INTERVAL_DAYS", defaultCrawlIntervalDays)
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
	// Rely on isCrawlRunning (PID check + stale cleanup) + O_EXCL in spawnCrawlAsync.
	// lockFileExists was redundant and could race with isCrawlRunning's stale removal.
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

// crawlLockMaxAge is the maximum age for a crawl lock file before it is
// considered stale, regardless of PID liveness. Prevents PID reuse false positives.
const crawlLockMaxAge = 6 * time.Minute

// isCrawlRunning checks if a crawl process is already running by examining
// the lock file. Returns false if the lock file is stale (process exited or
// lock file exceeds crawlLockMaxAge to guard against PID reuse).
func isCrawlRunning(lockPath string) bool {
	if lockPath == "" {
		return false
	}
	info, err := os.Stat(lockPath)
	if err != nil {
		return false
	}
	// Guard against PID reuse: if the lock file is older than the crawl
	// timeout, the original process is certainly gone regardless of PID.
	if time.Since(info.ModTime()) > crawlLockMaxAge {
		_ = os.Remove(lockPath)
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

	// Atomic lock acquisition: O_CREATE|O_EXCL fails if file already exists,
	// preventing TOCTOU races between isCrawlRunning() and lock creation.
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		debugf("spawnCrawlAsync: lock acquire failed (concurrent session?): %v", err)
		return
	}

	cmd := execCommand(exe, "crawl-async")
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		_ = f.Close()
		_ = os.Remove(lockPath)
		debugf("spawnCrawlAsync: start error: %v", err)
		return
	}
	pid := cmd.Process.Pid
	// Write actual PID immediately so isCrawlRunning() can detect the process.
	_, _ = fmt.Fprintf(f, "%d", pid)
	_ = f.Close()
	_ = cmd.Process.Release()
	notifyUser("refreshing knowledge base in background (pid=%d)", pid)
	debugf("spawnCrawlAsync: spawned pid=%d", pid)
}

// runCrawlAsync is the entry point for the crawl-async subcommand.
// It fetches fresh documentation and updates the knowledge base.
func runCrawlAsync() error {
	// The parent (spawnCrawlAsync) already created the lock file with our PID
	// via O_CREATE|O_EXCL. We only need to clean it up on exit.
	lockPath := crawlLockPath()
	if lockPath == "" {
		return fmt.Errorf("crawl-async: cannot determine home directory")
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

	// Crawl fresh docs from live sources (with conditional requests).
	debugf("crawl-async: starting live crawl")
	// Load custom sources from project config if available.
	var customSources []install.CustomSource
	cwd, _ := os.Getwd()
	if cfg := loadProjectConfig(cwd); cfg != nil {
		for _, cs := range cfg.CustomSources {
			customSources = append(customSources, install.CustomSource{URL: cs.URL, Label: cs.Label})
		}
	}
	// Also load global custom sources from ~/.claude-alfred/sources.json.
	if globalSources := loadGlobalCustomSources(); len(globalSources) > 0 {
		customSources = append(customSources, globalSources...)
	}
	sf, crawlStats, err := install.Crawl(ctx, nil, st, customSources)
	if sf == nil {
		return fmt.Errorf("crawl-async: crawl failed: %w", err)
	}
	if err != nil {
		debugf("crawl-async: crawl warning: %v", err)
	}
	if crawlStats != nil {
		debugf("crawl-async: fetched %d, skipped %d (304)", crawlStats.Fetched, crawlStats.NotModified)
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
// SessionEnd: session-summary memory persistence
// ---------------------------------------------------------------------------

// handleSessionEnd persists a session summary as permanent memory when the
// session ends. Reads the active spec's session.md and saves a condensed
// summary to the docs table with source_type="memory".
func handleSessionEnd(ctx context.Context, ev *hookEvent) {
	if ev.ProjectPath == "" {
		return
	}

	// Skip memory persistence when user intentionally clears the session.
	if ev.Reason == "clear" {
		debugf("SessionEnd: reason=clear, skipping memory persistence")
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
		asyncEmbedDocs([]int64{id})
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

	workingOn := cleanSectionContent(extractSectionFallback(cleaned, "## Currently Working On", "## Current Position"))
	if workingOn != "" {
		buf.WriteString("Working on: " + truncateStr(workingOn, 200) + "\n")
	}

	decisions := cleanSectionContent(extractSectionFallback(cleaned, "## Recent Decisions", "## Recent Decisions (last 3)"))
	if decisions != "" {
		buf.WriteString("Decisions: " + truncateStr(decisions, 200) + "\n")
	}

	nextSteps := cleanSectionContent(extractSectionFallback(cleaned, "## Next Steps", "## Pending"))
	if nextSteps != "" {
		buf.WriteString("Next steps: " + truncateStr(nextSteps, 200) + "\n")
	}

	modifiedFiles := cleanSectionContent(extractSectionFallback(cleaned, "## Modified Files", "## Modified Files (this session)"))
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

// ensureUserRules checks if alfred rules are installed in ~/.claude/rules/
// and installs them if missing. This ensures rules work even when only
// /plugin install was run (without alfred init).
func ensureUserRules() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	// Quick check: if any alfred-*.md rule file exists, skip.
	rulesDir := filepath.Join(home, ".claude", "rules")
	entries, err := os.ReadDir(rulesDir)
	if err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "alfred-") && strings.HasSuffix(e.Name(), ".md") {
				return
			}
		}
	}
	// No alfred rules found — install them.
	n, err := install.InstallUserRules()
	if err != nil {
		debugf("ensureUserRules: %v", err)
		return
	}
	if n > 0 {
		debugf("ensureUserRules: installed %d rule files", n)
	}
}
