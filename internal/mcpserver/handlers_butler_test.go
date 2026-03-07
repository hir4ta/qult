package mcpserver

import (
	"context"
	"strings"
	"testing"
)

// specReq is a helper to build spec tool requests with action.
func specReq(action string, extra map[string]any) map[string]any {
	m := map[string]any{"action": action}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestSpecHandler_MissingAction(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing action")
	}
}

func TestSpecHandler_UnknownAction(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("bogus", map[string]any{
		"project_path": t.TempDir(),
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for unknown action")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "bogus") {
		t.Errorf("error should mention unknown action: %s", text)
	}
}

func TestSpecInit_MissingProjectPath(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("init", map[string]any{
		"task_slug": "test-task",
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing project_path")
	}
}

func TestSpecInit_MissingTaskSlug(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": t.TempDir(),
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestSpecInit_Success(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "my-task",
		"description":  "test init",
	})))
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

func TestSpecInit_InvalidSlug(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": t.TempDir(),
		"task_slug":    "INVALID_SLUG!",
	})))
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

func TestSpecInit_WithDB(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := specHandler(st, nil)
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "db-task",
		"description":  "test with DB sync",
	})))
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

func TestSpecUpdate_MissingFields(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)

	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"no project_path", specReq("update", map[string]any{"file": "design.md", "content": "x"}), "project_path"},
		{"no file", specReq("update", map[string]any{"project_path": "/tmp", "content": "x"}), "file"},
		{"no content", specReq("update", map[string]any{"project_path": "/tmp", "file": "design.md"}), "content"},
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

func TestSpecUpdate_InvalidFile(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	dir := t.TempDir()

	// Create a spec first.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "update-test",
		"description":  "test",
	})))

	res, err := handler(context.Background(), newRequest(specReq("update", map[string]any{
		"project_path": dir,
		"file":         "invalid.md",
		"content":      "some content",
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for invalid file name")
	}
}

func TestSpecUpdate_InvalidMode(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("update", map[string]any{
		"project_path": t.TempDir(),
		"file":         "design.md",
		"content":      "x",
		"mode":         "upsert",
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for invalid mode")
	}
}

func TestSpecUpdate_AppendAndReplace(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	handler := specHandler(nil, nil)

	// Init a spec.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "upd-task",
		"description":  "test",
	})))

	// Append mode.
	res, err := handler(context.Background(), newRequest(specReq("update", map[string]any{
		"project_path": dir,
		"file":         "decisions.md",
		"content":      "\n## Decision 1\nUse SQLite",
		"mode":         "append",
	})))
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
	res, err = handler(context.Background(), newRequest(specReq("update", map[string]any{
		"project_path": dir,
		"file":         "decisions.md",
		"content":      "# Decisions\n\nReplaced all content.",
		"mode":         "replace",
	})))
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

func TestSpecStatus_NoSpec(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	dir := t.TempDir()

	res, err := handler(context.Background(), newRequest(specReq("status", map[string]any{
		"project_path": dir,
	})))
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

func TestSpecStatus_WithSpec(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	handler := specHandler(nil, nil)

	// Create a spec.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "status-task",
		"description":  "test status",
	})))

	res, err := handler(context.Background(), newRequest(specReq("status", map[string]any{
		"project_path": dir,
	})))
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

func TestSpecStatus_MissingProjectPath(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("status", nil)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for missing project_path")
	}
}

func TestSpecSwitch_Success(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	handler := specHandler(nil, nil)

	// Create two specs.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "task-a",
		"description":  "first",
	})))
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "task-b",
		"description":  "second",
	})))

	// Switch to task-a.
	res, err := handler(context.Background(), newRequest(specReq("switch", map[string]any{
		"project_path": dir,
		"task_slug":    "task-a",
	})))
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

func TestSpecSwitch_MissingFields(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, _ := handler(context.Background(), newRequest(specReq("switch", map[string]any{
		"project_path": t.TempDir(),
	})))
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestSpecDelete_Success(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	handler := specHandler(nil, nil)

	// Create a spec.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "del-task",
		"description":  "to delete",
	})))

	// Dry-run preview first.
	preview, err := handler(context.Background(), newRequest(specReq("delete", map[string]any{
		"project_path": dir,
		"task_slug":    "del-task",
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	pm := resultJSON(t, preview)
	if dryRun, _ := pm["dry_run"].(bool); !dryRun {
		t.Error("expected dry_run=true in preview")
	}

	// Confirm delete.
	res, err := handler(context.Background(), newRequest(specReq("delete", map[string]any{
		"project_path": dir,
		"task_slug":    "del-task",
		"confirm":      true,
	})))
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

func TestSpecDelete_WithDB(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := specHandler(st, nil)
	dir := t.TempDir()

	// Create spec with DB sync.
	handler(context.Background(), newRequest(specReq("init", map[string]any{
		"project_path": dir,
		"task_slug":    "db-del",
		"description":  "to delete with DB",
	})))

	// Delete with DB cleanup (confirm=true).
	res, err := handler(context.Background(), newRequest(specReq("delete", map[string]any{
		"project_path": dir,
		"task_slug":    "db-del",
		"confirm":      true,
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["deleted"] != "db-del" {
		t.Errorf("deleted = %v, want db-del", m["deleted"])
	}
}

func TestSpecDelete_MissingFields(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, _ := handler(context.Background(), newRequest(specReq("delete", map[string]any{
		"project_path": t.TempDir(),
	})))
	if !res.IsError {
		t.Fatal("expected error for missing task_slug")
	}
}

func TestSpecDelete_NonexistentTask(t *testing.T) {
	t.Parallel()
	handler := specHandler(nil, nil)
	res, err := handler(context.Background(), newRequest(specReq("delete", map[string]any{
		"project_path": t.TempDir(),
		"task_slug":    "nonexistent",
	})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error for nonexistent task")
	}
}
