package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// bgEmbedWG tracks in-flight background embedding goroutines.
var bgEmbedWG sync.WaitGroup

// WaitBackground blocks until all background embedding goroutines complete.
// Call during graceful shutdown to ensure all embeddings are persisted.
func WaitBackground() { bgEmbedWG.Wait() }

// recallHandler provides memory-specific search and save operations.
func recallHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		action := req.GetString("action", "search")

		switch action {
		case "search":
			return recallSearch(ctx, st, emb, req)
		case "save":
			return recallSave(ctx, st, emb, req)
		case "promote":
			return recallPromote(ctx, st, req)
		case "candidates":
			return recallCandidates(ctx, st)
		case "reflect":
			return recallReflect(ctx, st, emb)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action %q: use search, save, promote, candidates, or reflect", action)), nil
		}
	}
}

// recallSearch searches memory entries using vector search with keyword fallback.
func recallSearch(ctx context.Context, st *store.Store, emb *embedder.Embedder, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	query := req.GetString("query", "")
	if query == "" {
		return mcp.NewToolResultError("query parameter is required for search"), nil
	}
	if len([]rune(query)) > 10000 {
		return mcp.NewToolResultError("query too long (max 10000 characters)"), nil
	}
	limit := req.GetInt("limit", 10)
	if limit < 1 {
		limit = 10
	}
	limitCapped := false
	if limit > 100 {
		limit = 100
		limitCapped = true
	}

	overRetrieve := limit * 4
	if overRetrieve < 20 {
		overRetrieve = 20
	}

	// Search both memories and past specs — long-term knowledge that grows with use.
	sr := SearchPipeline(ctx, st, emb, query, store.SourceMemory+","+store.SourceSpec, limit, overRetrieve)
	docs := sr.Docs
	searchMethod := sr.SearchMethod
	warnings := sr.Warnings

	// Track hit counts for search results (not during benchmarks).
	TrackHitCounts(ctx, st, docs)

	// Post-filter by sub_type if requested.
	if subType := req.GetString("sub_type", ""); subType != "" {
		filtered := docs[:0]
		for _, d := range docs {
			if d.SubType == subType {
				filtered = append(filtered, d)
			}
		}
		docs = filtered
	}

	// Progressive Disclosure: detail level controls response verbosity.
	detail := req.GetString("detail", "summary")
	if detail != "compact" && detail != "summary" && detail != "full" {
		detail = "summary"
	}

	results := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		dm := map[string]any{
			"section_path": d.SectionPath,
			"source_type":  d.SourceType,
		}
		if d.SubType != "" && d.SubType != store.SubTypeGeneral {
			dm["sub_type"] = d.SubType
		}
		switch detail {
		case "compact":
			// Label + source only — minimal tokens.
		case "summary":
			dm["content"] = truncate(d.Content, 200)
			dm["url"] = d.URL
			if d.CrawledAt != "" {
				dm["saved_at"] = d.CrawledAt
			}
		case "full":
			dm["content"] = d.Content
			dm["url"] = d.URL
			if d.CrawledAt != "" {
				dm["saved_at"] = d.CrawledAt
			}
		}
		// Include structured data when available.
		if d.Structured != "" {
			dm["structured"] = json.RawMessage(d.Structured)
		}
		results = append(results, dm)
	}

	result := map[string]any{
		"query":         query,
		"results":       results,
		"count":         len(results),
		"search_method": searchMethod,
	}
	if limitCapped {
		warnings = append(warnings, "limit capped to 100 (maximum allowed)")
	}
	if len(warnings) > 0 {
		result["warning"] = strings.Join(warnings, "; ")
	}
	return marshalResult(result)
}

// maxContentBytes limits content size for MCP write operations (256KB).
// Shared by recall save and spec update to prevent oversized payloads
// from bloating the DB and embedding pipeline.
const maxContentBytes = 256 * 1024

// recallSave saves a new memory entry to the knowledge base.
// If an embedder is available, it asynchronously generates an embedding for semantic search.
func recallSave(ctx context.Context, st *store.Store, emb *embedder.Embedder, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	content := req.GetString("content", "")
	if content == "" {
		return mcp.NewToolResultError("content parameter is required for save"), nil
	}
	if len(content) > maxContentBytes {
		return mcp.NewToolResultError(fmt.Sprintf("content too large: %d bytes (max %d bytes / 256KB)", len(content), maxContentBytes)), nil
	}
	label := req.GetString("label", "")
	if label == "" {
		return mcp.NewToolResultError("label parameter is required for save (short description)"), nil
	}
	project := req.GetString("project", "general")
	subType := req.GetString("sub_type", store.SubTypeGeneral)

	// Validate sub_type.
	switch subType {
	case store.SubTypeGeneral, store.SubTypeDecision, store.SubTypePattern, store.SubTypeRule:
		// valid
	default:
		return mcp.NewToolResultError(fmt.Sprintf("invalid sub_type %q: use general, decision, pattern, or rule", subType)), nil
	}

	// Validate project name to prevent path traversal and section_path parsing issues.
	if !spec.ValidSlug.MatchString(project) {
		return mcp.NewToolResultError("invalid project name: use lowercase letters, digits, and hyphens only (max 64 chars)"), nil
	}

	// Optional structured fields.
	title := req.GetString("title", "")
	contextText := req.GetString("context_text", "")
	reasoning := req.GetString("reasoning", "")
	alternatives := req.GetString("alternatives", "")
	category := req.GetString("category", "")
	priority := req.GetString("priority", "")

	hasStructured := title != "" || contextText != "" || reasoning != "" ||
		alternatives != "" || category != "" || priority != ""

	var structured string // JSON for doc.Structured
	if hasStructured {
		now := time.Now().UTC().Format(time.RFC3339)
		switch subType {
		case store.SubTypeDecision:
			dec := &store.StructuredDecision{
				ID:        fmt.Sprintf("dec-%s", sanitizeID(label)),
				Title:     orDefault(title, label),
				Context:   contextText,
				Decision:  strings.TrimSpace(content),
				Reasoning: reasoning,
				Tags:      []string{},
				Status:    "draft",
				CreatedAt: now,
			}
			if alternatives != "" {
				dec.Alternatives = splitCSV(alternatives)
			}
			content = dec.ToContent()
			data, _ := json.Marshal(dec)
			structured = string(data)
			// Best-effort JSON file save.
			projectPath := resolveProjectPath(req)
			if _, err := store.SaveDecision(projectPath, dec); err != nil {
				fmt.Fprintf(os.Stderr, "alfred: save decision json: %v\n", err)
			}
		case store.SubTypePattern:
			pat := &store.StructuredPattern{
				ID:                    fmt.Sprintf("pat-%s", sanitizeID(label)),
				Type:                  "good",
				Title:                 orDefault(title, label),
				Context:               contextText,
				Pattern:               strings.TrimSpace(content),
				ApplicationConditions: reasoning, // reuse reasoning as conditions
				Tags:                  []string{},
				Status:                "draft",
				CreatedAt:             now,
			}
			content = pat.ToContent()
			data, _ := json.Marshal(pat)
			structured = string(data)
			projectPath := resolveProjectPath(req)
			if err := store.SavePattern(projectPath, pat); err != nil {
				fmt.Fprintf(os.Stderr, "alfred: save pattern json: %v\n", err)
			}
		case store.SubTypeRule:
			rule := &store.StructuredRule{
				ID:        fmt.Sprintf("rule-%s", sanitizeID(label)),
				Key:       sanitizeID(label),
				Text:      strings.TrimSpace(content),
				Category:  category,
				Priority:  priority,
				Rationale: reasoning,
				Tags:      []string{},
				Status:    "draft",
				CreatedAt: now,
			}
			content = rule.ToContent()
			data, _ := json.Marshal(rule)
			structured = string(data)
			projectPath := resolveProjectPath(req)
			if err := store.SaveRule(projectPath, rule); err != nil {
				fmt.Fprintf(os.Stderr, "alfred: save rule json: %v\n", err)
			}
		}
		// For sub_types without a structured mapping (general), ignore structured fields.
	}

	ts := time.Now().Format("2006-01-02T150405")
	url := fmt.Sprintf("memory://user/%s/manual/%s", project, ts)
	sectionPath := fmt.Sprintf("%s > manual > %s", project, truncate(label, 60))

	id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
		URL:         url,
		SectionPath: sectionPath,
		Content:     strings.TrimSpace(content),
		SourceType:  store.SourceMemory,
		SubType:     subType,
		TTLDays:     0, // permanent
		Structured:  structured,
	})
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("save failed: %v", err)), nil
	}

	status := "saved"
	if !changed {
		status = "unchanged (duplicate)"
	}

	// Async embedding: generate vector for semantic recall search.
	// Tracked by bgEmbedWG for graceful shutdown; embedding failure only degrades vector search.
	if emb != nil && changed {
		bgEmbedWG.Add(1)
		go func() {
			defer bgEmbedWG.Done()
			embCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			vec, err := emb.EmbedForStorage(embCtx, strings.TrimSpace(content))
			if err != nil {
				return
			}
			_ = st.InsertEmbedding("records", id, emb.Model(), vec)
		}()
	}

	embeddingStatus := "none"
	if emb != nil && changed {
		embeddingStatus = "pending"
	}

	return marshalResult(map[string]any{
		"status":           status,
		"id":               id,
		"section_path":     sectionPath,
		"url":              url,
		"embedding_status": embeddingStatus,
	})
}

// recallPromote promotes a memory's sub_type (general→pattern or pattern→rule).
func recallPromote(ctx context.Context, st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id := int64(req.GetInt("id", 0))
	if id <= 0 {
		return mcp.NewToolResultError("id parameter is required (positive integer)"), nil
	}
	newSubType := req.GetString("sub_type", "")
	if newSubType == "" {
		return mcp.NewToolResultError("sub_type parameter is required (pattern or rule)"), nil
	}

	if err := st.PromoteSubType(ctx, id, newSubType); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("promotion failed: %v", err)), nil
	}
	return marshalResult(map[string]any{
		"status":       "promoted",
		"id":           id,
		"new_sub_type": newSubType,
	})
}

// recallCandidates returns memories that qualify for sub_type promotion.
func recallCandidates(ctx context.Context, st *store.Store) (*mcp.CallToolResult, error) {
	docs, err := st.GetPromotionCandidates(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed: %v", err)), nil
	}

	results := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		suggested := store.SubTypePattern
		if d.SubType == store.SubTypePattern {
			suggested = store.SubTypeRule
		}
		results = append(results, map[string]any{
			"id":            d.ID,
			"section_path":  d.SectionPath,
			"hit_count":     d.HitCount,
			"current_type":  d.SubType,
			"suggested":     suggested,
			"last_accessed": d.LastAccessed,
			"content":       truncate(d.Content, 200),
		})
	}
	return marshalResult(map[string]any{
		"candidates": results,
		"count":      len(results),
		"thresholds": map[string]int{
			"general_to_pattern": store.PromoteToPatternHits,
			"pattern_to_rule":    store.PromoteToRuleHits,
		},
	})
}

// recallReflect generates a read-only health report for the knowledge base.
func recallReflect(ctx context.Context, st *store.Store, emb *embedder.Embedder) (*mcp.CallToolResult, error) {
	result := map[string]any{}

	// 1. Memory stats.
	stats, err := st.GetMemoryStats(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("stats failed: %v", err)), nil
	}
	topAccessed := make([]map[string]any, 0, len(stats.TopAccessed))
	for _, d := range stats.TopAccessed {
		topAccessed = append(topAccessed, map[string]any{
			"section_path": d.SectionPath,
			"hit_count":    d.HitCount,
			"sub_type":     d.SubType,
		})
	}
	result["summary"] = map[string]any{
		"total_memories": stats.Total,
		"by_sub_type":    stats.BySubType,
		"avg_hit_count":  math.Round(stats.AvgHitCount*100) / 100,
		"most_accessed":  topAccessed,
	}

	// 2. Conflicts (requires embeddings).
	if emb != nil {
		conflicts, err := st.DetectConflicts(ctx, 0.75)
		if err != nil {
			result["conflicts_warning"] = fmt.Sprintf("conflict detection failed: %v", err)
		} else {
			conflictList := make([]map[string]any, 0, len(conflicts))
			for _, c := range conflicts {
				conflictList = append(conflictList, map[string]any{
					"doc_a":      truncate(c.DocA.SectionPath, 80),
					"doc_b":      truncate(c.DocB.SectionPath, 80),
					"similarity": math.Round(c.Similarity*1000) / 1000,
				})
			}
			result["conflicts"] = conflictList
		}
	} else {
		result["conflicts_warning"] = "conflict detection requires VOYAGE_API_KEY (embeddings needed for cosine similarity)"
	}

	// 3. Stale memories.
	stale, err := st.GetStaleMemories(ctx, 90)
	if err != nil {
		result["stale_warning"] = fmt.Sprintf("stale detection failed: %v", err)
	} else {
		staleList := make([]map[string]any, 0, len(stale))
		for _, d := range stale {
			accessDate := d.LastAccessed
			if accessDate == "" {
				accessDate = d.CrawledAt + " (created, never accessed)"
			}
			staleList = append(staleList, map[string]any{
				"id":            d.ID,
				"section_path":  d.SectionPath,
				"last_accessed": accessDate,
				"hit_count":     d.HitCount,
			})
		}
		result["stale"] = staleList
	}

	// 4. Promotion candidates.
	candidates, err := st.GetPromotionCandidates(ctx)
	if err == nil && len(candidates) > 0 {
		candList := make([]map[string]any, 0, len(candidates))
		for _, d := range candidates {
			suggested := store.SubTypePattern
			if d.SubType == store.SubTypePattern {
				suggested = store.SubTypeRule
			}
			candList = append(candList, map[string]any{
				"id":           d.ID,
				"section_path": d.SectionPath,
				"hit_count":    d.HitCount,
				"current":      d.SubType,
				"suggested":    suggested,
			})
		}
		result["promotion_candidates"] = candList
	}

	return marshalResult(result)
}

// sanitizeID converts a label into a lowercase slug suitable for structured IDs.
func sanitizeID(label string) string {
	s := strings.ToLower(strings.TrimSpace(label))
	s = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		if r == '-' || r == ' ' {
			return '-'
		}
		return -1 // drop non-ASCII
	}, s)
	// Collapse consecutive hyphens.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		s = "untitled"
	}
	return s
}

// splitCSV splits a comma-separated string into trimmed non-empty parts.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	result := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

// orDefault returns s if non-empty, otherwise def.
func orDefault(s, def string) string {
	if s != "" {
		return s
	}
	return def
}

// resolveProjectPath gets the project path from the request or falls back to cwd.
func resolveProjectPath(req mcp.CallToolRequest) string {
	if p := req.GetString("project_path", ""); p != "" {
		return p
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}
