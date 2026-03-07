package mcpserver

import (
	"context"
	"strings"
	"testing"
)

func TestButlerInitHandler_MissingProjectPath(t *testing.T) {
	t.Parallel()
	handler := butlerInitHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"task_slug": "test-task",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing project_path")
	}
}

func TestButlerInitHandler_MissingTaskSlug(t *testing.T) {
	t.Parallel()
	handler := butlerInitHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestButlerInitHandler_Success(t *testing.T) {
	t.Parallel()
	handler := butlerInitHandler(nil, nil)
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "my-task",
		"description":  "test init",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["task_slug"] != "my-task" {
		t.Errorf("task_slug = %v, want my-task", m["task_slug"])
	}
	files, ok := m["files"].([]any)
	if !ok || len(files) != 4 {
		t.Errorf("files = %v, want 4 spec files", m["files"])
	}
}

func TestButlerInitHandler_InvalidSlug(t *testing.T) {
	t.Parallel()
	handler := butlerInitHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
		"task_slug":    "INVALID_SLUG!",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for invalid slug")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "invalid") {
		t.Errorf("error should mention 'invalid': %s", text)
	}
}

func TestButlerInitHandler_WithDB(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := butlerInitHandler(st, nil)
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "db-task",
		"description":  "test with DB sync",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if synced, _ := m["db_synced"].(bool); !synced {
		t.Error("expected db_synced = true")
	}
}

func TestButlerUpdateHandler_MissingFields(t *testing.T) {
	t.Parallel()
	handler := butlerUpdateHandler(nil, nil)

	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"no project_path", map[string]any{"file": "design.md", "content": "x"}, "project_path"},
		{"no file", map[string]any{"project_path": "/tmp", "content": "x"}, "file"},
		{"no content", map[string]any{"project_path": "/tmp", "file": "design.md"}, "content"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			res, err := handler(context.Background(), newRequest(tt.args))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !res.IsError {
				t.Fatal("expected error result")
			}
			text := resultText(t, res)
			if !strings.Contains(text, tt.want) {
				t.Errorf("error should mention %q: %s", tt.want, text)
			}
		})
	}
}

func TestButlerUpdateHandler_InvalidFile(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := butlerInitHandler(st, nil)
	dir := t.TempDir()

	// Create a spec first.
	handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "update-test",
		"description":  "test",
	}))

	updateHandler := butlerUpdateHandler(nil, nil)
	res, err := updateHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"file":         "invalid.md",
		"content":      "some content",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for invalid file name")
	}
}

func TestButlerUpdateHandler_InvalidMode(t *testing.T) {
	t.Parallel()
	handler := butlerUpdateHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
		"file":         "design.md",
		"content":      "x",
		"mode":         "upsert",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for invalid mode")
	}
}

func TestButlerUpdateHandler_AppendAndReplace(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Init a spec.
	initHandler := butlerInitHandler(nil, nil)
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "upd-task",
		"description":  "test",
	}))

	updateHandler := butlerUpdateHandler(nil, nil)

	// Append mode.
	res, err := updateHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"file":         "decisions.md",
		"content":      "\n## Decision 1\nUse SQLite",
		"mode":         "append",
	}))
	if err != nil {
		t.Fatalf("append error: %v", err)
	}
	if res.IsError {
		t.Fatalf("append failed: %s", resultText(t, res))
	}
	m := resultJSON(t, res)
	if m["mode"] != "append" {
		t.Errorf("mode = %v, want append", m["mode"])
	}

	// Replace mode.
	res, err = updateHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"file":         "decisions.md",
		"content":      "# Decisions\n\nReplaced all content.",
		"mode":         "replace",
	}))
	if err != nil {
		t.Fatalf("replace error: %v", err)
	}
	if res.IsError {
		t.Fatalf("replace failed: %s", resultText(t, res))
	}
	m = resultJSON(t, res)
	if m["mode"] != "replace" {
		t.Errorf("mode = %v, want replace", m["mode"])
	}
}

func TestButlerStatusHandler_NoSpec(t *testing.T) {
	t.Parallel()
	handler := butlerStatusHandler()
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if active, _ := m["active"].(bool); active {
		t.Error("expected active = false for empty project")
	}
}

func TestButlerStatusHandler_WithSpec(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Create a spec.
	initHandler := butlerInitHandler(nil, nil)
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "status-task",
		"description":  "test status",
	}))

	handler := butlerStatusHandler()
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	if active, _ := m["active"].(bool); !active {
		t.Error("expected active = true")
	}
	if m["task_slug"] != "status-task" {
		t.Errorf("task_slug = %v, want status-task", m["task_slug"])
	}
	if m["requirements"] == nil {
		t.Error("expected requirements content in status")
	}
}

func TestButlerStatusHandler_MissingProjectPath(t *testing.T) {
	t.Parallel()
	handler := butlerStatusHandler()
	res, err := handler(context.Background(), newRequest(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing project_path")
	}
}

func TestButlerSwitchHandler_Success(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Create two specs.
	initHandler := butlerInitHandler(nil, nil)
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "task-a",
		"description":  "first",
	}))
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "task-b",
		"description":  "second",
	}))

	// Switch to task-a.
	switchHandler := butlerSwitchHandler()
	res, err := switchHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "task-a",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["primary"] != "task-a" {
		t.Errorf("primary = %v, want task-a", m["primary"])
	}
}

func TestButlerSwitchHandler_MissingFields(t *testing.T) {
	t.Parallel()
	handler := butlerSwitchHandler()
	res, _ := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestButlerDeleteHandler_Success(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Create a spec.
	initHandler := butlerInitHandler(nil, nil)
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "del-task",
		"description":  "to delete",
	}))

	// Delete it.
	delHandler := butlerDeleteHandler(nil)
	res, err := delHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "del-task",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["deleted"] != "del-task" {
		t.Errorf("deleted = %v, want del-task", m["deleted"])
	}
	if allGone, _ := m["all_gone"].(bool); !allGone {
		t.Error("expected all_gone = true when deleting the only task")
	}
}

func TestButlerDeleteHandler_WithDB(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	dir := t.TempDir()

	// Create spec with DB sync.
	initHandler := butlerInitHandler(st, nil)
	initHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "db-del",
		"description":  "to delete with DB",
	}))

	// Delete with DB cleanup.
	delHandler := butlerDeleteHandler(st)
	res, err := delHandler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
		"task_slug":    "db-del",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if cleaned, _ := m["db_cleaned"].(bool); !cleaned {
		t.Error("expected db_cleaned = true")
	}
}

func TestButlerDeleteHandler_MissingFields(t *testing.T) {
	t.Parallel()
	handler := butlerDeleteHandler(nil)
	res, _ := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestButlerDeleteHandler_NonexistentTask(t *testing.T) {
	t.Parallel()
	handler := butlerDeleteHandler(nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
		"task_slug":    "nonexistent",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for nonexistent task")
	}
}
