# Butler Protocol Implementation Plan

> **For Claude:** この計画をタスクごとに順番に実装してください。

**Goal:** alfredにbutler-protocol機能を追加し、`.alfred/specs/`ベースのspec管理でCompact/セッション間のコンテキスト喪失に強い開発ワークフローを実現する。

**Architecture:** MCPツール4つ(butler-init/butler-update/butler-status/butler-review) + Hook拡張(PreCompact/SessionStart) + rules(butler-protocol) + skills(brainstorm/refine/plan)。ファイル(.alfred/specs/)をsource of truthとし、SQLite DBにセマンティック検索インデックスを同期するハイブリッド構成。

**Tech Stack:** Go 1.25 / SQLite (ncruces/go-sqlite3) / Voyage AI (voyage-4-large, 2048d) / MCP (mcp-go) / YAML

**核心思想:** Compactで最も失われやすい「推論過程」「設計判断の理由」「探索の死に筋」「暗黙の合意」を、開発の流れの中で自律的にファイルに書き出し、DBにインデックスし、セッション復帰時に自動復元する。

---

## Task 1: specファイル管理パッケージ（internal/spec/）

specファイルの読み書き・パース・バリデーションを担当する新パッケージ。

**Files:**
- Create: `internal/spec/spec.go`
- Create: `internal/spec/spec_test.go`

**Step 1: specデータ構造の定義**

```go
// internal/spec/spec.go
package spec

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SpecFile はspecディレクトリ内の個別ファイルを表す
type SpecFile string

const (
	FileRequirements SpecFile = "requirements.md"
	FileDesign       SpecFile = "design.md"
	FileTasks        SpecFile = "tasks.md"
	FileDecisions    SpecFile = "decisions.md"
	FileKnowledge    SpecFile = "knowledge.md"
	FileSession      SpecFile = "session.md"
)

var AllFiles = []SpecFile{
	FileRequirements, FileDesign, FileTasks,
	FileDecisions, FileKnowledge, FileSession,
}

// ActiveSpec は _active.md の内容
type ActiveSpec struct {
	TaskSlug  string    `json:"task_slug"`
	StartedAt time.Time `json:"started_at"`
}

// SpecDir はプロジェクトの .alfred/specs/{task-slug}/ を操作する
type SpecDir struct {
	ProjectPath string // プロジェクトルート
	TaskSlug    string
}

// RootDir returns .alfred/ path
func RootDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred")
}

// SpecsDir returns .alfred/specs/ path
func SpecsDir(projectPath string) string {
	return filepath.Join(RootDir(projectPath), "specs")
}

// Dir returns the spec directory for this task
func (s *SpecDir) Dir() string {
	return filepath.Join(SpecsDir(s.ProjectPath), s.TaskSlug)
}

// FilePath returns absolute path of a spec file
func (s *SpecDir) FilePath(f SpecFile) string {
	return filepath.Join(s.Dir(), string(f))
}

// ActivePath returns .alfred/specs/_active.md path
func ActivePath(projectPath string) string {
	return filepath.Join(SpecsDir(projectPath), "_active.md")
}

// ProjectMDPath returns .alfred/project.md path
func ProjectMDPath(projectPath string) string {
	return filepath.Join(RootDir(projectPath), "project.md")
}
```

**Step 2: Init/Read/Write/Append操作**

```go
// Init creates the spec directory with template files
func Init(projectPath, taskSlug, description string) (*SpecDir, error) {
	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	if err := os.MkdirAll(sd.Dir(), 0o755); err != nil {
		return nil, fmt.Errorf("create spec dir: %w", err)
	}

	templates := map[SpecFile]string{
		FileRequirements: fmt.Sprintf("# Requirements: %s\n\n## Goal\n\n%s\n\n## Success Criteria\n\n- [ ] \n\n## Out of Scope\n\n- \n", taskSlug, description),
		FileDesign:       fmt.Sprintf("# Design: %s\n\n## Architecture\n\n\n\n## Tech Decisions\n\n\n", taskSlug),
		FileTasks:        fmt.Sprintf("# Tasks: %s\n\n- [ ] \n", taskSlug),
		FileDecisions:    fmt.Sprintf("# Decisions: %s\n\n<!-- Format:\n## [YYYY-MM-DD] Decision Title\n- **Chosen:** option\n- **Alternatives:** A, B\n- **Reason:** why\n-->\n", taskSlug),
		FileKnowledge:    fmt.Sprintf("# Knowledge: %s\n\n<!-- Format:\n## Discovery Title\n- **Finding:** what\n- **Context:** when/where\n- **Dead ends:** what didn't work and why\n-->\n", taskSlug),
		FileSession:      fmt.Sprintf("# Session: %s\n\n## Status\nactive\n\n## Current Position\nTask just initialized.\n\n## What I Was Doing\n\n\n## Next Steps\n\n- [ ] \n\n## Key Context for Resumption\n\n\n## Modified Files\n\n\n## Unresolved Issues\n\n\n", taskSlug),
	}

	for f, content := range templates {
		path := sd.FilePath(f)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", f, err)
		}
	}

	// Update _active.md
	active := fmt.Sprintf("task: %s\nstarted_at: %s\n", taskSlug, time.Now().Format(time.RFC3339))
	if err := os.MkdirAll(SpecsDir(projectPath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(ActivePath(projectPath), []byte(active), 0o644); err != nil {
		return nil, fmt.Errorf("write _active.md: %w", err)
	}

	return sd, nil
}

// ReadFile reads a spec file's content
func (s *SpecDir) ReadFile(f SpecFile) (string, error) {
	data, err := os.ReadFile(s.FilePath(f))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// WriteFile replaces a spec file's content entirely
func (s *SpecDir) WriteFile(f SpecFile, content string) error {
	return os.WriteFile(s.FilePath(f), []byte(content), 0o644)
}

// AppendFile appends content to a spec file
func (s *SpecDir) AppendFile(f SpecFile, content string) error {
	existing, err := s.ReadFile(f)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if !strings.HasSuffix(existing, "\n") && existing != "" {
		existing += "\n"
	}
	return s.WriteFile(f, existing+content+"\n")
}

// ReadActive reads the current active task slug
func ReadActive(projectPath string) (string, error) {
	data, err := os.ReadFile(ActivePath(projectPath))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "task: ") {
			return strings.TrimPrefix(line, "task: "), nil
		}
	}
	return "", fmt.Errorf("no active task found")
}

// Exists checks if the spec directory exists
func (s *SpecDir) Exists() bool {
	info, err := os.Stat(s.Dir())
	return err == nil && info.IsDir()
}

// AllSections returns all spec files as sections for DB indexing
type Section struct {
	File    SpecFile
	Content string
	URL     string // spec://{project}/{task}/{file}
}

func (s *SpecDir) AllSections() ([]Section, error) {
	var sections []Section
	for _, f := range AllFiles {
		content, err := s.ReadFile(f)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		sections = append(sections, Section{
			File:    f,
			Content: content,
			URL:     fmt.Sprintf("spec://%s/%s/%s", filepath.Base(s.ProjectPath), s.TaskSlug, f),
		})
	}
	return sections, nil
}
```

**Step 3: テスト**

```go
// internal/spec/spec_test.go
package spec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitCreatesAllFiles(t *testing.T) {
	dir := t.TempDir()
	sd, err := Init(dir, "add-auth", "Add authentication to the API")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range AllFiles {
		path := sd.FilePath(f)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			t.Errorf("expected file %s to exist", f)
		}
	}
	// Check _active.md
	slug, err := ReadActive(dir)
	if err != nil {
		t.Fatal(err)
	}
	if slug != "add-auth" {
		t.Errorf("expected active task 'add-auth', got %q", slug)
	}
}

func TestAppendFile(t *testing.T) {
	dir := t.TempDir()
	sd, err := Init(dir, "test-task", "Test")
	if err != nil {
		t.Fatal(err)
	}
	err = sd.AppendFile(FileDecisions, "## 2026-03-05 Use PostgreSQL\n- **Chosen:** PostgreSQL\n- **Alternatives:** MySQL, SQLite\n- **Reason:** Better JSON support\n")
	if err != nil {
		t.Fatal(err)
	}
	content, _ := sd.ReadFile(FileDecisions)
	if !strings.Contains(content, "Use PostgreSQL") {
		t.Error("appended content not found")
	}
}

func TestAllSections(t *testing.T) {
	dir := t.TempDir()
	sd, err := Init(dir, "test-sections", "Test")
	if err != nil {
		t.Fatal(err)
	}
	sections, err := sd.AllSections()
	if err != nil {
		t.Fatal(err)
	}
	if len(sections) != len(AllFiles) {
		t.Errorf("expected %d sections, got %d", len(AllFiles), len(sections))
	}
	for _, s := range sections {
		if !strings.HasPrefix(s.URL, "spec://") {
			t.Errorf("unexpected URL format: %s", s.URL)
		}
	}
}

func TestReadActiveNoFile(t *testing.T) {
	dir := t.TempDir()
	_, err := ReadActive(dir)
	if err == nil {
		t.Error("expected error for missing _active.md")
	}
}

func TestSpecDirExists(t *testing.T) {
	dir := t.TempDir()
	sd := &SpecDir{ProjectPath: dir, TaskSlug: "nonexistent"}
	if sd.Exists() {
		t.Error("should not exist")
	}
	sd2, _ := Init(dir, "exists", "test")
	if !sd2.Exists() {
		t.Error("should exist after init")
	}
}
```

**Step 4: テスト実行**

Run: `go test ./internal/spec/ -v`
Expected: ALL PASS

**Step 5: Commit**

```
feat: add internal/spec package for butler-protocol file management
```

---

## Task 2: DB同期機能（internal/spec/ に追加）

specファイルをDBにインデックスする機能。既存のstore.UpsertDoc + embedder を使う。

**Files:**
- Create: `internal/spec/sync.go`
- Create: `internal/spec/sync_test.go`

**Step 1: Sync関数の実装**

```go
// internal/spec/sync.go
package spec

import (
	"context"
	"fmt"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// SyncResult はDB同期の結果
type SyncResult struct {
	Upserted int
	Embedded int
	Unchanged int
}

// SyncToDB syncs all spec files to the docs table with embeddings
func SyncToDB(ctx context.Context, sd *SpecDir, st *store.Store, emb *embedder.Embedder) (*SyncResult, error) {
	sections, err := sd.AllSections()
	if err != nil {
		return nil, fmt.Errorf("read sections: %w", err)
	}

	result := &SyncResult{}
	for _, sec := range sections {
		id, changed, err := st.UpsertDoc(&store.DocRow{
			URL:         sec.URL,
			SectionPath: fmt.Sprintf("%s > %s", sd.TaskSlug, sec.File),
			Content:     sec.Content,
			SourceType:  "spec",
			TTLDays:     365, // specs are long-lived
		})
		if err != nil {
			return nil, fmt.Errorf("upsert %s: %w", sec.File, err)
		}
		if !changed {
			result.Unchanged++
			continue
		}
		result.Upserted++

		// Generate embedding for changed content
		if emb != nil && sec.Content != "" {
			vec, err := emb.EmbedForStorage(ctx, sec.Content)
			if err != nil {
				return nil, fmt.Errorf("embed %s: %w", sec.File, err)
			}
			if err := st.InsertEmbedding("docs", id, emb.Model(), vec); err != nil {
				return nil, fmt.Errorf("store embedding %s: %w", sec.File, err)
			}
			result.Embedded++
		}
	}
	return result, nil
}

// SyncSingleFile syncs a single spec file to DB
func SyncSingleFile(ctx context.Context, sd *SpecDir, f SpecFile, st *store.Store, emb *embedder.Embedder) error {
	content, err := sd.ReadFile(f)
	if err != nil {
		return fmt.Errorf("read %s: %w", f, err)
	}

	url := fmt.Sprintf("spec://%s/%s/%s", filepath.Base(sd.ProjectPath), sd.TaskSlug, f)
	id, changed, err := st.UpsertDoc(&store.DocRow{
		URL:         url,
		SectionPath: fmt.Sprintf("%s > %s", sd.TaskSlug, f),
		Content:     content,
		SourceType:  "spec",
		TTLDays:     365,
	})
	if err != nil {
		return fmt.Errorf("upsert: %w", err)
	}

	if changed && emb != nil && content != "" {
		vec, err := emb.EmbedForStorage(ctx, content)
		if err != nil {
			return fmt.Errorf("embed: %w", err)
		}
		if err := st.InsertEmbedding("docs", id, emb.Model(), vec); err != nil {
			return fmt.Errorf("store embedding: %w", err)
		}
	}
	return nil
}
```

**Step 2: テスト（DBモックなしで統合テスト）**

```go
// internal/spec/sync_test.go
package spec

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestSyncToDB(t *testing.T) {
	// Setup: temp project dir + temp DB
	projectDir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// Init spec
	sd, err := Init(projectDir, "sync-test", "Test sync")
	if err != nil {
		t.Fatal(err)
	}

	// Sync without embedder (nil = skip embedding)
	result, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != len(AllFiles) {
		t.Errorf("expected %d upserted, got %d", len(AllFiles), result.Upserted)
	}

	// Second sync should be unchanged
	result2, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result2.Unchanged != len(AllFiles) {
		t.Errorf("expected %d unchanged, got %d", len(AllFiles), result2.Unchanged)
	}

	// Modify a file and re-sync
	sd.AppendFile(FileDecisions, "## New decision\n")
	result3, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result3.Upserted != 1 {
		t.Errorf("expected 1 upserted after change, got %d", result3.Upserted)
	}
}
```

**Step 3: テスト実行**

Run: `go test ./internal/spec/ -v -run TestSync`
Expected: ALL PASS

**Step 4: Commit**

```
feat: add spec DB sync with embeddings for butler-protocol
```

---

## Task 3: MCPツール butler-init

**Files:**
- Create: `internal/mcpserver/handlers_butler.go`
- Modify: `internal/mcpserver/server.go` (ツール登録追加)

**Step 1: butler-init ハンドラ実装**

```go
// internal/mcpserver/handlers_butler.go
package mcpserver

import (
	"context"
	"fmt"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func butlerInitHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		taskSlug := req.GetString("task_slug", "")
		description := req.GetString("description", "")

		if projectPath == "" || taskSlug == "" {
			return nil, fmt.Errorf("project_path and task_slug are required")
		}

		// Initialize spec files
		sd, err := spec.Init(projectPath, taskSlug, description)
		if err != nil {
			return nil, fmt.Errorf("init spec: %w", err)
		}

		// Sync to DB
		syncResult, err := spec.SyncToDB(ctx, sd, st, emb)
		if err != nil {
			return nil, fmt.Errorf("sync to DB: %w", err)
		}

		// Collect created file paths
		files := make([]string, 0, len(spec.AllFiles))
		for _, f := range spec.AllFiles {
			files = append(files, sd.FilePath(f))
		}

		result := map[string]any{
			"task_slug":  taskSlug,
			"spec_dir":   sd.Dir(),
			"files":      files,
			"db_synced":  syncResult.Upserted,
			"db_embedded": syncResult.Embedded,
		}
		return marshalResult(result)
	}
}
```

**Step 2: server.go にツール登録**

`internal/mcpserver/server.go` の `New()` 関数内、既存ツール登録の後に追加:

```go
server.ServerTool{
	Tool: mcp.NewTool("butler-init",
		mcp.WithDescription("Initialize a new spec for a development task. Creates .alfred/specs/{task_slug}/ with 6 template files (requirements, design, tasks, decisions, knowledge, session) and syncs to the knowledge DB for semantic search."),
		mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
		mcp.WithString("task_slug", mcp.Description("URL-safe task identifier (e.g., 'add-auth', 'fix-memory-leak')"), mcp.Required()),
		mcp.WithString("description", mcp.Description("Brief description of the task goal")),
	),
	Handler: butlerInitHandler(st, emb),
},
```

**Step 3: テスト実行**

Run: `go vet ./internal/mcpserver/`
Expected: no errors

**Step 4: Commit**

```
feat: add butler-init MCP tool
```

---

## Task 4: MCPツール butler-update

**Files:**
- Modify: `internal/mcpserver/handlers_butler.go`
- Modify: `internal/mcpserver/server.go`

**Step 1: butler-update ハンドラ実装**

`handlers_butler.go` に追加:

```go
func butlerUpdateHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		file := req.GetString("file", "")
		content := req.GetString("content", "")
		mode := req.GetString("mode", "append") // "append" | "replace" | "section"

		if projectPath == "" || file == "" || content == "" {
			return nil, fmt.Errorf("project_path, file, and content are required")
		}

		// Resolve active task
		taskSlug, err := spec.ReadActive(projectPath)
		if err != nil {
			return nil, fmt.Errorf("no active spec: %w", err)
		}

		sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
		if !sd.Exists() {
			return nil, fmt.Errorf("spec dir does not exist for task %q", taskSlug)
		}

		specFile := spec.SpecFile(file)

		switch mode {
		case "append":
			if err := sd.AppendFile(specFile, content); err != nil {
				return nil, fmt.Errorf("append: %w", err)
			}
		case "replace":
			if err := sd.WriteFile(specFile, content); err != nil {
				return nil, fmt.Errorf("replace: %w", err)
			}
		default:
			return nil, fmt.Errorf("unsupported mode: %s (use 'append' or 'replace')", mode)
		}

		// Sync single file to DB
		if err := spec.SyncSingleFile(ctx, sd, specFile, st, emb); err != nil {
			return nil, fmt.Errorf("sync: %w", err)
		}

		result := map[string]any{
			"task_slug": taskSlug,
			"file":      file,
			"mode":      mode,
			"db_synced": true,
		}
		return marshalResult(result)
	}
}
```

**Step 2: server.go にツール登録**

```go
server.ServerTool{
	Tool: mcp.NewTool("butler-update",
		mcp.WithDescription("Update a spec file for the active task. Appends or replaces content, then syncs to the knowledge DB. Use for recording decisions, knowledge discoveries, task progress, and session state."),
		mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
		mcp.WithString("file", mcp.Description("Spec file to update: requirements.md, design.md, tasks.md, decisions.md, knowledge.md, session.md"), mcp.Required()),
		mcp.WithString("content", mcp.Description("Content to write"), mcp.Required()),
		mcp.WithString("mode", mcp.Description("Write mode: 'append' (default) or 'replace'")),
	),
	Handler: butlerUpdateHandler(st, emb),
},
```

**Step 3: Commit**

```
feat: add butler-update MCP tool
```

---

## Task 5: MCPツール butler-status

**Files:**
- Modify: `internal/mcpserver/handlers_butler.go`
- Modify: `internal/mcpserver/server.go`

**Step 1: butler-status ハンドラ実装**

`handlers_butler.go` に追加:

```go
func butlerStatusHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return nil, fmt.Errorf("project_path is required")
		}

		taskSlug, err := spec.ReadActive(projectPath)
		if err != nil {
			// No active spec
			result := map[string]any{
				"active": false,
				"message": "No active spec found. Use butler-init to start a new task.",
			}
			return marshalResult(result)
		}

		sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
		if !sd.Exists() {
			result := map[string]any{
				"active": false,
				"message": fmt.Sprintf("Active task %q but spec dir missing.", taskSlug),
			}
			return marshalResult(result)
		}

		// Read session.md for current state
		session, _ := sd.ReadFile(spec.FileSession)
		tasks, _ := sd.ReadFile(spec.FileTasks)
		requirements, _ := sd.ReadFile(spec.FileRequirements)

		result := map[string]any{
			"active":       true,
			"task_slug":    taskSlug,
			"spec_dir":     sd.Dir(),
			"session":      session,
			"tasks":        tasks,
			"requirements": requirements,
		}
		return marshalResult(result)
	}
}
```

**Step 2: server.go にツール登録**

```go
server.ServerTool{
	Tool: mcp.NewTool("butler-status",
		mcp.WithDescription("Get the current spec status for a project. Returns the active task's session state, task list, and requirements. Use at session start to restore context after compact or new session."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
	),
	Handler: butlerStatusHandler(st),
},
```

**Step 3: Commit**

```
feat: add butler-status MCP tool
```

---

## Task 6: MCPツール butler-review（3層ナレッジレビュー）

**Files:**
- Create: `internal/mcpserver/handlers_butler_review.go`
- Modify: `internal/mcpserver/server.go`

**Step 1: butler-review ハンドラ実装**

```go
// internal/mcpserver/handlers_butler_review.go
package mcpserver

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type reviewFinding struct {
	Layer    string `json:"layer"`    // "spec" | "knowledge" | "best_practice"
	Severity string `json:"severity"` // "info" | "warning" | "error"
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

func butlerReviewHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		focus := req.GetString("focus", "")

		if projectPath == "" {
			return nil, fmt.Errorf("project_path is required")
		}

		// Get diff
		diff := getDiff(projectPath)
		if diff == "" {
			result := map[string]any{
				"findings": []reviewFinding{},
				"message":  "No changes to review.",
			}
			return marshalResult(result)
		}

		var findings []reviewFinding

		// Layer 1: Spec-Aware Review
		taskSlug, err := spec.ReadActive(projectPath)
		if err == nil {
			sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
			specFindings := reviewAgainstSpec(sd, diff, focus)
			findings = append(findings, specFindings...)
		}

		// Layer 2: Knowledge-Powered Review (semantic search)
		if emb != nil {
			kbFindings := reviewAgainstKnowledge(ctx, st, emb, diff, focus)
			findings = append(findings, kbFindings...)
		}

		// Layer 3: Best Practices Review
		bpFindings := reviewAgainstBestPractices(st, diff, focus)
		findings = append(findings, bpFindings...)

		result := map[string]any{
			"diff_lines": len(strings.Split(diff, "\n")),
			"findings":   findings,
			"finding_count": len(findings),
			"layers_checked": []string{"spec", "knowledge", "best_practice"},
		}
		return marshalResult(result)
	}
}

func getDiff(projectPath string) string {
	// Try staged first, then unstaged, then recent commits
	for _, args := range [][]string{
		{"diff", "--cached"},
		{"diff"},
		{"diff", "HEAD~3..HEAD"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = projectPath
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			return string(out)
		}
	}
	return ""
}

func reviewAgainstSpec(sd *spec.SpecDir, diff, focus string) []reviewFinding {
	var findings []reviewFinding

	// Check decisions.md for contradictions
	decisions, err := sd.ReadFile(spec.FileDecisions)
	if err == nil && decisions != "" {
		findings = append(findings, reviewFinding{
			Layer:    "spec",
			Severity: "info",
			Message:  fmt.Sprintf("Active spec: %s. Review against %d decision entries.", sd.TaskSlug, strings.Count(decisions, "## ")-1),
			Source:   sd.FilePath(spec.FileDecisions),
		})
	}

	// Check requirements scope
	requirements, err := sd.ReadFile(spec.FileRequirements)
	if err == nil && requirements != "" {
		if strings.Contains(requirements, "## Out of Scope") {
			findings = append(findings, reviewFinding{
				Layer:    "spec",
				Severity: "info",
				Message:  "Out of Scope section exists. Verify changes don't violate scope boundaries.",
				Source:   sd.FilePath(spec.FileRequirements),
			})
		}
	}

	return findings
}

func reviewAgainstKnowledge(ctx context.Context, st *store.Store, emb *embedder.Embedder, diff, focus string) []reviewFinding {
	var findings []reviewFinding

	// Extract key terms from diff for semantic search
	query := focus
	if query == "" {
		// Use first 500 chars of diff as search context
		query = diff
		if len(query) > 500 {
			query = query[:500]
		}
	}

	// Search spec-type knowledge
	queryVec, err := emb.EmbedForSearch(ctx, query)
	if err != nil {
		return findings
	}

	matches, err := st.HybridSearch(queryVec, query, "spec", 3, 12)
	if err != nil {
		return findings
	}

	if len(matches) > 0 {
		ids := make([]int64, len(matches))
		for i, m := range matches {
			ids[i] = m.DocID
		}
		docs, err := st.GetDocsByIDs(ids)
		if err == nil {
			for _, doc := range docs {
				findings = append(findings, reviewFinding{
					Layer:    "knowledge",
					Severity: "info",
					Message:  fmt.Sprintf("Related knowledge: %s", truncate(doc.SectionPath, 100)),
					Source:   doc.URL,
				})
			}
		}
	}

	return findings
}

func reviewAgainstBestPractices(st *store.Store, diff, focus string) []reviewFinding {
	var findings []reviewFinding

	query := focus
	if query == "" {
		query = "best practices code review"
	}

	snippets := queryKB(st, query, 3)
	for _, s := range snippets {
		findings = append(findings, reviewFinding{
			Layer:    "best_practice",
			Severity: "info",
			Message:  fmt.Sprintf("Best practice: %s", truncate(s.SectionPath, 100)),
			Source:   s.URL,
		})
	}

	return findings
}
```

**Step 2: server.go にツール登録**

```go
server.ServerTool{
	Tool: mcp.NewTool("butler-review",
		mcp.WithDescription("3-layer knowledge-powered code review. Layer 1: checks changes against active spec (decisions, requirements scope). Layer 2: semantic search against accumulated knowledge (past bugs, dead ends). Layer 3: best practices from documentation sources."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
		mcp.WithString("focus", mcp.Description("Optional focus area for the review (e.g., 'auth logic', 'error handling')")),
	),
	Handler: butlerReviewHandler(st, emb),
},
```

**Step 3: Commit**

```
feat: add butler-review MCP tool with 3-layer knowledge review
```

---

## Task 7: Hook拡張（PreCompact + SessionStart強化）

**Files:**
- Modify: `cmd/alfred/hooks.go`
- Modify: `plugin/hooks/hooks.json`

**Step 1: PreCompact ハンドラ追加**

`cmd/alfred/hooks.go` の `runHook` 関数に追加:

```go
case "PreCompact":
	return handlePreCompact(ev)
```

新しい関数:

```go
func handlePreCompact(ev hookEvent) error {
	if ev.ProjectPath == "" {
		return nil
	}

	taskSlug, err := spec.ReadActive(ev.ProjectPath)
	if err != nil {
		debugLog("PreCompact: no active spec, skipping")
		return nil // no active spec, nothing to do
	}

	sd := &spec.SpecDir{ProjectPath: ev.ProjectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return nil
	}

	// Generate session snapshot
	// Read current session.md and update with compact warning
	session, _ := sd.ReadFile(spec.FileSession)

	// Add compact marker with timestamp
	marker := fmt.Sprintf("\n## Compact Marker [%s]\nAuto-saved before compaction. Context above this point may be summarized.\n\n",
		time.Now().Format("2006-01-02 15:04:05"))

	if !strings.Contains(session, "Compact Marker") {
		sd.AppendFile(spec.FileSession, marker)
	}

	// Sync session.md to DB (without embedder in hook — short-lived process)
	st, err := store.OpenDefaultCached()
	if err != nil {
		debugLog("PreCompact: DB open error: %v", err)
		return nil
	}
	spec.SyncSingleFile(context.Background(), sd, spec.FileSession, st, nil)

	debugLog("PreCompact: saved session for %s", taskSlug)

	// Output context for Claude to see after compact
	fmt.Fprintf(os.Stdout, "Butler Protocol: session state saved for task '%s'. After compact, call butler-status to restore full context.\n", taskSlug)
	return nil
}
```

**Step 2: SessionStart ハンドラ強化**

`cmd/alfred/hooks.go` の SessionStart 処理に追加（既存の `ingestProjectClaudeMD` の後）:

```go
// After CLAUDE.md ingestion, check for active butler-protocol spec
if ev.ProjectPath != "" {
	injectButlerContext(ev.ProjectPath)
}
```

新しい関数:

```go
func injectButlerContext(projectPath string) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return // no active spec
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return
	}

	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		return
	}

	// Output to stdout so Claude Code injects it into context
	fmt.Fprintf(os.Stdout, "\n--- Butler Protocol: Active Task '%s' ---\n%s\n--- End Butler Protocol ---\n", taskSlug, session)

	debugLog("SessionStart: injected butler context for %s", taskSlug)
}
```

**Step 3: hooks.json にPreCompact追加**

`plugin/hooks/hooks.json` に追加:

```json
"PreCompact": [
  {
    "hooks": [
      {
        "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/run.sh\" hook PreCompact",
        "timeout": 10,
        "type": "command"
      }
    ]
  }
]
```

**Step 4: hookEvent構造体にPreCompact用フィールド対応確認**

PreCompactのstdin inputには `session_id`, `cwd`, `hook_event_name`, `transcript_path` が含まれる。既存の `hookEvent` 構造体の `ProjectPath` (json:"cwd") で `cwd` を取得できるので追加フィールドは不要。

**Step 5: テスト実行**

Run: `go vet ./cmd/alfred/`
Expected: no errors

**Step 6: Commit**

```
feat: add PreCompact hook and enhance SessionStart for butler-protocol
```

---

## Task 8: butler-protocol ルール

**Files:**
- Create: `plugin/rules/butler-protocol.md`

**Step 1: ルールファイル作成**

```markdown
# Butler Protocol — Autonomous Spec Management

When a `.alfred/specs/` directory exists in the project, follow this protocol:

## Session Start
- Call `butler-status` with project_path to check for an active task
- If active, read the session state to understand current position and next steps
- If session.md mentions "Compact Marker", you are resuming after context compaction — carefully read all spec files to restore full context

## Starting New Work
- Before implementation, call `butler-init` to create a spec
- Fill in requirements.md and design.md through conversation with the user
- Break work into tasks in tasks.md

## During Implementation
Record these autonomously — do not wait for user instruction:

**decisions.md** — When you make or recommend a design choice:
```
## [date] Decision Title
- **Chosen:** what was selected
- **Alternatives:** what was considered
- **Reason:** why this option
```

**knowledge.md** — When you discover something:
```
## Discovery Title
- **Finding:** what you learned
- **Context:** when/where this matters
- **Dead ends:** what didn't work and why (CRITICAL — prevents re-exploration)
```

**tasks.md** — Update checkboxes as you complete work

**session.md** — Update when:
- Starting a new sub-task (Current Position)
- Completing a milestone
- Encountering a blocker (Unresolved Issues)

## Compact/Session Recovery
After compact or new session, butler-status provides session.md.
Read spec files in this order to rebuild context:
1. session.md (where am I?)
2. requirements.md (what am I building?)
3. design.md (how?)
4. tasks.md (what's done/remaining?)
5. decisions.md (why these choices?)
6. knowledge.md (what did I learn?)

## Review
- Before committing, call `butler-review` to check changes against specs and accumulated knowledge
```

**Step 2: Commit**

```
feat: add butler-protocol rule for autonomous spec management
```

---

## Task 9: Skills移植（brainstorm / refine / plan）

**Files:**
- Create: `plugin/skills/brainstorm/SKILL.md`
- Create: `plugin/skills/refine/SKILL.md`
- Create: `plugin/skills/plan/SKILL.md`

**Step 1: brainstorm skill（alfred特化版）**

既存の `~/.claude/skills/brainstorm/SKILL.md` をベースに、以下を変更:
- name → `brainstorm` (plugin namespace で `alfred:brainstorm` になる)
- alfred `knowledge` ツール呼び出しを Phase 1 に追加
- Phase 4 出力後に「butler-init で spec 化する？」の選択肢を追加
- `allowed-tools` に `mcp__alfred__knowledge, mcp__alfred__butler-init` を追加

**Step 2: refine skill（alfred特化版）**

既存の `~/.claude/skills/refine/SKILL.md` をベースに、以下を変更:
- Phase 4（決定）の後に `butler-update decisions.md` を自動呼び出し指示追加
- Phase 7 出力後に「butler-init で spec 化する？」の選択肢を追加
- `allowed-tools` に `mcp__alfred__knowledge, mcp__alfred__butler-update` を追加

**Step 3: plan skill（新規）**

```markdown
---
name: plan
description: >
  Butler Protocol: 対話的にspecを生成する。要件定義→設計→タスク分解を行い、
  .alfred/specs/ に保存。Compact/セッション喪失に強い開発計画を作成する。
  Use when: (1) 新しいタスクを始める, (2) 設計を整理したい, (3) 作業を再開する前に計画を立てたい。
user-invocable: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__butler-init, mcp__alfred__butler-update, mcp__alfred__butler-status
context: current
---

# /plan — Butler Protocol Spec Generator

対話的にspecを生成し、Compact/セッション喪失に強い開発計画を作る。

## Core Principle
**Compactで最も失われるのは「推論過程」「設計判断の理由」「探索の死に筋」「暗黙の合意」。**
これらを明示的にファイルに書き出すことで、どのタイミングでセッションが切れても完璧に復帰できるspecを作る。

## Steps

1. **[WHAT]** Parse $ARGUMENTS:
   - task-slug（必須）: URL-safe identifier
   - description（任意）: 概要

2. **[HOW]** Call `butler-status` to check existing state:
   - If active spec exists for this slug → resume mode (skip to Step 6)
   - If no spec → creation mode (continue)

3. **[HOW]** Requirements gathering (対話, 最大3問):
   - What is the goal? (1文で)
   - What does success look like? (計測可能な条件)
   - What is explicitly out of scope?

4. **[HOW]** Design decisions (対話 + knowledge検索):
   - Call `knowledge` to search for relevant best practices
   - Discuss architecture approach
   - Record alternatives considered (CRITICAL for compact resilience)

5. **[HOW]** Task breakdown:
   - Break into concrete, checkable tasks
   - Order by dependency

6. **[HOW]** Call `butler-init` with gathered information:
   - Creates all 6 files with real content (not just templates)
   - Then call `butler-update` to fill in gathered content

7. **[OUTPUT]** Confirm to user:
   ```
   Butler Protocol initialized for '{task-slug}'.

   Spec files: .alfred/specs/{task-slug}/
   - requirements.md ✓
   - design.md ✓
   - tasks.md ✓
   - decisions.md ✓
   - knowledge.md ✓
   - session.md ✓

   DB synced: {N} documents indexed.

   Compact resilience: Active. Session state will auto-save before compaction.
   Session recovery: Active. Context will auto-restore on session start.

   Ready to implement. Start with the first task in tasks.md.
   ```

## Resume Mode (Step 6 alternative)

If an active spec already exists:
1. Call `butler-status` to get current session state
2. Read spec files in recovery order (session → requirements → design → tasks → decisions → knowledge)
3. Present summary to user: "Resuming task '{slug}'. Last position: {current_position}. Next steps: {next_steps}"
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record at least the initial approach decision
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered, even if only briefly
- ALWAYS update session.md with current position after plan completion
```

**Step 4: Commit**

```
feat: add brainstorm, refine, plan skills for butler-protocol
```

---

## Task 10: knowledge ツール拡張（source_type="spec" フィルタ）

**Files:**
- Modify: `internal/mcpserver/handlers_search.go`

**Step 1: knowledge ツールに source_type パラメータ追加**

`server.go` の knowledge ツール定義に追加:

```go
mcp.WithString("source_type", mcp.Description("Filter by source type: docs, custom, spec, or empty for all")),
```

`handlers_search.go` の `docsSearchHandler` 内で source_type を読み取り、`HybridSearch` に渡す:

```go
sourceType := req.GetString("source_type", "")
// 既存の HybridSearch 呼び出しの sourceType 引数にこの値を渡す
```

**Step 2: Commit**

```
feat: add source_type filter to knowledge tool for spec search
```

---

## Task 11: plugin-bundle 更新 + ビルド

**Files:**
- Modify: `internal/install/plugin_bundle.go` (新しいhook/skill/ruleをbundleに含める)

**Step 1: plugin-bundle の生成確認**

Run: `go install ./cmd/alfred && alfred plugin-bundle`
Expected: `plugin/` ディレクトリが新しいファイルを含んで再生成される

**Step 2: 動作確認**

Run: `alfred serve` (MCP サーバー起動テスト)
Expected: エラーなく起動

**Step 3: Commit**

```
feat: update plugin bundle with butler-protocol components
```

---

## Task 12: 統合テスト + 旧skill削除

**Step 1: 統合テスト**

全テスト実行:
Run: `go test ./... -v`
Expected: ALL PASS

**Step 2: 全体ビルド**

Run: `go install ./cmd/alfred`
Expected: ビルド成功

**Step 3: 旧skill削除の案内**

ユーザーに以下を案内:
- `~/.claude/skills/brainstorm/` → 削除（alfred:brainstorm に移行済み）
- `~/.claude/skills/refine/` → 削除（alfred:refine に移行済み）
- superpowers プラグインをアンインストール

**Step 4: Commit**

```
chore: integration tests and build verification
```

---

## 実装順序まとめ

```
Task 1:  internal/spec/（ファイル管理） ← 土台
Task 2:  internal/spec/sync（DB同期） ← 土台
Task 3:  butler-init（MCPツール）
Task 4:  butler-update（MCPツール）
Task 5:  butler-status（MCPツール）
Task 6:  butler-review（MCPツール）
Task 7:  Hooks（PreCompact + SessionStart強化） ← compact耐性の核心
Task 8:  butler-protocol rule ← 自律動作の核心
Task 9:  Skills（brainstorm / refine / plan）
Task 10: knowledge拡張（source_typeフィルタ）
Task 11: plugin-bundle更新
Task 12: 統合テスト + クリーンアップ
```
