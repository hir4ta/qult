package epic

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitAndRead(t *testing.T) {
	dir := t.TempDir()

	ed, err := Init(dir, "auth-system", "Authentication System")
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !ed.Exists() {
		t.Fatal("epic dir should exist")
	}

	ep, err := ed.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if ep.Name != "Authentication System" {
		t.Errorf("name = %q, want %q", ep.Name, "Authentication System")
	}
	if ep.Status != StatusDraft {
		t.Errorf("status = %q, want %q", ep.Status, StatusDraft)
	}
	if len(ep.Tasks) != 0 {
		t.Errorf("tasks = %d, want 0", len(ep.Tasks))
	}
}

func TestInitDuplicate(t *testing.T) {
	dir := t.TempDir()

	if _, err := Init(dir, "my-epic", "test"); err != nil {
		t.Fatalf("first init: %v", err)
	}
	if _, err := Init(dir, "my-epic", "test"); err == nil {
		t.Fatal("duplicate init should fail")
	}
}

func TestInitInvalidSlug(t *testing.T) {
	dir := t.TempDir()
	if _, err := Init(dir, "INVALID", "test"); err == nil {
		t.Fatal("uppercase slug should fail")
	}
	if _, err := Init(dir, "", "test"); err == nil {
		t.Fatal("empty slug should fail")
	}
}

func TestLinkAndUnlink(t *testing.T) {
	dir := t.TempDir()
	ed, _ := Init(dir, "test-epic", "Test")

	if err := ed.Link("task-a", nil); err != nil {
		t.Fatalf("Link task-a: %v", err)
	}
	if err := ed.Link("task-b", []string{"task-a"}); err != nil {
		t.Fatalf("Link task-b: %v", err)
	}

	ep, _ := ed.Read()
	if len(ep.Tasks) != 2 {
		t.Fatalf("tasks = %d, want 2", len(ep.Tasks))
	}
	if ep.Status != StatusInProgress {
		t.Errorf("status should be in-progress after first link, got %q", ep.Status)
	}
	if ep.Tasks[1].DependsOn[0] != "task-a" {
		t.Errorf("task-b depends_on = %v, want [task-a]", ep.Tasks[1].DependsOn)
	}

	// Duplicate link should fail.
	if err := ed.Link("task-a", nil); err == nil {
		t.Fatal("duplicate link should fail")
	}

	// Invalid dependency.
	if err := ed.Link("task-c", []string{"nonexistent"}); err == nil {
		t.Fatal("invalid dependency should fail")
	}

	// Unlink.
	if err := ed.Unlink("task-a"); err != nil {
		t.Fatalf("Unlink: %v", err)
	}
	ep, _ = ed.Read()
	if len(ep.Tasks) != 1 {
		t.Fatalf("tasks after unlink = %d, want 1", len(ep.Tasks))
	}
	// Dependency reference should be removed.
	if len(ep.Tasks[0].DependsOn) != 0 {
		t.Errorf("task-b depends_on should be empty after unlinking task-a, got %v", ep.Tasks[0].DependsOn)
	}
}

func TestProgress(t *testing.T) {
	dir := t.TempDir()
	ed, _ := Init(dir, "prog-epic", "Progress Test")

	ed.Link("t1", nil)
	ed.Link("t2", nil)
	ed.Link("t3", nil)

	ep, _ := ed.Read()
	ep.Tasks[0].Status = StatusCompleted
	ep.Tasks[1].Status = StatusCompleted
	ed.Save(ep)

	completed, total, err := ed.Progress()
	if err != nil {
		t.Fatalf("Progress: %v", err)
	}
	if completed != 2 || total != 3 {
		t.Errorf("progress = %d/%d, want 2/3", completed, total)
	}
}

func TestTopologicalOrder(t *testing.T) {
	tasks := []Task{
		{Slug: "c", DependsOn: []string{"a", "b"}},
		{Slug: "a", DependsOn: nil},
		{Slug: "b", DependsOn: []string{"a"}},
		{Slug: "d", DependsOn: []string{"c"}},
	}

	order, err := TopologicalOrder(tasks)
	if err != nil {
		t.Fatalf("TopologicalOrder: %v", err)
	}

	// a must come before b, b before c, c before d.
	pos := make(map[string]int, len(order))
	for i, s := range order {
		pos[s] = i
	}
	if pos["a"] >= pos["b"] {
		t.Errorf("a should come before b: %v", order)
	}
	if pos["b"] >= pos["c"] {
		t.Errorf("b should come before c: %v", order)
	}
	if pos["c"] >= pos["d"] {
		t.Errorf("c should come before d: %v", order)
	}
}

func TestTopologicalOrderCycle(t *testing.T) {
	tasks := []Task{
		{Slug: "a", DependsOn: []string{"b"}},
		{Slug: "b", DependsOn: []string{"a"}},
	}
	_, err := TopologicalOrder(tasks)
	if err == nil {
		t.Fatal("should detect cycle")
	}
}

func TestNextActionable(t *testing.T) {
	tasks := []Task{
		{Slug: "a", Status: StatusCompleted, DependsOn: nil},
		{Slug: "b", Status: StatusNotStarted, DependsOn: []string{"a"}},
		{Slug: "c", Status: StatusNotStarted, DependsOn: []string{"a", "b"}},
		{Slug: "d", Status: StatusNotStarted, DependsOn: nil},
	}

	actionable := NextActionable(tasks)
	// b (a is completed) and d (no deps) should be actionable.
	// c should not (b is not completed).
	if len(actionable) != 2 {
		t.Fatalf("actionable = %v, want [b, d]", actionable)
	}
	slugSet := map[string]bool{}
	for _, s := range actionable {
		slugSet[s] = true
	}
	if !slugSet["b"] || !slugSet["d"] {
		t.Errorf("actionable = %v, want b and d", actionable)
	}
}

func TestListAll(t *testing.T) {
	dir := t.TempDir()

	Init(dir, "epic-a", "Epic A")
	Init(dir, "epic-b", "Epic B")

	summaries := ListAll(dir)
	if len(summaries) != 2 {
		t.Fatalf("ListAll = %d, want 2", len(summaries))
	}
}

func TestRemove(t *testing.T) {
	dir := t.TempDir()

	Init(dir, "doomed", "To Be Removed")
	Init(dir, "keeper", "Stays")

	if err := Remove(dir, "doomed"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if _, err := os.Stat(filepath.Join(EpicsDir(dir), "doomed")); !os.IsNotExist(err) {
		t.Error("epic dir should be removed")
	}

	state, _ := readActiveEpics(dir)
	if len(state.Epics) != 1 || state.Epics[0] != "keeper" {
		t.Errorf("active epics = %v, want [keeper]", state.Epics)
	}
}

func TestSyncTaskStatus(t *testing.T) {
	dir := t.TempDir()
	ed, _ := Init(dir, "sync-test", "Sync Test")

	ed.Link("my-task", nil)

	changed := SyncTaskStatus(dir, "my-task", StatusInProgress)
	if !changed {
		t.Error("first sync should return true")
	}

	ep, _ := ed.Read()
	if ep.Tasks[0].Status != StatusInProgress {
		t.Errorf("status = %q, want %q", ep.Tasks[0].Status, StatusInProgress)
	}

	// Same status should not change.
	changed = SyncTaskStatus(dir, "my-task", StatusInProgress)
	if changed {
		t.Error("same status sync should return false")
	}

	// Complete the task — epic should auto-complete.
	changed = SyncTaskStatus(dir, "my-task", StatusCompleted)
	if !changed {
		t.Error("completion sync should return true")
	}
	ep, _ = ed.Read()
	if ep.Status != StatusCompleted {
		t.Errorf("epic status = %q, want %q", ep.Status, StatusCompleted)
	}
}

func TestUnlinkTaskFromAllEpics(t *testing.T) {
	dir := t.TempDir()
	ed, _ := Init(dir, "cleanup-epic", "Cleanup Test")
	ed.Link("orphan-task", nil)

	UnlinkTaskFromAllEpics(dir, "orphan-task")

	ep, _ := ed.Read()
	if len(ep.Tasks) != 0 {
		t.Errorf("tasks after cleanup = %d, want 0", len(ep.Tasks))
	}
}
