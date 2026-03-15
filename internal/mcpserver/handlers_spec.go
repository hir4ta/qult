package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/epic"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// validateProjectPath checks that project_path is absolute and clean,
// resolving symlinks to prevent path traversal via symbolic links.
// Falls back to the current working directory when raw is empty.
// Returns the resolved path or an error result.
func validateProjectPath(raw string) (string, *mcp.CallToolResult) {
	if raw == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", mcp.NewToolResultError("project_path is required (cwd fallback failed)")
		}
		raw = cwd
	}
	cleaned := filepath.Clean(raw)
	if !filepath.IsAbs(cleaned) {
		return "", mcp.NewToolResultError("project_path must be an absolute path")
	}
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		// Path may not exist yet (e.g., spec init); fall back to cleaned path.
		if errors.Is(err, os.ErrNotExist) {
			return cleaned, nil
		}
		return "", mcp.NewToolResultError(fmt.Sprintf("project_path resolution failed: %v", err))
	}
	return resolved, nil
}

// validSpecFiles maps allowed file name strings to spec.SpecFile constants.
var validSpecFiles = map[string]spec.SpecFile{
	string(spec.FileRequirements): spec.FileRequirements,
	string(spec.FileDesign):       spec.FileDesign,
	string(spec.FileDecisions):    spec.FileDecisions,
	string(spec.FileSession):      spec.FileSession,
}

// specHandler is the unified handler for all spec management actions.
// It dispatches on the "action" parameter: init, update, status, switch, delete.
func specHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		action := req.GetString("action", "")
		if action == "" {
			return mcp.NewToolResultError("action is required (init, update, status, switch, delete, history, rollback)"), nil
		}

		switch action {
		case "init":
			return specDoInit(ctx, req, st, emb)
		case "update":
			return specDoUpdate(ctx, req, st, emb)
		case "status":
			return specDoStatus(req)
		case "switch":
			return specDoSwitch(ctx, req)
		case "delete":
			return specDoDelete(ctx, req, st)
		case "history":
			return specDoHistory(req)
		case "rollback":
			return specDoRollback(req)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action: %s (valid: init, update, status, switch, delete, history, rollback)", action)), nil
		}
	}
}

func specDoInit(ctx context.Context, req mcp.CallToolRequest, st *store.Store, emb *embedder.Embedder) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		return mcp.NewToolResultError("task_slug is required (e.g. \"auth-refactor\", pattern: ^[a-z0-9][a-z0-9-]{0,63}$)"), nil
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

func specDoUpdate(ctx context.Context, req mcp.CallToolRequest, st *store.Store, emb *embedder.Embedder) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	fileName := req.GetString("file", "")
	if fileName == "" {
		return mcp.NewToolResultError("file is required (one of: requirements.md, design.md, decisions.md, session.md)"), nil
	}
	content := req.GetString("content", "")
	if content == "" {
		return mcp.NewToolResultError("content is required"), nil
	}
	if len(content) > maxContentBytes {
		return mcp.NewToolResultError(fmt.Sprintf("content too large: %d bytes (max %d bytes / 256KB)", len(content), maxContentBytes)), nil
	}
	mode := req.GetString("mode", "append")
	if mode != "append" && mode != "replace" {
		return mcp.NewToolResultError("mode must be 'append' or 'replace'"), nil
	}

	sf, ok := validSpecFiles[fileName]
	if !ok {
		return mcp.NewToolResultError(fmt.Sprintf("invalid file: %s (valid: requirements.md, design.md, decisions.md, session.md)", fileName)), nil
	}

	// Accept optional task_slug; fall back to active task if not provided.
	taskSlug := req.GetString("task_slug", "")
	if taskSlug != "" {
		if !spec.ValidSlug.MatchString(taskSlug) {
			return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q (pattern: ^[a-z0-9][a-z0-9-]{0,63}$)", taskSlug)), nil
		}
	} else {
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("spec dir not found: %s", sd.Dir())), nil
	}

	switch mode {
	case "replace":
		if err := sd.WriteFile(ctx, sf, content); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("write failed: %v", err)), nil
		}
	default: // append
		if err := sd.AppendFile(ctx, sf, content); err != nil {
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

func specDoStatus(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}

	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return marshalResult(map[string]any{
				"active":  false,
				"message": "no active spec found; call spec with action=init to start a task",
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
	confidence := map[string]any{}
	for _, f := range spec.AllFiles {
		content, err := sd.ReadFile(f)
		if err != nil {
			continue
		}
		key := strings.TrimSuffix(string(f), ".md")
		result[key] = content

		// Parse confidence annotations for requirements and design.
		if f == spec.FileRequirements || f == spec.FileDesign {
			if cs := parseConfidenceScores(content); cs.Total > 0 {
				confidence[key] = cs
			}
		}
	}
	if len(confidence) > 0 {
		result["confidence"] = confidence
	}

	return marshalResult(result)
}

func specDoSwitch(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		return mcp.NewToolResultError("task_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(taskSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q (pattern: ^[a-z0-9][a-z0-9-]{0,63}$)", taskSlug)), nil
	}

	// Record switch-away in the old primary's session.md.
	// ReadActive error is non-fatal: no old task simply means nothing to annotate.
	oldSlug, _ := spec.ReadActive(projectPath)
	if oldSlug != "" && oldSlug != taskSlug {
		oldSD := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: oldSlug}
		if oldSD.Exists() {
			_ = oldSD.AppendFile(ctx, spec.FileSession, fmt.Sprintf("\n## Switched away\nSwitched to %s\n", taskSlug)) // best-effort annotation; switch proceeds regardless
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

func specDoDelete(ctx context.Context, req mcp.CallToolRequest, st *store.Store) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		return mcp.NewToolResultError("task_slug is required"), nil
	}
	if !spec.ValidSlug.MatchString(taskSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q (pattern: ^[a-z0-9][a-z0-9-]{0,63}$)", taskSlug)), nil
	}

	confirm := req.GetBool("confirm", false)

	// Without confirm: dry-run preview showing what would be deleted.
	if !confirm {
		sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
		if !sd.Exists() {
			return mcp.NewToolResultError(fmt.Sprintf("spec not found: %s", taskSlug)), nil
		}

		sections, _ := sd.AllSections() // best-effort: empty preview on error is acceptable for dry-run
		var files []string
		totalBytes := 0
		for _, s := range sections {
			files = append(files, string(s.File))
			totalBytes += len(s.Content)
		}

		state, _ := spec.ReadActiveState(projectPath)
		isPrimary := state != nil && state.Primary == taskSlug

		preview := map[string]any{
			"dry_run":    true,
			"task_slug":  taskSlug,
			"file_count": len(files),
			"files":      files,
			"total_bytes": totalBytes,
			"is_primary": isPrimary,
		}
		if isPrimary && state != nil {
			for _, t := range state.Tasks {
				if t.Slug != taskSlug {
					preview["new_primary_after_delete"] = t.Slug
					break
				}
			}
		}
		if st != nil {
			projectBase := filepath.Base(projectPath)
			n, _ := st.CountDocsByURLPrefix(ctx, fmt.Sprintf("spec://%s/%s/", projectBase, taskSlug))
			preview["db_doc_count"] = n
		}
		preview["next_step"] = "call again with confirm=true to delete"
		return marshalResult(preview)
	}

	// With confirm: actually delete.
	allGone, err := spec.RemoveTask(projectPath, taskSlug)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("delete failed: %v", err)), nil
	}

	// Clean up dangling references in epics.
	epic.UnlinkTaskFromAllEpics(projectPath, taskSlug)

	result := map[string]any{
		"deleted":  taskSlug,
		"all_gone": allGone,
	}
	if st != nil {
		projectBase := filepath.Base(projectPath)
		n, _ := st.DeleteDocsByURLPrefix(ctx, fmt.Sprintf("spec://%s/%s/", projectBase, taskSlug))
		result["db_docs_deleted"] = n
	}
	if !allGone {
		newPrimary, _ := spec.ReadActive(projectPath)
		result["new_primary"] = newPrimary
	}

	return marshalResult(result)
}

func specDoHistory(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	fileName := req.GetString("file", "")
	if fileName == "" {
		return mcp.NewToolResultError("file is required (one of: requirements.md, design.md, decisions.md, session.md)"), nil
	}
	sf, ok := validSpecFiles[fileName]
	if !ok {
		return mcp.NewToolResultError(fmt.Sprintf("invalid file: %s", fileName)), nil
	}

	taskSlug := req.GetString("task_slug", "")
	if taskSlug != "" {
		if !spec.ValidSlug.MatchString(taskSlug) {
			return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q", taskSlug)), nil
		}
	} else {
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	entries, err := sd.History(sf)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("history error: %v", err)), nil
	}

	type historyItem struct {
		Timestamp string `json:"timestamp"`
		Size      int64  `json:"size_bytes"`
	}
	items := make([]historyItem, len(entries))
	for i, e := range entries {
		items[i] = historyItem{Timestamp: e.Timestamp, Size: e.Size}
	}

	return marshalResult(map[string]any{
		"task_slug": taskSlug,
		"file":      fileName,
		"versions":  items,
		"count":     len(items),
	})
}

func specDoRollback(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	fileName := req.GetString("file", "")
	if fileName == "" {
		return mcp.NewToolResultError("file is required"), nil
	}
	version := req.GetString("version", "")
	if version == "" {
		return mcp.NewToolResultError("version (timestamp) is required — use action=history to list versions"), nil
	}
	sf, ok := validSpecFiles[fileName]
	if !ok {
		return mcp.NewToolResultError(fmt.Sprintf("invalid file: %s", fileName)), nil
	}

	taskSlug := req.GetString("task_slug", "")
	if taskSlug != "" {
		if !spec.ValidSlug.MatchString(taskSlug) {
			return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q", taskSlug)), nil
		}
	} else {
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if err := sd.Rollback(sf, version); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("rollback failed: %v", err)), nil
	}

	return marshalResult(map[string]any{
		"task_slug": taskSlug,
		"file":      fileName,
		"restored":  version,
		"message":   "current version saved to history before rollback (undoable)",
	})
}

// ---------------------------------------------------------------------------
// Spec confidence scoring (10-point scale)
// ---------------------------------------------------------------------------

// confidenceSummary holds parsed confidence statistics for a spec file.
type confidenceSummary struct {
	Avg      float64           `json:"avg"`
	Total    int               `json:"total_items"`
	LowCount int              `json:"low_items"`  // items with score <= 5
	Items    []confidenceItem  `json:"items,omitempty"`
}

type confidenceItem struct {
	Section string `json:"section"`
	Score   int    `json:"score"`
}

// confidenceRe matches <!-- confidence: N --> annotations after section headers.
var confidenceRe = regexp.MustCompile(`<!--\s*confidence:\s*(\d{1,2})\s*-->`)

// parseConfidenceScores extracts confidence annotations from spec file content.
// Format: <!-- confidence: N --> where N is 1-10, placed after ## section headers.
//
// Scale interpretation:
//   1-3: Low (speculation, needs discussion)
//   4-6: Medium (reasonable inference, needs validation)
//   7-9: High (evidence-based, confirmed)
//   10:  Certain (explicitly confirmed or derived from code)
func parseConfidenceScores(content string) confidenceSummary {
	lines := strings.Split(content, "\n")
	var items []confidenceItem
	currentSection := ""

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			currentSection = strings.TrimPrefix(trimmed, "## ")
			// Strip inline confidence annotation from section name.
			if idx := strings.Index(currentSection, "<!--"); idx > 0 {
				currentSection = strings.TrimSpace(currentSection[:idx])
			}
		}

		matches := confidenceRe.FindStringSubmatch(trimmed)
		if len(matches) < 2 {
			continue
		}
		score, err := strconv.Atoi(matches[1])
		if err != nil || score < 1 || score > 10 {
			continue
		}
		section := currentSection
		if section == "" {
			section = "(unnamed)"
		}
		items = append(items, confidenceItem{Section: section, Score: score})
	}

	if len(items) == 0 {
		return confidenceSummary{}
	}

	total := 0
	lowCount := 0
	for _, item := range items {
		total += item.Score
		if item.Score <= 5 {
			lowCount++
		}
	}

	return confidenceSummary{
		Avg:      float64(total) / float64(len(items)),
		Total:    len(items),
		LowCount: lowCount,
		Items:    items,
	}
}
