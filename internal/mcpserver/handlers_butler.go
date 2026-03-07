package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// validSpecFiles maps allowed file name strings to spec.SpecFile constants.
var validSpecFiles = map[string]spec.SpecFile{
	string(spec.FileRequirements): spec.FileRequirements,
	string(spec.FileDesign):       spec.FileDesign,
	string(spec.FileDecisions):    spec.FileDecisions,
	string(spec.FileSession):      spec.FileSession,
}

// butlerInitHandler initializes a new spec for a development task.
func butlerInitHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}
		taskSlug := req.GetString("task_slug", "")
		if taskSlug == "" {
			return mcp.NewToolResultError("task_slug is required"), nil
		}
		description := req.GetString("description", "")

		sd, err := spec.Init(projectPath, taskSlug, description)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("init failed: %v", err)), nil
		}

		result := map[string]any{
			"task_slug":   taskSlug,
			"spec_dir":    sd.Dir(),
			"files":       spec.AllFiles,
			"db_synced":   false,
			"db_embedded": false,
		}

		if st != nil {
			syncResult, err := spec.SyncToDB(ctx, sd, st, emb)
			if err != nil {
				result["db_error"] = err.Error()
				return marshalResult(result)
			}
			result["db_synced"] = true
			result["db_embedded"] = syncResult.Embedded > 0
		}

		return marshalResult(result)
	}
}

// butlerUpdateHandler updates a spec file for the active task.
func butlerUpdateHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}
		fileName := req.GetString("file", "")
		if fileName == "" {
			return mcp.NewToolResultError("file is required"), nil
		}
		content := req.GetString("content", "")
		if content == "" {
			return mcp.NewToolResultError("content is required"), nil
		}
		mode := req.GetString("mode", "append")
		if mode != "append" && mode != "replace" {
			return mcp.NewToolResultError("mode must be 'append' or 'replace'"), nil
		}

		sf, ok := validSpecFiles[fileName]
		if !ok {
			return mcp.NewToolResultError(fmt.Sprintf("invalid file: %s (valid: requirements.md, design.md, decisions.md, session.md)", fileName)), nil
		}

		taskSlug, err := spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}

		sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
		if !sd.Exists() {
			return mcp.NewToolResultError(fmt.Sprintf("spec dir not found: %s", sd.Dir())), nil
		}

		switch mode {
		case "replace":
			if err := sd.WriteFile(sf, content); err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("write failed: %v", err)), nil
			}
		default: // append
			if err := sd.AppendFile(sf, content); err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("append failed: %v", err)), nil
			}
		}

		result := map[string]any{
			"task_slug": taskSlug,
			"file":      fileName,
			"mode":      mode,
			"db_synced": false,
		}

		if st != nil {
			if err := spec.SyncSingleFile(ctx, sd, sf, st, emb); err != nil {
				result["db_error"] = err.Error()
				return marshalResult(result)
			}
			result["db_synced"] = true
		}

		return marshalResult(result)
	}
}

// butlerStatusHandler returns the current spec status for a project.
func butlerStatusHandler() server.ToolHandlerFunc {
	return func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}

		taskSlug, err := spec.ReadActive(projectPath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return marshalResult(map[string]any{
					"active":  false,
					"message": "no active spec found; use spec-init to start a task",
				})
			}
			return marshalResult(map[string]any{
				"active":  false,
				"message": fmt.Sprintf("could not read active spec: %v", err),
			})
		}

		sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
		if !sd.Exists() {
			return marshalResult(map[string]any{
				"active":  false,
				"message": fmt.Sprintf("active task '%s' points to missing spec dir", taskSlug),
			})
		}

		result := map[string]any{
			"active":    true,
			"task_slug": taskSlug,
			"spec_dir":  sd.Dir(),
		}

		// Read all 4 spec files for complete context restoration.
		for _, f := range spec.AllFiles {
			content, err := sd.ReadFile(f)
			if err != nil {
				continue
			}
			// Use the file name without extension as key.
			key := string(f[:len(f)-len(".md")])
			result[key] = content
		}

		return marshalResult(result)
	}
}

// butlerSwitchHandler switches the primary active task.
func butlerSwitchHandler() server.ToolHandlerFunc {
	return func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}
		taskSlug := req.GetString("task_slug", "")
		if taskSlug == "" {
			return mcp.NewToolResultError("task_slug is required"), nil
		}

		// Record switch-away in the old primary's session.md
		oldSlug, _ := spec.ReadActive(projectPath)
		if oldSlug != "" && oldSlug != taskSlug {
			oldSD := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: oldSlug}
			if oldSD.Exists() {
				_ = oldSD.AppendFile(spec.FileSession, fmt.Sprintf("\n## Switched away\nSwitched to %s\n", taskSlug))
			}
		}

		if err := spec.SwitchActive(projectPath, taskSlug); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("switch failed: %v", err)), nil
		}

		result := map[string]any{"primary": taskSlug}
		if state, err := spec.ReadActiveState(projectPath); err == nil {
			slugs := make([]string, 0, len(state.Tasks))
			for _, t := range state.Tasks {
				slugs = append(slugs, t.Slug)
			}
			result["all_tasks"] = strings.Join(slugs, ", ")
		}

		return marshalResult(result)
	}
}

// butlerDeleteHandler removes a task's spec and updates _active.md.
func butlerDeleteHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}
		taskSlug := req.GetString("task_slug", "")
		if taskSlug == "" {
			return mcp.NewToolResultError("task_slug is required"), nil
		}

		allGone, err := spec.RemoveTask(projectPath, taskSlug)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("delete failed: %v", err)), nil
		}

		// Remove spec docs from DB (URL uses filepath.Base, matching AllSections format).
		if st != nil {
			projectBase := filepath.Base(projectPath)
			st.DeleteDocsByURLPrefix(ctx, fmt.Sprintf("spec://%s/%s/", projectBase, taskSlug))
		}

		result := map[string]any{
			"deleted":    taskSlug,
			"all_gone":   allGone,
			"db_cleaned": st != nil,
		}
		if !allGone {
			newPrimary, _ := spec.ReadActive(projectPath)
			result["new_primary"] = newPrimary
		}

		return marshalResult(result)
	}
}
