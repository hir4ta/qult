package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

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
// Derived from spec.AllFiles plus bugfix.md to stay in sync automatically.
var validSpecFiles = func() map[string]spec.SpecFile {
	m := make(map[string]spec.SpecFile, len(spec.AllFiles)+1)
	for _, f := range spec.AllFiles {
		m[string(f)] = f
	}
	m[string(spec.FileBugfix)] = spec.FileBugfix
	return m
}()

// validFileList returns a comma-separated list of valid spec file names.
func validFileList() string {
	names := make([]string, len(spec.AllFiles))
	for i, f := range spec.AllFiles {
		names[i] = string(f)
	}
	return strings.Join(names, ", ")
}

// specHandler is the unified handler for all spec management actions.
// It dispatches on the "action" parameter: init, update, status, switch, delete.
func specHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		action := req.GetString("action", "")
		if action == "" {
			return mcp.NewToolResultError("action is required (init, update, status, switch, complete, delete, history, rollback, validate)"), nil
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
		case "complete":
			return specDoComplete(ctx, req, st)
		case "delete":
			return specDoDelete(ctx, req, st)
		case "history":
			return specDoHistory(req)
		case "rollback":
			return specDoRollback(req)
		case "review":
			return specDoReview(req)
		case "validate":
			return specDoValidate(req)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action: %s (valid: init, update, status, switch, complete, delete, history, rollback, review, validate)", action)), nil
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

	// Parse size and spec_type options.
	var opts []spec.InitOption
	sizeStr := req.GetString("size", "")
	if sizeStr != "" {
		size, err := spec.ParseSize(sizeStr)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("invalid size: %v", err)), nil
		}
		opts = append(opts, spec.WithSize(size))
	}
	specTypeStr := req.GetString("spec_type", "")
	if specTypeStr != "" {
		specType, err := spec.ParseSpecType(specTypeStr)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("invalid spec_type: %v", err)), nil
		}
		opts = append(opts, spec.WithSpecType(specType))
	}

	initResult, err := spec.InitWithResult(projectPath, taskSlug, description, opts...)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("init failed: %v", err)), nil
	}
	sd := initResult.SpecDir
	spec.AppendAudit(projectPath, spec.AuditEntry{Action: "spec.init", Target: taskSlug, Detail: description, User: "mcp"})

	result := map[string]any{
		"task_slug":   taskSlug,
		"spec_dir":    sd.Dir(),
		"size":        string(initResult.Size),
		"spec_type":   string(initResult.SpecType),
		"files":       initResult.Files,
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

		// Knowledge feedback: search related memories for the new task.
		if description != "" {
			if suggestions := searchRelatedKnowledge(ctx, st, emb, description, 5); len(suggestions) > 0 {
				result["suggested_knowledge"] = suggestions
			}
		}
	}

	// Inject steering context for project-aware spec generation.
	if summary, err := spec.SteeringSummary(projectPath); err == nil && summary != "" {
		result["steering_context"] = summary
	} else if !spec.SteeringExists(projectPath) {
		result["steering_hint"] = "project steering docs not found — run `alfred steering-init` to generate project context for better specs"
	}

	// Suggest ledger search before starting work.
	if description != "" {
		result["suggested_search"] = "Before writing specs, search past experience: `ledger action=search query=\"" +
			truncateForHint(description, 80) +
			"\"` — you may find related patterns, decisions, or prior work."
	}

	return marshalResult(result)
}

// knowledgeSuggestion represents a related memory surfaced during spec init.
type knowledgeSuggestion struct {
	Label          string  `json:"label"`
	Source         string  `json:"source"`
	SubType        string  `json:"sub_type"`
	Content        string  `json:"content"`
	RelevanceScore float64 `json:"relevance_score"`
}

// subTypeBoost returns the relevance multiplier for a memory sub_type.
func subTypeBoost(subType string) float64 {
	switch subType {
	case store.SubTypeRule:
		return 2.0
	case store.SubTypeDecision:
		return 1.5
	case store.SubTypePattern:
		return 1.3
	default:
		return 1.0
	}
}

// searchRelatedKnowledge searches for memories related to a task description.
// Uses vector search when available, falling back to FTS5.
func searchRelatedKnowledge(ctx context.Context, st *store.Store, emb *embedder.Embedder, description string, limit int) []knowledgeSuggestion {
	var ranked []scoredDoc

	// Try vector search first.
	if emb != nil {
		vec, err := emb.EmbedForSearch(ctx, description)
		if err == nil && vec != nil {
			matches, err := st.VectorSearch(ctx, vec, "records", limit*3, store.SourceMemory)
			if err == nil && len(matches) > 0 {
				ids := make([]int64, len(matches))
				scores := make(map[int64]float64, len(matches))
				for i, m := range matches {
					ids[i] = m.SourceID
					scores[m.SourceID] = m.Score
				}
				fetched, err := st.GetDocsByIDs(ctx, ids)
				if err == nil {
					for _, d := range fetched {
						baseScore := scores[d.ID] // vector similarity in [0, 1]
						ranked = append(ranked, scoredDoc{doc: d, score: baseScore * subTypeBoost(d.SubType)})
					}
				}
			}
		}
	}

	// Fallback to FTS5: use position-based scoring (1.0 for first, decaying).
	if len(ranked) == 0 {
		docs, err := st.SearchMemoriesFTS(ctx, description, limit*3)
		if err != nil || len(docs) == 0 {
			return nil
		}
		for i, d := range docs {
			baseScore := 1.0 / float64(i+1) // rank-based: 1.0, 0.5, 0.33, ...
			ranked = append(ranked, scoredDoc{doc: d, score: baseScore * subTypeBoost(d.SubType)})
		}
	}

	// Sort by score descending.
	slices.SortFunc(ranked, func(a, b scoredDoc) int {
		if a.score > b.score {
			return -1
		}
		if a.score < b.score {
			return 1
		}
		return 0
	})

	// Build suggestions.
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	suggestions := make([]knowledgeSuggestion, len(ranked))
	for i, r := range ranked {
		content := r.doc.Content
		// Truncate at rune boundary to avoid splitting multi-byte characters.
		runes := []rune(content)
		if len(runes) > 500 {
			content = string(runes[:500]) + "..."
		}
		suggestions[i] = knowledgeSuggestion{
			Label:          r.doc.SectionPath,
			Source:         r.doc.SourceType,
			SubType:        r.doc.SubType,
			Content:        content,
			RelevanceScore: r.score,
		}
	}
	return suggestions
}

func specDoUpdate(ctx context.Context, req mcp.CallToolRequest, st *store.Store, emb *embedder.Embedder) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	fileName := req.GetString("file", "")
	if fileName == "" {
		return mcp.NewToolResultError("file is required (one of: " + validFileList() + ")"), nil
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

	// Route steering/ prefixed files to steering doc update.
	if strings.HasPrefix(fileName, "steering/") {
		return specDoUpdateSteering(projectPath, fileName, content, mode)
	}

	sf, ok := validSpecFiles[fileName]
	if !ok {
		return mcp.NewToolResultError(fmt.Sprintf("invalid file: %s (valid: %s, steering/product.md, steering/structure.md, steering/tech.md)", fileName, validFileList())), nil
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

	// After session.md update: check if all Next Steps are completed → auto-complete.
	// Uses the full completion path (decisions persistence + audit + epic sync).
	if sf == spec.FileSession {
		if ns := extractNextSteps(content); ns != "" && allStepsCompleted(ns) {
			savedDecs := 0
			if st != nil {
				savedDecs = persistSpecDecisions(ctx, sd, taskSlug, st)
			}
			detail := buildCompletionDetail(sd, savedDecs)
			spec.AppendAudit(projectPath, spec.AuditEntry{Action: "spec.complete", Target: taskSlug, Detail: detail, User: "auto"})
			if newPrimary, err := spec.CompleteTask(projectPath, taskSlug); err == nil {
				epic.SyncTaskStatus(projectPath, taskSlug, epic.StatusCompleted)
				result["auto_completed"] = true
				result["new_primary"] = newPrimary
				result["decisions_saved"] = savedDecs
			}
		}
	}

	return marshalResult(result)
}

// specDoUpdateSteering handles dossier update for steering/ prefixed file paths.
func specDoUpdateSteering(projectPath, fileName, content, mode string) (*mcp.CallToolResult, error) {
	// Validate steering file name.
	steeringName := strings.TrimPrefix(fileName, "steering/")
	validSteering := map[string]spec.SteeringFile{
		"product.md":   spec.SteeringProduct,
		"structure.md": spec.SteeringStructure,
		"tech.md":      spec.SteeringTech,
	}
	sf, ok := validSteering[steeringName]
	if !ok {
		return mcp.NewToolResultError(fmt.Sprintf("invalid steering file: %s (valid: steering/product.md, steering/structure.md, steering/tech.md)", fileName)), nil
	}

	dir := spec.SteeringDir(projectPath)
	filePath := filepath.Join(dir, string(sf))

	// Ensure directory exists.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("create steering dir: %v", err)), nil
	}

	switch mode {
	case "replace":
		if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("write failed: %v", err)), nil
		}
	default: // append
		existing, _ := os.ReadFile(filePath)
		if err := os.WriteFile(filePath, append(existing, []byte(content)...), 0o644); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("append failed: %v", err)), nil
		}
	}

	return marshalResult(map[string]any{
		"file": fileName,
		"mode": mode,
	})
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

	// Include lifecycle status, size, and spec_type from _active.md.
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug {
				if t.Status == spec.TaskCompleted {
					result["lifecycle"] = "completed"
					result["completed_at"] = t.CompletedAt
				} else {
					result["lifecycle"] = "active"
				}
				if t.StartedAt != "" {
					result["started_at"] = t.StartedAt
				}
				result["size"] = string(t.EffectiveSize())
				result["spec_type"] = string(t.EffectiveSpecType())
				break
			}
		}
	}

	// Read all spec files for complete context restoration (skips missing files).
	confidence := map[string]any{}
	for _, f := range spec.AllFiles {
		content, err := sd.ReadFile(f)
		if err != nil {
			continue
		}
		key := strings.TrimSuffix(string(f), ".md")
		result[key] = content

		// Parse confidence annotations for all files that contain them.
		if cs := parseConfidenceScores(content); cs.Total > 0 {
			confidence[key] = cs
		}
	}
	if len(confidence) > 0 {
		result["confidence"] = confidence
	}

	// Collect cross-references.
	outgoing := spec.CollectOutgoing(projectPath, taskSlug)
	incoming := spec.CollectIncoming(projectPath, taskSlug)
	if len(outgoing) > 0 || len(incoming) > 0 {
		refs := map[string]any{}
		if len(outgoing) > 0 {
			refs["outgoing"] = outgoing
		}
		if len(incoming) > 0 {
			refs["incoming"] = incoming
		}
		result["references"] = refs
	}

	// Suggest the next logical action based on spec state.
	if nextAction := suggestNextAction(sd, result); nextAction != "" {
		result["next_action"] = nextAction
	}

	// Enrich with session continuity info if available.
	sessionID := os.Getenv("CLAUDE_SESSION_ID")
	if sessionID != "" {
		if st, err := store.OpenDefaultCached(); err == nil {
			masterID := st.ResolveMasterSession(context.Background(), sessionID)
			if sc, err := st.GetSessionContinuity(context.Background(), masterID); err == nil && sc.CompactCount > 0 {
				result["session_continuity"] = map[string]any{
					"current_session": sessionID,
					"master_session":  masterID,
					"compact_count":   sc.CompactCount,
				}
			}
		}
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

	// Prevent switching to a completed task.
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug && t.Status == spec.TaskCompleted {
				return mcp.NewToolResultError(fmt.Sprintf("task %q is completed; use action=init to create a new task or action=delete to remove", taskSlug)), nil
			}
		}
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

func specDoComplete(ctx context.Context, req mcp.CallToolRequest, st *store.Store) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}
	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		// Default to primary task.
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}
	if !spec.ValidSlug.MatchString(taskSlug) {
		return mcp.NewToolResultError(fmt.Sprintf("invalid task_slug: %q", taskSlug)), nil
	}

	// Update session.md status to "completed".
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if sd.Exists() {
		if session, err := sd.ReadFile(spec.FileSession); err == nil {
			updated := setSessionStatus(session, "completed")
			_ = sd.WriteFile(ctx, spec.FileSession, updated)
		}
	}

	// Auto-save decisions from decisions.md as permanent memory.
	savedDecisions := 0
	if sd.Exists() && st != nil {
		savedDecisions = persistSpecDecisions(ctx, sd, taskSlug, st)
	}

	// Build audit detail with summary of what was accomplished.
	auditDetail := buildCompletionDetail(sd, savedDecisions)

	// Mark task as completed in _active.md.
	spec.AppendAudit(projectPath, spec.AuditEntry{Action: "spec.complete", Target: taskSlug, Detail: auditDetail, User: "mcp"})
	newPrimary, err := spec.CompleteTask(projectPath, taskSlug)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("complete failed: %v", err)), nil
	}

	// Sync epic status if linked.
	epic.SyncTaskStatus(projectPath, taskSlug, epic.StatusCompleted)

	result := map[string]any{
		"completed":       taskSlug,
		"new_primary":     newPrimary,
		"decisions_saved": savedDecisions,
	}

	// Compute duration.
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug && t.StartedAt != "" && t.CompletedAt != "" {
				if start, err := time.Parse(time.RFC3339, t.StartedAt); err == nil {
					if end, err2 := time.Parse(time.RFC3339, t.CompletedAt); err2 == nil {
						result["duration"] = end.Sub(start).Round(time.Minute).String()
					}
				}
			}
		}
	}

	return marshalResult(result)
}

// setSessionStatus replaces the Status line in session.md content.
func setSessionStatus(content, newStatus string) string {
	var b strings.Builder
	foundHeader := false
	replaced := false
	for line := range strings.SplitSeq(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "## Status" {
			foundHeader = true
			b.WriteString(line + "\n")
			continue
		}
		if foundHeader && !replaced && trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			b.WriteString(newStatus + "\n")
			replaced = true
			continue
		}
		b.WriteString(line + "\n")
	}
	// Trim trailing extra newline from loop.
	result := b.String()
	if strings.HasSuffix(result, "\n\n") && !strings.HasSuffix(content, "\n\n") {
		result = result[:len(result)-1]
	}
	return result
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
		// Include lifecycle status in preview.
		if state != nil {
			for _, t := range state.Tasks {
				if t.Slug == taskSlug {
					if t.Status == spec.TaskCompleted {
						preview["task_status"] = "completed"
						preview["completed_at"] = t.CompletedAt
					} else {
						preview["task_status"] = "active"
					}
					break
				}
			}
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
		// Warn about incoming references that will become dangling.
		if incoming := spec.CollectIncoming(projectPath, taskSlug); len(incoming) > 0 {
			preview["dangling_warning"] = fmt.Sprintf("%d reference(s) from other specs will become dangling", len(incoming))
			preview["incoming_refs"] = incoming
		}
		preview["next_step"] = "call again with confirm=true to delete"
		return marshalResult(preview)
	}

	// With confirm: actually delete.
	spec.AppendAudit(projectPath, spec.AuditEntry{Action: "spec.delete", Target: taskSlug, User: "mcp"})
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
		return mcp.NewToolResultError("file is required (one of: " + validFileList() + ")"), nil
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
	Avg            float64          `json:"avg"`
	Total          int              `json:"total_items"`
	LowCount       int              `json:"low_items"`                          // items with score <= 5
	Items          []confidenceItem `json:"items,omitempty"`
	Warnings       []string         `json:"low_confidence_warnings,omitempty"`  // sections with score <= 5 and source=assumption
	GroundingDist  map[string]int   `json:"grounding_distribution,omitempty"`   // count per grounding level
	GroundingWarns []string         `json:"grounding_warnings,omitempty"`       // high confidence + speculative, unknown values
}

type confidenceItem struct {
	Section   string `json:"section"`
	Score     int    `json:"score"`
	Source    string `json:"source,omitempty"`    // user, design-doc, code, inference, assumption
	Grounding string `json:"grounding,omitempty"` // verified, reviewed, inferred, speculative
}

// specDoReview returns the latest review status and comments for a task.
// Claude Code calls this to check if the user has approved or requested changes.
func specDoReview(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}

	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("spec not found: %s", taskSlug)), nil
	}

	// Get review status from _active.md.
	reviewStatus := spec.ReviewStatusFor(projectPath, taskSlug)

	// Get latest review with comments.
	latest, err := sd.LatestReview()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("read review: %v", err)), nil
	}

	result := map[string]any{
		"task_slug":     taskSlug,
		"review_status": string(reviewStatus),
	}

	if latest != nil {
		result["latest_review"] = map[string]any{
			"timestamp": latest.Timestamp.Format(time.RFC3339),
			"status":    string(latest.Status),
			"summary":   latest.Summary,
		}

		if len(latest.Comments) > 0 {
			comments := make([]map[string]any, len(latest.Comments))
			for i, c := range latest.Comments {
				comments[i] = map[string]any{
					"file":     c.File,
					"line":     c.Line,
					"body":     c.Body,
					"resolved": c.Resolved,
				}
			}
			result["comments"] = comments
		}

		// Count unresolved.
		unresolved := 0
		for _, c := range latest.Comments {
			if !c.Resolved {
				unresolved++
			}
		}
		result["unresolved_count"] = unresolved
	} else {
		result["latest_review"] = nil
	}

	return marshalResult(result)
}

func specDoValidate(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
	if errResult != nil {
		return errResult, nil
	}

	taskSlug := req.GetString("task_slug", "")
	if taskSlug == "" {
		var err error
		taskSlug, err = spec.ReadActive(projectPath)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("no active spec: %v", err)), nil
		}
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return mcp.NewToolResultError(fmt.Sprintf("spec not found: %s", taskSlug)), nil
	}

	// Read size and spec_type from ActiveTask (default L/feature for backward compat).
	size := spec.SizeL
	specType := spec.TypeFeature
	if state, err := spec.ReadActiveState(projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug {
				size = t.EffectiveSize()
				specType = t.EffectiveSpecType()
				break
			}
		}
	}

	report, err := spec.Validate(sd, size, specType)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("validate failed: %v", err)), nil
	}

	return marshalResult(report)
}

// confidenceRe matches <!-- confidence: N --> or <!-- confidence: N | source: TYPE --> or
// <!-- confidence: N | source: TYPE | grounding: LEVEL --> annotations.
var confidenceRe = regexp.MustCompile(`<!--\s*confidence:\s*(\d{1,2})(?:\s*\|\s*source:\s*([\w][\w-]*))?(?:\s*\|\s*grounding:\s*([\w]+))?\s*-->`)

// validGroundings defines the accepted grounding levels.
var validGroundings = map[string]bool{
	"verified": true, "reviewed": true, "inferred": true, "speculative": true,
}

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
	var groundingWarns []string
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
		source := ""
		if len(matches) >= 3 {
			source = matches[2]
		}
		grounding := ""
		if len(matches) >= 4 && matches[3] != "" {
			if validGroundings[matches[3]] {
				grounding = matches[3]
			} else {
				groundingWarns = append(groundingWarns, fmt.Sprintf("unknown grounding %q in section: %s", matches[3], section))
			}
		}
		items = append(items, confidenceItem{Section: section, Score: score, Source: source, Grounding: grounding})
	}

	if len(items) == 0 {
		return confidenceSummary{}
	}

	total := 0
	lowCount := 0
	var warnings []string
	groundingDist := map[string]int{}
	for _, item := range items {
		total += item.Score
		if item.Score <= 5 {
			lowCount++
			if item.Source == "assumption" {
				warnings = append(warnings, item.Section)
			}
		}
		if item.Grounding != "" {
			groundingDist[item.Grounding]++
		}
		if item.Grounding == "speculative" && item.Score > 5 {
			groundingWarns = append(groundingWarns, fmt.Sprintf("high confidence (%d) with speculative grounding in section: %s", item.Score, item.Section))
		}
	}

	return confidenceSummary{
		Avg:            float64(total) / float64(len(items)),
		Total:          len(items),
		LowCount:       lowCount,
		Items:          items,
		Warnings:       warnings,
		GroundingDist:  groundingDist,
		GroundingWarns: groundingWarns,
	}
}

// buildCompletionDetail creates a summary string for the audit log on task completion.
func buildCompletionDetail(sd *spec.SpecDir, decisionsSaved int) string {
	parts := []string{}

	// Count modified files from session.md.
	if session, err := sd.ReadFile(spec.FileSession); err == nil {
		modSection := extractMarkdownSection(session, "## Modified Files")
		if modSection != "" {
			count := 0
			for line := range strings.SplitSeq(modSection, "\n") {
				if strings.HasPrefix(strings.TrimSpace(line), "- ") {
					count++
				}
			}
			if count > 0 {
				parts = append(parts, fmt.Sprintf("%d files modified", count))
			}
		}
	}

	if decisionsSaved > 0 {
		parts = append(parts, fmt.Sprintf("%d decisions saved", decisionsSaved))
	}

	// Count spec files present (check all known files including bugfix.md).
	fileCount := 0
	for _, f := range spec.AllFiles {
		if _, err := sd.ReadFile(f); err == nil {
			fileCount++
		}
	}
	if _, err := sd.ReadFile(spec.FileBugfix); err == nil {
		fileCount++
	}
	parts = append(parts, fmt.Sprintf("%d spec files", fileCount))

	return strings.Join(parts, ", ")
}

// extractMarkdownSection extracts a named section from content.
func extractMarkdownSection(content, heading string) string {
	idx := strings.Index(content, heading)
	if idx < 0 {
		return ""
	}
	rest := content[idx+len(heading):]
	if end := strings.Index(rest, "\n## "); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

// persistSpecDecisions reads decisions.md and saves each DEC-N entry as a permanent memory.
// Returns the number of decisions saved.
func persistSpecDecisions(ctx context.Context, sd *spec.SpecDir, taskSlug string, st *store.Store) int {
	content, err := sd.ReadFile(spec.FileDecisions)
	if err != nil || content == "" {
		return 0
	}

	// Parse DEC-N sections: split on ## headings.
	var saved int
	sections := strings.Split(content, "\n## ")
	for _, sec := range sections[1:] { // skip header before first ##
		lines := strings.SplitN(sec, "\n", 2)
		if len(lines) < 2 {
			continue
		}
		title := strings.TrimSpace(lines[0])
		body := strings.TrimSpace(lines[1])
		if title == "" || body == "" {
			continue
		}
		// Skip template/example entries (template placeholders or example blocks).
		if strings.Contains(title, "{") || strings.Contains(title, "example") ||
			strings.Contains(body, "<!-- example") || strings.Contains(body, "-- >") {
			continue
		}

		url := fmt.Sprintf("memory://spec-decision/%s/%s", taskSlug, strings.ReplaceAll(strings.ToLower(title), " ", "-"))
		label := taskSlug + " > " + title

		_, changed, err := st.UpsertDoc(ctx, &store.DocRow{
			URL:         url,
			SectionPath: label,
			Content:     "## " + title + "\n" + body,
			SourceType:  store.SourceMemory,
			SubType:     "decision",
			TTLDays:     0, // permanent
		})
		if err == nil && changed {
			saved++
		}
	}
	return saved
}

// extractNextSteps extracts the Next Steps section from session.md content.
func extractNextSteps(content string) string {
	const heading = "## Next Steps"
	idx := strings.Index(content, heading)
	if idx < 0 {
		return ""
	}
	rest := content[idx+len(heading):]
	// Find next ## heading.
	if end := strings.Index(rest, "\n## "); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

// allStepsCompleted returns true if all checkbox items are checked.
func allStepsCompleted(nextSteps string) bool {
	hasItems := false
	for line := range strings.SplitSeq(nextSteps, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			hasItems = true
			continue
		}
		if strings.HasPrefix(trimmed, "- [ ] ") {
			return false
		}
	}
	return hasItems
}

// truncateForHint shortens a string to maxRunes, adding "..." if truncated.
func truncateForHint(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "..."
}

// hasOnlyCheckedSteps returns true if a Next Steps section has at least one item
// and all items are checked.
func hasOnlyCheckedSteps(section string) bool {
	hasItems := false
	for _, line := range strings.Split(section, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			hasItems = true
			continue
		}
		if strings.HasPrefix(trimmed, "- [ ] ") {
			return false
		}
	}
	return hasItems
}

// suggestNextAction returns a contextual next-action hint based on the spec's current state.
// Returns "" when no specific suggestion is warranted.
func suggestNextAction(sd *spec.SpecDir, _ map[string]any) string {
	state, stateErr := spec.ReadActiveState(sd.ProjectPath)

	// Check review status.
	if stateErr == nil {
		for _, t := range state.Tasks {
			if t.Slug == sd.TaskSlug && t.ReviewStatus == "pending" {
				return "Run `alfred dashboard` to review and approve the spec before implementation."
			}
		}
	}

	// Check if all Next Steps are completed.
	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		return ""
	}

	nextSection := extractMarkdownSection(session, "## Next Steps")
	if nextSection != "" && hasOnlyCheckedSteps(nextSection) {
		return "All Next Steps are completed. Call `dossier action=complete` to close the task and save decisions to memory."
	}

	// Suggest epic management when 3+ tasks exist without an epic.
	if stateErr == nil {
		activeTasks := 0
		for _, t := range state.Tasks {
			if t.IsActive() {
				activeTasks++
			}
		}
		if activeTasks >= 3 {
			if len(epic.ListAll(sd.ProjectPath)) == 0 {
				return "You have " + strconv.Itoa(activeTasks) + " active tasks. Consider grouping them with `roster action=init` for dependency tracking and progress overview."
			}
		}
	}

	return ""
}
