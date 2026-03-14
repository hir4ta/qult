package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
		notifyUser("warning: store open failed: %v", err)
		return
	}
	// Run independent operations in parallel to minimize timeout risk.
	// Both are fail-open (errors logged internally, never fatal).
	// Channel-based pattern respects context deadline (WaitGroup.Wait cannot).
	done := make(chan struct{}, 2)
	go func() { ingestProjectClaudeMD(ctx, st, ev.ProjectPath); done <- struct{}{} }()
	go func() { ensureUserRules(); done <- struct{}{} }()
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-ctx.Done():
			return
		}
	}

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
// each markdown section into the docs table for knowledge search.
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

	url := "project://" + projectPath + "/CLAUDE.md"
	for _, sec := range sections {
		_, _, _ = st.UpsertDoc(ctx, &store.DocRow{
			URL:         url,
			SectionPath: sec.Path,
			Content:     sec.Content,
			SourceType:  store.SourceProject,
			TTLDays:     1,
		})
	}
}

// injectSpecContext outputs spec content to stdout when an active
// spec exists. After compact, injects richer context
// (all 4 files) for full recovery. On normal startup, injects only session.md.
func injectSpecContext(ctx context.Context, projectPath, source string, st *store.Store) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
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
	} else {
		// Normal startup/resume: inject session.md only.
		session, err := sd.ReadFile(spec.FileSession)
		if err != nil || session == "" {
			return
		}
		var buf strings.Builder
		buf.WriteString(fmt.Sprintf("\n--- Alfred Protocol: Active Task '%s' ---\n%s\n", taskSlug, session))
		buf.WriteString("--- End Alfred Protocol ---\n")
		emitAdditionalContext("SessionStart", buf.String())
		notifyUser("injected context for task '%s'", taskSlug)
	}
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
// for multiple docs already stored in the docs table. Batching avoids
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

	docs, err := st.GetDocsByIDs(context.Background(), docIDs)
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
		text := doc.SectionPath + "\n" + doc.Content
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
		if err := st.InsertEmbedding("docs", docID, emb.Model(), vec); err != nil {
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
