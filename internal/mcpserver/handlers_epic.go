package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/epic"
	"github.com/hir4ta/claude-alfred/internal/spec"
)

// epicHandler dispatches roster tool actions for epic management.
func epicHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		action := req.GetString("action", "")
		if action == "" {
			return mcp.NewToolResultError("action is required (init, status, link, unlink, order, list, update, delete)"), nil
		}

		switch action {
		case "init":
			return epicDoInit(req)
		case "status":
			return epicDoStatus(req)
		case "link":
			return epicDoLink(req)
		case "unlink":
			return epicDoUnlink(req)
		case "order":
			return epicDoOrder(req)
		case "list":
			return epicDoList(req)
		case "update":
			return epicDoUpdate(req)
		case "delete":
			return epicDoDelete(req)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action: %s (valid: init, status, link, unlink, order, list, update, delete)", action)), nil
		}
	}
}

// validEpicStatuses are the allowed values for epic status.
var validEpicStatuses = map[string]bool{
	epic.StatusDraft:      true,
	epic.StatusInProgress: true,
	epic.StatusCompleted:  true,
	epic.StatusBlocked:    true,
	epic.StatusArchived:   true,
}

func epicDoInit(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q (pattern: ^[a-z0-9][a-z0-9-]{0,63}$)", epicSlug)), nil
	}
	name := req.GetString("name", epicSlug)

	ed, err := epic.Init(projectPath, epicSlug, name)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("init failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"epic_slug": epicSlug,
		"epic_dir":  ed.Dir(),
		"status":    epic.StatusDraft,
	})
}

func epicDoStatus(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}

	ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
	if !ed.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
	}

	ep, err := ed.Read()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("read epic: %v", err)), nil
	}

	completed, total, _ := ed.Progress()
	actionable := epic.NextActionable(ep.Tasks)

	tasks := make([]map[string]any, len(ep.Tasks))
	for i, t := range ep.Tasks {
		tm := map[string]any{
			"slug":   t.Slug,
			"status": t.Status,
		}
		if len(t.DependsOn) > 0 {
			tm["depends_on"] = t.DependsOn
		}
		tasks[i] = tm
	}

	result := map[string]any{
		"epic_slug":      epicSlug,
		"name":           ep.Name,
		"status":         ep.Status,
		"completed":      completed,
		"total":          total,
		"tasks":          tasks,
		"next_actionable": actionable,
	}
	if total > 0 {
		result["progress_pct"] = int(float64(completed) / float64(total) * 100)
	}

	return marshalResult(result)
}

func epicDoLink(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		return mcp.NewToolResultError("task_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(taskSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q", taskSlug)), nil
	}

	// Validate task exists as a spec.
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("spec not found for task %q — create it with dossier first", taskSlug)), nil
	}

	ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
	if !ed.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
	}

	var dependsOn []string
	if raw := req.GetString("depends_on", ""); raw != "" {
		for d := range strings.SplitSeq(raw, ",") {
			d = strings.TrimSpace(d)
			if d != "" {
				dependsOn = append(dependsOn, d)
			}
		}
	}

	if err := ed.Link(taskSlug, dependsOn); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("link failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"epic_slug":  epicSlug,
		"task_slug":  taskSlug,
		"depends_on": dependsOn,
		"linked":     true,
	})
}

func epicDoUnlink(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		return mcp.NewToolResultError("task_slug is required"), nil
	}

	ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
	if !ed.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
	}

	if err := ed.Unlink(taskSlug); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("unlink failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"epic_slug": epicSlug,
		"task_slug": taskSlug,
		"unlinked":  true,
	})
}

func epicDoOrder(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}

	ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
	if !ed.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
	}

	ep, err := ed.Read()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("read epic: %v", err)), nil
	}

	order, err := epic.TopologicalOrder(ep.Tasks)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("order failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"epic_slug":        epicSlug,
		"recommended_order": order,
		"next_actionable":  epic.NextActionable(ep.Tasks),
	})
}

func epicDoList(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}

	summaries := epic.ListAll(projectPath)
	items := make([]map[string]any, len(summaries))
	for i, s := range summaries {
		item := map[string]any{
			"epic_slug": s.Slug,
			"name":      s.Name,
			"status":    s.Status,
			"completed": s.Completed,
			"total":     s.Total,
		}
		if s.Total > 0 {
			item["progress_pct"] = int(float64(s.Completed) / float64(s.Total) * 100)
		}
		items[i] = item
	}

	return marshalResult(map[string]any{
		"epics": items,
		"count": len(items),
	})
}

func epicDoUpdate(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}

	ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
	if !ed.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
	}

	ep, err := ed.Read()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("read epic: %v", err)), nil
	}

	changed := false
	if name := req.GetString("name", ""); name != "" {
		ep.Name = name
		changed = true
	}
	if status := req.GetString("status", ""); status != "" {
		if !validEpicStatuses[status] {
			return mcp.NewToolResultError(fmt.Sprintf("invalid status %q (valid: draft, in-progress, completed, blocked, archived)", status)), nil
		}
		ep.Status = status
		changed = true
	}

	if !changed {
		return mcp.NewToolResultError("nothing to update: provide name or status"), nil
	}

	if err := ed.Save(ep); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("save failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"epic_slug": epicSlug,
		"name":      ep.Name,
		"status":    ep.Status,
		"updated":   true,
	})
}

func epicDoDelete(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	epicSlug := req.GetString("epic_slug", "")
	if epicSlug == "" {
		return mcp.NewToolResultError("epic_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(epicSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid epic_slug: %q", epicSlug)), nil
	}

	confirm := req.GetBool("confirm", false)
	if !confirm {
		ed := &epic.EpicDir{ProjectPath: projectPath, Slug: epicSlug}
		if !ed.Exists() {
			return mcp.NewToolResultError(fmt.Sprintf("epic not found: %s", epicSlug)), nil
		}
		ep, err := ed.Read()
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("read epic: %v", err)), nil
		}

		taskSlugs := make([]string, len(ep.Tasks))
		for i, t := range ep.Tasks {
			taskSlugs[i] = t.Slug
		}

		return marshalResult(map[string]any{
			"dry_run":    true,
			"epic_slug":  epicSlug,
			"name":       ep.Name,
			"task_count": len(ep.Tasks),
			"tasks":      taskSlugs,
			"note":       "tasks (specs) will NOT be deleted — they become standalone",
			"next_step":  "call again with confirm=true to delete",
		})
	}

	if err := epic.Remove(projectPath, epicSlug); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("delete failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"deleted":   epicSlug,
		"note":      "tasks (specs) preserved as standalone",
	})
}
