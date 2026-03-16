package mcpserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
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
			return recallReflect(ctx, st, emb, req)
		case "stale":
			return recallStale(ctx, st, req)
		case "audit-conventions":
			return recallAuditConventions(ctx, st, req)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action %q: use search, save, promote, candidates, stale, reflect, or audit-conventions", action)), nil
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

	// Optional validity window parameters.
	validUntil := req.GetString("valid_until", "")
	if validUntil != "" {
		if _, err := time.Parse(time.RFC3339, validUntil); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("invalid valid_until format (use RFC3339): %v", err)), nil
		}
	}
	reviewBy := req.GetString("review_by", "")
	if reviewBy != "" {
		if _, err := time.Parse(time.RFC3339, reviewBy); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("invalid review_by format (use RFC3339): %v", err)), nil
		}
	}

	ts := time.Now().Format("2006-01-02T150405")
	url := fmt.Sprintf("memory://user/%s/manual/%s", project, ts)
	sectionPath := fmt.Sprintf("%s > manual > %s", project, truncate(label, 60))

	doc := &store.DocRow{
		URL:         url,
		SectionPath: sectionPath,
		Content:     strings.TrimSpace(content),
		SourceType:  store.SourceMemory,
		SubType:     subType,
		TTLDays:     0, // permanent
		Structured:  structured,
		ValidUntil:  validUntil,
		ReviewBy:    reviewBy,
	}
	id, changed, err := st.UpsertDoc(ctx, doc)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("save failed: %v", err)), nil
	}

	status := "saved"
	if !changed {
		status = "unchanged (duplicate)"
	}

	// Memory versioning: find existing memories with the same section_path
	// that are not already superseded, and chain them.
	var supersededID int64
	if changed {
		supersededID, _ = versionMemory(ctx, st, id, sectionPath)
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

	result := map[string]any{
		"status":           status,
		"id":               id,
		"section_path":     sectionPath,
		"url":              url,
		"embedding_status": embeddingStatus,
	}
	if supersededID > 0 {
		result["superseded_id"] = supersededID
		result["versioning"] = "previous version superseded"
	}
	return marshalResult(result)
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

// recallStale returns low-vitality memories with their computed scores.
func recallStale(ctx context.Context, st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	threshold := float64(req.GetInt("threshold", 20))
	if threshold <= 0 {
		threshold = 20.0
	}

	docs, err := st.ListLowVitality(ctx, threshold, 50)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("stale query failed: %v", err)), nil
	}

	results := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		accessDate := d.LastAccessed
		if accessDate == "" {
			accessDate = d.CrawledAt + " (created, never accessed)"
		}
		results = append(results, map[string]any{
			"id":             d.ID,
			"section_path":   d.SectionPath,
			"vitality_score": math.Round(d.Vitality*100) / 100,
			"hit_count":      d.HitCount,
			"last_accessed":  accessDate,
			"sub_type":       d.SubType,
		})
	}

	return marshalResult(map[string]any{
		"threshold": threshold,
		"results":   results,
		"count":     len(results),
	})
}

// recallReflect generates a read-only health report for the knowledge base.
func recallReflect(ctx context.Context, st *store.Store, emb *embedder.Embedder, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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

	// 2. Conflicts (requires embeddings) — lowered threshold to 0.70 for contradiction detection.
	if emb != nil {
		conflicts, err := st.DetectConflicts(ctx, 0.70)
		if err != nil {
			result["conflicts_warning"] = fmt.Sprintf("conflict detection failed: %v", err)
		} else {
			var duplicates []map[string]any
			var contradictions []map[string]any
			for _, c := range conflicts {
				entry := map[string]any{
					"doc_a":      truncate(c.DocA.SectionPath, 80),
					"doc_b":      truncate(c.DocB.SectionPath, 80),
					"similarity": math.Round(c.Similarity*1000) / 1000,
					"type":       c.Type,
				}
				if c.Type == "potential_contradiction" {
					contradictions = append(contradictions, entry)
				} else {
					duplicates = append(duplicates, entry)
				}
			}
			result["duplicates"] = duplicates
			result["contradictions"] = contradictions
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

	// 5. Vitality distribution.
	vitalityDist, avgVitality := computeVitalityDistribution(ctx, st)
	if vitalityDist != nil {
		result["vitality_distribution"] = vitalityDist
		result["avg_vitality"] = math.Round(avgVitality*100) / 100
	}

	// 6. Review-due memories.
	reviewDue, err := st.GetReviewDueMemories(ctx)
	if err == nil && len(reviewDue) > 0 {
		reviewList := make([]map[string]any, 0, len(reviewDue))
		for _, d := range reviewDue {
			reviewList = append(reviewList, map[string]any{
				"id":            d.ID,
				"section_path":  d.SectionPath,
				"review_by":     d.ReviewBy,
				"hit_count":     d.HitCount,
				"last_accessed": d.LastAccessed,
			})
		}
		result["review_due"] = reviewList
	}

	// 7. Expiring-soon memories (valid_until within 7 days).
	expiring, err := st.GetExpiringMemories(ctx, 7)
	if err == nil && len(expiring) > 0 {
		expiringList := make([]map[string]any, 0, len(expiring))
		for _, d := range expiring {
			expiringList = append(expiringList, map[string]any{
				"id":            d.ID,
				"section_path":  d.SectionPath,
				"valid_until":   d.ValidUntil,
				"sub_type":      d.SubType,
			})
		}
		result["expiring_soon"] = expiringList
	}

	// 8. Version chain high-churn indicators.
	chains, err := st.GetVersionChainLengths(ctx, 3)
	if err == nil && len(chains) > 0 {
		chainList := make([]map[string]any, 0, len(chains))
		for _, c := range chains {
			chainList = append(chainList, map[string]any{
				"head_id":      c.HeadID,
				"section_path": c.SectionPath,
				"chain_length": c.ChainLength,
			})
		}
		result["high_churn"] = chainList
	}

	// 9. Steering doc freshness check.
	projectPath := req.GetString("project_path", "")
	if projectPath != "" {
		if steeringWarnings := checkSteeringFreshness(projectPath); len(steeringWarnings) > 0 {
			result["steering_warnings"] = steeringWarnings
		}
	}

	// 10. Drift statistics from audit.jsonl.
	if projectPath != "" {
		if driftStats := aggregateDriftStats(projectPath); len(driftStats) > 0 {
			result["drift_stats"] = driftStats
		}
	}

	return marshalResult(result)
}

// checkSteeringFreshness checks if steering docs are stale (older than 30 days
// with recent commits).
func checkSteeringFreshness(projectPath string) []string {
	if !spec.SteeringExists(projectPath) {
		return nil
	}

	dir := spec.SteeringDir(projectPath)
	var oldestMod time.Time

	for _, f := range spec.AllSteeringFiles {
		info, err := os.Stat(filepath.Join(dir, string(f)))
		if err != nil {
			continue
		}
		mod := info.ModTime()
		if oldestMod.IsZero() || mod.Before(oldestMod) {
			oldestMod = mod
		}
	}

	if oldestMod.IsZero() {
		return nil
	}

	staleDays := 30
	if time.Since(oldestMod) < time.Duration(staleDays)*24*time.Hour {
		return nil
	}

	var warnings []string
	daysSinceUpdate := int(time.Since(oldestMod).Hours() / 24)
	warnings = append(warnings, fmt.Sprintf(
		"steering docs last modified %d days ago — consider running `alfred steering-init --force` or updating manually",
		daysSinceUpdate,
	))
	return warnings
}

// computeVitalityDistribution computes a histogram of vitality scores across all memories.
// Returns bucket counts and average vitality.
func computeVitalityDistribution(ctx context.Context, st *store.Store) (map[string]int, float64) {
	docs, err := st.ListRecentMemories(ctx, 5000) // reasonable upper bound
	if err != nil || len(docs) == 0 {
		return nil, 0
	}

	buckets := map[string]int{
		"0-20":   0,
		"21-40":  0,
		"41-60":  0,
		"61-80":  0,
		"81-100": 0,
	}
	now := time.Now()
	var totalVitality float64

	for _, d := range docs {
		vs := store.ComputeVitalityFromDoc(&d, now)
		totalVitality += vs.Total

		switch {
		case vs.Total <= 20:
			buckets["0-20"]++
		case vs.Total <= 40:
			buckets["21-40"]++
		case vs.Total <= 60:
			buckets["41-60"]++
		case vs.Total <= 80:
			buckets["61-80"]++
		default:
			buckets["81-100"]++
		}
	}

	avgVitality := totalVitality / float64(len(docs))
	return buckets, avgVitality
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

// versionMemory finds existing memories with the same section_path (but different ID)
// that are not already superseded, and sets their superseded_by to the new record.
// Returns the superseded record ID (0 if none). Also enforces max 5 chain length
// by pruning the oldest version when exceeded.
func versionMemory(ctx context.Context, st *store.Store, newID int64, sectionPath string) (int64, error) {
	// Find existing non-superseded memory with the same section_path.
	oldID, err := st.FindNonSupersededByPath(ctx, sectionPath, newID)
	if err != nil {
		return 0, nil // no previous version
	}

	// Cycle detection: walk forward from newID to ensure oldID is not in the chain.
	chain, err := st.GetVersionChain(ctx, newID, 5)
	if err != nil {
		return 0, fmt.Errorf("version chain cycle detected: %w", err)
	}
	for _, id := range chain {
		if id == oldID {
			return 0, fmt.Errorf("version chain cycle: old record %d found in chain of new record %d", oldID, newID)
		}
	}

	// Set superseded_by on old record.
	if err := st.SetSupersededBy(ctx, oldID, newID); err != nil {
		return 0, err
	}

	// Enforce max 5 versions: walk backwards from newID to count chain length.
	predecessors, _ := st.GetReverseVersionChain(ctx, newID, 6)
	if len(predecessors) >= 5 {
		// Disable the oldest (last in the backwards chain) to prevent it from
		// reappearing in search results as a phantom current memory.
		oldestID := predecessors[len(predecessors)-1]
		_ = st.SetEnabled(ctx, oldestID, false)
	}

	return oldID, nil
}

// ---------------------------------------------------------------------------
// Drift statistics aggregation from audit.jsonl
// ---------------------------------------------------------------------------

// aggregateDriftStats reads audit.jsonl and returns drift event statistics.
func aggregateDriftStats(projectPath string) map[string]any {
	entries, err := spec.ReadAuditLog(projectPath, 0) // all entries
	if err != nil || len(entries) == 0 {
		return nil
	}

	byType := map[string]int{}
	bySeverity := map[string]int{}
	unresolved := 0
	total := 0

	for _, e := range entries {
		if e.Action != "drift.spec" && e.Action != "drift.convention" {
			continue
		}
		total++

		// Parse detail JSON.
		var detail map[string]any
		if err := json.Unmarshal([]byte(e.Detail), &detail); err != nil {
			continue
		}

		// Count by type.
		driftType, _ := detail["type"].(string)
		if driftType == "" {
			driftType = "unknown"
		}
		byType[driftType]++

		// Count by severity.
		severity, _ := detail["severity"].(string)
		if severity == "" {
			severity = "warning"
		}
		bySeverity[severity]++

		// Count unresolved.
		resolution, _ := detail["resolution"].(string)
		if resolution == "" || resolution == "unresolved" {
			unresolved++
		}
	}

	if total == 0 {
		return nil
	}

	return map[string]any{
		"total":       total,
		"by_type":     byType,
		"by_severity": bySeverity,
		"unresolved":  unresolved,
	}
}

// ---------------------------------------------------------------------------
// Convention audit — validate pattern/rule memories against the codebase
// ---------------------------------------------------------------------------

// recallAuditConventions checks all enabled pattern/rule memories for codebase drift.
// Returns a list of drifted conventions with evidence.
func recallAuditConventions(ctx context.Context, st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectPath := resolveProjectPath(req)
	if projectPath == "" || projectPath == "." {
		return mcp.NewToolResultError("project_path is required for audit-conventions"), nil
	}

	// Bound the audit to 5 seconds to prevent unbounded I/O.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	docs, err := st.ListPatternRuleMemories(ctx)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("list memories failed: %v", err)), nil
	}

	// Cap at 100 memories to bound I/O.
	if len(docs) > 100 {
		docs = docs[:100]
	}

	var results []map[string]any
	valid, drifted, skipped := 0, 0, 0

	for _, d := range docs {
		if ctx.Err() != nil {
			break // timeout
		}
		fileRefs, codePatterns := extractMemoryFileRefs(d.Content)
		if len(fileRefs) == 0 && len(codePatterns) == 0 {
			skipped++
			continue
		}

		isDrifted, evidence := checkConvention(projectPath, fileRefs, codePatterns)
		status := "valid"
		if isDrifted {
			status = "drifted"
			drifted++

			// Log drift event to audit.
			detailJSON, _ := json.Marshal(map[string]any{
				"type":       "convention-drift",
				"severity":   "warning",
				"memory_id":  d.ID,
				"memory_label": d.SectionPath,
				"evidence":   evidence,
				"resolution": "unresolved",
			})
			spec.AppendAudit(projectPath, spec.AuditEntry{
				Action: "drift.convention",
				Target: fmt.Sprintf("memory:%d", d.ID),
				Detail: string(detailJSON),
				User:   "mcp",
			})
		} else {
			valid++
		}

		results = append(results, map[string]any{
			"id":           d.ID,
			"section_path": d.SectionPath,
			"sub_type":     d.SubType,
			"hit_count":    d.HitCount,
			"status":       status,
			"evidence":     evidence,
		})
	}

	return marshalResult(map[string]any{
		"total_checked": valid + drifted,
		"valid":         valid,
		"drifted":       drifted,
		"skipped":       skipped,
		"results":       results,
	})
}

// goFilePathRe matches Go file paths like internal/store/docs.go or cmd/alfred/hooks.go.
var goFilePathRe = regexp.MustCompile(`(?:internal|cmd|pkg)/[a-zA-Z0-9_/.-]+\.go`)

// goIdentifierRe matches Go exported identifiers (function/type names like Store, UpsertDoc).
var goIdentifierRe = regexp.MustCompile(`\b[A-Z][a-zA-Z0-9]+(?:\.[A-Z][a-zA-Z0-9]+)?\b`)

// backtickContentRe matches content inside backticks (code references).
var backtickContentRe = regexp.MustCompile("`([^`]+)`")

// extractMemoryFileRefs extracts file paths and code patterns from memory content.
// Returns fileRefs (paths to check existence) and codePatterns (strings to grep for).
func extractMemoryFileRefs(content string) (fileRefs []string, codePatterns []string) {
	// Limit content to 10KB to prevent expensive regex on huge memories.
	if len(content) > 10240 {
		content = content[:10240]
	}

	// Extract Go file paths.
	seenFiles := make(map[string]bool)
	for _, m := range goFilePathRe.FindAllString(content, -1) {
		if !seenFiles[m] {
			seenFiles[m] = true
			fileRefs = append(fileRefs, m)
		}
	}

	// Extract identifiers from backtick-quoted code.
	seenPatterns := make(map[string]bool)
	for _, m := range backtickContentRe.FindAllStringSubmatch(content, -1) {
		if len(m) > 1 {
			p := strings.TrimSpace(m[1])
			// Only keep patterns that look like function/type names (not prose).
			if len(p) >= 3 && len(p) <= 80 && !strings.Contains(p, " ") && !seenPatterns[p] {
				seenPatterns[p] = true
				codePatterns = append(codePatterns, p)
			}
		}
	}

	return fileRefs, codePatterns
}

// checkConvention validates a single memory against the codebase.
// Returns drifted=true with evidence string, or drifted=false.
// Uses os.Stat for file existence and bufio.Scanner for pattern search.
func checkConvention(projectPath string, fileRefs []string, codePatterns []string) (drifted bool, evidence string) {
	// Check file existence.
	for _, ref := range fileRefs {
		fullPath := filepath.Join(projectPath, ref)
		if _, err := os.Stat(fullPath); err != nil {
			return true, fmt.Sprintf("file not found: %s", ref)
		}
	}

	// Check code patterns via file scanning (no subprocess grep).
	for _, pattern := range codePatterns {
		if !searchPatternInProject(projectPath, pattern) {
			return true, fmt.Sprintf("pattern not found: %s", pattern)
		}
	}

	return false, ""
}

// searchPatternInProject searches for a string pattern in .go files under projectPath.
// Uses bufio.Scanner for efficient line-by-line scanning.
// Returns true if the pattern is found in any file.
func searchPatternInProject(projectPath, pattern string) bool {
	// Search common Go source directories.
	dirs := []string{"cmd", "internal", "pkg"}
	for _, dir := range dirs {
		dirPath := filepath.Join(projectPath, dir)
		if _, err := os.Stat(dirPath); err != nil {
			continue
		}
		if searchPatternInDir(dirPath, pattern) {
			return true
		}
	}
	// Also search root .go files.
	return searchPatternInDir(projectPath, pattern)
}

// searchPatternInDir searches for a pattern in .go files within a directory tree.
func searchPatternInDir(dir, pattern string) bool {
	found := false
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || found {
			return filepath.SkipAll
		}
		if d.IsDir() {
			name := d.Name()
			// Skip hidden dirs and vendor.
			if strings.HasPrefix(name, ".") || name == "vendor" || name == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), pattern) {
				found = true
				return filepath.SkipAll
			}
		}
		return nil
	})
	return found
}
