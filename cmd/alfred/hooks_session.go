package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"encoding/json"

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
		notifyUser("warning: store open failed: %v", err)
		return
	}
	// Run independent operations in parallel to minimize timeout risk.
	// All are fail-open (errors logged internally, never fatal).
	done := make(chan struct{}, 3)
	go func() { ingestProjectClaudeMD(ctx, st, ev.ProjectPath); done <- struct{}{} }()
	go func() { ensureUserRules(); done <- struct{}{} }()
	go func() { syncKnowledgeIndex(ctx, st, ev.ProjectPath); done <- struct{}{} }()
	for range 3 {
		select {
		case <-done:
		case <-ctx.Done():
			return
		}
	}

	// Handle pending-compact breadcrumb for session continuity.
	handlePendingCompact(ctx, st, ev.ProjectPath)

	// Suggest /alfred:init if steering docs are missing (lightweight file stat, fail-open).
	if !spec.SteeringExists(ev.ProjectPath) {
		notifyUser("tip: run `/alfred:init` to set up project steering docs, templates, and knowledge index")
	}

	// V8: review_by removed; warnReviewDueMemories is a no-op stub.
	warnReviewDueMemories(ctx, st)

	// Suggest ledger reflect when knowledge base has grown but hasn't been reviewed.
	suggestLedgerReflect(ctx, st)

	// Inject spec context after parallel ops complete.
	// Must be serial: writes JSON to stdout (protocol integrity).
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
// each markdown section into the knowledge_index table for knowledge search.
// Silently skips if the file doesn't exist or is empty.
func ingestProjectClaudeMD(ctx context.Context, st *store.Store, projectPath string) {
	claudeMD := filepath.Join(projectPath, "CLAUDE.md")
	content, err := os.ReadFile(claudeMD)
	if err != nil {
		return
	}

	sections := splitMarkdownSections(string(content))
	if len(sections) == 0 {
		return
	}

	proj := store.DetectProject(projectPath)
	for _, sec := range sections {
		_, _, _ = st.UpsertKnowledge(ctx, &store.KnowledgeRow{
			FilePath:      "CLAUDE.md",
			Title:         sec.Path,
			Content:       sec.Content,
			SubType:       "project",
			ProjectRemote: proj.Remote,
			ProjectPath:   proj.Path,
			ProjectName:   proj.Name,
			Branch:        proj.Branch,
		})
	}
}

// handlePendingCompact reads the breadcrumb left by PreCompact and creates a
// session link from the current Claude session to the master session.
// This enables tracking conversation continuity across auto-compactions.
func handlePendingCompact(ctx context.Context, st *store.Store, projectPath string) {
	pcPath := pendingCompactPath(projectPath)
	data, err := os.ReadFile(pcPath)
	if err != nil {
		return // no breadcrumb — normal startup (not post-compact)
	}
	defer os.Remove(pcPath) // always clean up

	var pc pendingCompact
	if err := json.Unmarshal(data, &pc); err != nil {
		return
	}

	// Stale check: ignore breadcrumbs older than 5 minutes.
	if ts, err := time.Parse(time.RFC3339, pc.Timestamp); err == nil {
		if time.Since(ts) > 5*time.Minute {
			return
		}
	}

	currentSessionID := os.Getenv("CLAUDE_SESSION_ID")
	if currentSessionID == "" || currentSessionID == pc.ClaudeSessionID {
		return
	}

	// Resolve master: the old session may itself be linked to an earlier master.
	masterID := st.ResolveMasterSession(ctx, pc.ClaudeSessionID)

	proj := store.DetectProject(projectPath)
	if err := st.LinkSession(ctx, &store.SessionLink{
		ClaudeSessionID: currentSessionID,
		MasterSessionID: masterID,
		ProjectRemote:   proj.Remote,
		ProjectPath:     projectPath,
		TaskSlug:        pc.TaskSlug,
		Branch:          proj.Branch,
	}); err != nil {
		notifyUser("warning: session link failed: %v", err)
		return
	}

	notifyUser("linked session to master %s (compact continuity)", masterID[:min(8, len(masterID))])
}

// injectSpecContext outputs spec content to stdout when an active
// spec exists. After compact, injects richer context
// (all 4 files) for full recovery. On normal startup, injects only session.md.
func injectSpecContext(ctx context.Context, projectPath, source string, st *store.Store) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return
	}

	// Skip completed tasks — don't inject stale context.
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug && t.Status == spec.TaskCompleted {
				return
			}
		}
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
			for _, f := range spec.AllFiles {
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
	} else {
		// Normal startup/resume: adaptive context injection based on memory depth.
		session, err := sd.ReadFile(spec.FileSession)
		if err != nil || session == "" {
			return
		}

		var buf strings.Builder
		buf.WriteString(fmt.Sprintf("\n--- Alfred Protocol: Active Task '%s' ---\n", taskSlug))

		// Onboarding: adapt context depth based on project-scoped memory count.
		memoryCount := countProjectMemories(ctx, st, projectPath)
		switch {
		case memoryCount <= 5:
			// New project/user: inject core spec files for orientation.
			// For bugfix specs, read bugfix.md instead of requirements.md.
			buf.WriteString("(Full context — new project)\n\n")
			for _, f := range coreFilesForTask(projectPath, taskSlug) {
				content, err := sd.ReadFile(f)
				if err != nil || strings.TrimSpace(content) == "" {
					continue
				}
				buf.WriteString(fmt.Sprintf("### %s\n%s\n\n", f, content))
			}
		case memoryCount <= 20:
			// Growing: inject session + summary of requirements (or bugfix).
			buf.WriteString(session + "\n")
			if req, err := sd.ReadFile(primaryFileForTask(projectPath, taskSlug)); err == nil {
				if goal := extractGoalSection(req); goal != "" {
					buf.WriteString("\nGoal: " + goal + "\n")
				}
			}
		default:
			// Experienced: session.md only (lightweight).
			buf.WriteString(session + "\n")
		}

		buf.WriteString("--- End Alfred Protocol ---\n")
		emitAdditionalContext("SessionStart", buf.String())
		notifyUser("injected context for task '%s' (memories: %d)", taskSlug, memoryCount)
	}
}

// buildChapterTimeline queries stored chapter memories for the active task and
// returns a compact timeline showing what happened in each compact cycle.
// This enables Claude to understand the full session history even after many
// compactions, and to use the ledger tool for detailed context from any chapter.
func buildChapterTimeline(ctx context.Context, projectPath, taskSlug string, st *store.Store) string {
	if st == nil {
		return ""
	}
	project := projectBaseName(projectPath)
	chapterPrefix := fmt.Sprintf("%s > %s > chapter-", project, taskSlug)

	// Use ListKnowledge to find chapter memories scoped to this project.
	proj := store.DetectProject(projectPath)
	docs, err := st.ListKnowledge(ctx, proj.Remote, proj.Path, 200)
	if err != nil {
		return ""
	}

	// Deduplicate by chapter number. Use session-state docs for labels
	// (skip user-context docs which have less descriptive labels).
	type chapterEntry struct {
		num   int
		label string
	}
	seen := make(map[int]string) // chapterNum -> label
	for _, d := range docs {
		if !strings.HasPrefix(d.Title, chapterPrefix) {
			continue
		}
		rest := strings.TrimPrefix(d.Title, chapterPrefix)
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
	buf.WriteString("Previous session context is stored as permanent memory. Use the `ledger` tool to search for details from any chapter.\n\n")
	for _, ch := range chapters {
		label := ch.label
		if label == "" {
			label = "(no summary)"
		}
		fmt.Fprintf(&buf, "- **Chapter %d**: %s\n", ch.num, label)
	}
	buf.WriteString("\n")

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
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		if err := spec.SyncSingleFile(ctx, sd, sf, st, emb); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return fmt.Errorf("embed-async: all retries failed for %s/%s: %w", taskSlug, fileName, lastErr)
}

// asyncEmbedDocs spawns a single background process to generate embeddings
// for multiple docs already stored in the knowledge_index table. Batching avoids
// spawning N processes (and N Voyage API connections) per compact cycle.
func asyncEmbedDocs(docIDs []int64) {
	if len(docIDs) == 0 {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}

	args := []string{"embed-doc"}
	for _, id := range docIDs {
		args = append(args, "--id", fmt.Sprintf("%d", id))
	}
	cmd := execCommand(exe, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return
	}
	_ = cmd.Process.Release()
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

	docs, err := st.GetKnowledgeByIDs(context.Background(), docIDs)
	if err != nil {
		return fmt.Errorf("load docs: %w", err)
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
		text := doc.Title + "\n" + doc.Content
		if err := embedDocWithRetry(ctx, st, emb, doc.ID, text); err != nil {
			errs = append(errs, fmt.Sprintf("doc_id=%d: %v", doc.ID, err))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("embed-doc: %d/%d failed: %s", len(errs), len(docs), strings.Join(errs, "; "))
	}
	return nil
}

func embedDocWithRetry(ctx context.Context, st *store.Store, emb *embedder.Embedder, docID int64, text string) error {
	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		vec, err := emb.EmbedForStorage(ctx, text)
		if err != nil {
			lastErr = err
			continue
		}
		if err := st.InsertEmbedding("knowledge", docID, emb.Model(), vec); err != nil {
			return fmt.Errorf("insert embedding: %w", err)
		}
		return nil
	}
	return fmt.Errorf("all retries failed: %w", lastErr)
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
	_, _ = install.InstallUserRules() // best-effort
}

// countProjectMemories returns the number of knowledge entries scoped to the current project.
func countProjectMemories(ctx context.Context, st *store.Store, projectPath string) int64 {
	if st == nil {
		return 0
	}
	proj := store.DetectProject(projectPath)
	n, _ := st.CountKnowledge(ctx, proj.Remote, proj.Path)
	return n
}

// warnReviewDueMemories checks for memories past their review_by date
// and warns the user via stderr. Advisory only — does not affect search results.
// suggestLedgerReflect suggests running ledger reflect when the knowledge base
// has accumulated enough memories to benefit from a health check.
// Triggers when 20+ memories exist and the last reflect was >7 days ago (or never).
func suggestLedgerReflect(ctx context.Context, st *store.Store) {
	if st == nil {
		return
	}
	count, err := st.CountKnowledge(ctx, "", "")
	if err != nil || count < 20 {
		return
	}

	// Check if a recent reflect has been done (look for ledger-reflect audit entry).
	// If no audit system for reflect, use a simple file timestamp check.
	reflectMarker := filepath.Join(os.TempDir(), "alfred-last-reflect")
	if info, err := os.Stat(reflectMarker); err == nil {
		if time.Since(info.ModTime()) < 7*24*time.Hour {
			return // reflected recently
		}
	}

	notifyUser("knowledge health: %d memories in your knowledge base. Consider running `ledger action=reflect` for a health report (conflicts, stale items, promotion candidates).", count)
}

func warnReviewDueMemories(_ context.Context, _ *store.Store) {
	// V8: GetReviewDueMemories removed (review_by column no longer exists).
}

// extractGoalSection extracts the Goal section from requirements.md.
func extractGoalSection(content string) string {
	lines := strings.Split(content, "\n")
	inGoal := false
	var goal strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Match both "## Goal" (feature) and "## Bug Summary" (bugfix).
		if strings.HasPrefix(trimmed, "## Goal") || strings.HasPrefix(trimmed, "## Bug Summary") {
			inGoal = true
			continue
		}
		if inGoal && strings.HasPrefix(trimmed, "## ") {
			break
		}
		if inGoal && trimmed != "" && !strings.HasPrefix(trimmed, "<!--") {
			if goal.Len() > 0 {
				goal.WriteByte(' ')
			}
			goal.WriteString(trimmed)
		}
	}
	return goal.String()
}

// primaryFileForTask returns the primary spec file for a task (requirements.md or bugfix.md).
func primaryFileForTask(projectPath, taskSlug string) spec.SpecFile {
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug && t.EffectiveSpecType() == spec.TypeBugfix {
				return spec.FileBugfix
			}
		}
	}
	return spec.FileRequirements
}

// coreFilesForTask returns the core files list, substituting bugfix.md for requirements.md if needed.
func coreFilesForTask(projectPath, taskSlug string) []spec.SpecFile {
	if primaryFileForTask(projectPath, taskSlug) == spec.FileBugfix {
		return []spec.SpecFile{
			spec.FileBugfix,
			spec.FileDesign,
			spec.FileDecisions,
			spec.FileSession,
		}
	}
	return spec.CoreFiles
}

// syncKnowledgeIndex scans .alfred/knowledge/ for Markdown files and indexes
// new/changed files into the DB. Uses content_hash for change detection.
func syncKnowledgeIndex(ctx context.Context, st *store.Store, projectPath string) {
	files, err := store.ScanKnowledgeFiles(projectPath)
	if err != nil || len(files) == 0 {
		return
	}

	proj := store.DetectProject(projectPath)
	var synced int
	for _, relPath := range files {
		row, err := store.ParseKnowledgeFile(projectPath, relPath)
		if err != nil {
			continue
		}
		row.ProjectRemote = proj.Remote
		row.ProjectPath = proj.Path
		row.ProjectName = proj.Name
		row.Branch = proj.Branch

		_, changed, err := st.UpsertKnowledge(ctx, row)
		if err != nil {
			continue
		}
		if changed {
			synced++
		}
	}
	if synced > 0 {
		notifyUser("synced %d knowledge files to index", synced)
	}
}
