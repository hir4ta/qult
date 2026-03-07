package mcpserver

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

type reviewFinding struct {
	Layer    string `json:"layer"`              // "spec" | "knowledge" | "best_practice"
	Severity string `json:"severity"`           // "critical" | "warning" | "info"
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

// severityRank returns a numeric rank for sorting (higher = more severe).
func severityRank(s string) int {
	switch s {
	case "critical":
		return 3
	case "warning":
		return 2
	default:
		return 1
	}
}

// butlerReviewHandler performs a 3-layer knowledge-powered code review.
func butlerReviewHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		focus := req.GetString("focus", "")

		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}

		diff := getReviewDiff(projectPath)
		if diff == "" {
			return marshalResult(map[string]any{
				"findings":      []reviewFinding{},
				"finding_count": 0,
				"message":       "no changes to review",
			})
		}

		var findings []reviewFinding

		// Layer 1: Spec-Aware Review
		taskSlug, err := spec.ReadActive(projectPath)
		if err == nil {
			sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
			if sd.Exists() {
				findings = append(findings, reviewAgainstSpec(sd, diff)...)
			}
		}

		// Layer 2: Knowledge-Powered Review (semantic search for related knowledge)
		if emb != nil {
			findings = append(findings, reviewAgainstKnowledge(ctx, st, emb, diff, focus)...)
		}

		// Layer 3: Best Practices Review (FTS search)
		findings = append(findings, reviewAgainstBestPractices(st, diff, focus)...)

		// Deduplicate findings by (source, message prefix).
		findings = deduplicateFindings(findings)

		return marshalResult(map[string]any{
			"diff_lines":     len(strings.Split(diff, "\n")),
			"findings":       findings,
			"finding_count":  len(findings),
			"layers_checked": []string{"spec", "knowledge", "best_practice"},
		})
	}
}

// getReviewDiff tries staged, unstaged, then recent 3 commits.
func getReviewDiff(projectPath string) string {
	for _, args := range [][]string{
		{"diff", "--cached"},
		{"diff"},
		{"diff", "HEAD~3..HEAD"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = projectPath
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			s := string(out)
			if len(s) > 32*1024 {
				s = s[:32*1024]
			}
			return s
		}
	}
	return ""
}

// reviewAgainstSpec checks changes against decisions.md and requirements.md.
func reviewAgainstSpec(sd *spec.SpecDir, diff string) []reviewFinding {
	var findings []reviewFinding

	// Check against decisions — surface relevant decisions based on diff content.
	decisions, err := sd.ReadFile(spec.FileDecisions)
	if err == nil && decisions != "" {
		decisionCount := max(strings.Count(decisions, "## ")-1, 0) // exclude header
		if decisionCount > 0 {
			findings = append(findings, reviewFinding{
				Layer:    "spec",
				Severity: "info",
				Message:  fmt.Sprintf("Review against %d recorded decisions in spec '%s'.", decisionCount, sd.TaskSlug),
				Source:   sd.FilePath(spec.FileDecisions),
			})
			// Surface decisions whose content overlaps with changed file paths.
			for _, excerpt := range extractDecisionExcerpts(decisions, diff) {
				findings = append(findings, reviewFinding{
					Layer:    "spec",
					Severity: "warning",
					Message:  fmt.Sprintf("Relevant decision: %s", excerpt),
					Source:   sd.FilePath(spec.FileDecisions),
				})
			}
		}
	}

	// Check out-of-scope — extract scope items and check diff for potential violations.
	requirements, err := sd.ReadFile(spec.FileRequirements)
	if err == nil && strings.Contains(requirements, "## Out of Scope") {
		outOfScopeItems := extractOutOfScopeItems(requirements)
		if len(outOfScopeItems) > 0 {
			// Check against added lines only (not entire diff) to reduce false positives.
			addedLower := strings.ToLower(extractDiffContent(diff, 16*1024))
			for _, item := range outOfScopeItems {
				itemLower := strings.ToLower(item)
				// Skip very short items that cause excessive false positives.
				if len(itemLower) < 4 {
					continue
				}
				if strings.Contains(addedLower, itemLower) {
					findings = append(findings, reviewFinding{
						Layer:    "spec",
						Severity: "critical",
						Message:  fmt.Sprintf("Possible out-of-scope change detected: %q is listed as out of scope.", item),
						Source:   sd.FilePath(spec.FileRequirements),
					})
				}
			}
		}
		findings = append(findings, reviewFinding{
			Layer:    "spec",
			Severity: "info",
			Message:  "Out of Scope section exists in requirements. Verify changes respect scope boundaries.",
			Source:   sd.FilePath(spec.FileRequirements),
		})
	}

	return findings
}

// extractDecisionExcerpts finds decisions whose headings relate to changed files in the diff.
func extractDecisionExcerpts(decisions, diff string) []string {
	// Extract changed file paths from diff.
	changedFiles := make(map[string]bool)
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "+++ b/") || strings.HasPrefix(line, "--- a/") {
			path := strings.TrimPrefix(strings.TrimPrefix(line, "+++ b/"), "--- a/")
			if path != "/dev/null" {
				changedFiles[path] = true
				// Also add the base filename for matching.
				changedFiles[filepath.Base(path)] = true
			}
		}
	}
	if len(changedFiles) == 0 {
		return nil
	}

	// Scan decision headers for overlap with changed files.
	var excerpts []string
	for _, line := range strings.Split(decisions, "\n") {
		if !strings.HasPrefix(line, "## ") {
			continue
		}
		heading := strings.TrimPrefix(line, "## ")
		headingLower := strings.ToLower(heading)
		for path := range changedFiles {
			pathLower := strings.ToLower(path)
			// Match if heading mentions the file or directory.
			baseName := strings.TrimSuffix(filepath.Base(pathLower), filepath.Ext(pathLower))
			if baseName != "" && strings.Contains(headingLower, baseName) {
				excerpts = append(excerpts, heading)
				break
			}
		}
	}
	return excerpts
}

// reviewAgainstKnowledge performs semantic search across all knowledge sources.
func reviewAgainstKnowledge(ctx context.Context, st *store.Store, emb *embedder.Embedder, diff, focus string) []reviewFinding {
	var findings []reviewFinding

	query := focus
	if query == "" {
		query = extractDiffContent(diff, 500)
	}
	if query == "" {
		return findings
	}

	queryVec, err := emb.EmbedForSearch(ctx, query)
	if err != nil {
		return findings
	}

	// Search all source_types (not just "spec") for broader knowledge coverage.
	matches, err := st.HybridSearch(queryVec, query, "", 3, 12)
	if err != nil || len(matches) == 0 {
		return findings
	}

	ids := make([]int64, len(matches))
	for i, m := range matches {
		ids[i] = m.DocID
	}
	docs, err := st.GetDocsByIDs(ids)
	if err != nil {
		return findings
	}

	// Build content list for reranking.
	contents := make([]string, len(docs))
	for i, doc := range docs {
		contents[i] = doc.Content
	}

	// Rerank and apply threshold (top-3, score >= 0.3).
	reranked, err := emb.Rerank(ctx, query, contents, 3)
	if err != nil {
		// Fallback: use top-3 from hybrid search without reranking.
		limit := min(3, len(docs))
		for _, doc := range docs[:limit] {
			findings = append(findings, reviewFinding{
				Layer:    "knowledge",
				Severity: "info",
				Message:  fmt.Sprintf("Related knowledge: %s", truncate(doc.SectionPath, 100)),
				Source:   doc.URL,
			})
		}
		return findings
	}

	for _, r := range reranked {
		if r.RelevanceScore < 0.3 {
			continue
		}
		if r.Index < 0 || r.Index >= len(docs) {
			continue
		}
		doc := docs[r.Index]
		findings = append(findings, reviewFinding{
			Layer:    "knowledge",
			Severity: "info",
			Message:  fmt.Sprintf("Related knowledge (score %.2f): %s", r.RelevanceScore, truncate(doc.SectionPath, 100)),
			Source:   doc.URL,
		})
	}

	return findings
}

// reviewAgainstBestPractices performs FTS search for relevant documentation.
func reviewAgainstBestPractices(st *store.Store, diff string, focus string) []reviewFinding {
	var findings []reviewFinding

	query := focus
	if query == "" {
		// Extract meaningful keywords from diff (changed file extensions, package names).
		query = extractDiffKeywords(diff)
	}
	if query == "" {
		query = "code review best practices"
	}

	snippets := queryKB(st, query, 3)
	for _, s := range snippets {
		findings = append(findings, reviewFinding{
			Layer:    "best_practice",
			Severity: "info",
			Message:  fmt.Sprintf("Related best practice: %s", truncate(s.SectionPath, 100)),
			Source:   s.URL,
		})
	}

	return findings
}

// extractOutOfScopeItems extracts bullet items from the "## Out of Scope" section.
func extractOutOfScopeItems(requirements string) []string {
	inSection := false
	var items []string
	for _, line := range strings.Split(requirements, "\n") {
		if strings.HasPrefix(line, "## Out of Scope") {
			inSection = true
			continue
		}
		if inSection && strings.HasPrefix(line, "## ") {
			break
		}
		if inSection {
			trimmed := strings.TrimSpace(line)
			trimmed = strings.TrimPrefix(trimmed, "- ")
			trimmed = strings.TrimSpace(trimmed)
			if trimmed != "" {
				items = append(items, trimmed)
			}
		}
	}
	return items
}

// deduplicateFindings removes duplicate findings by (source, message prefix).
// When duplicates exist, keeps the one with the highest severity.
func deduplicateFindings(findings []reviewFinding) []reviewFinding {
	type key struct {
		source     string
		messageKey string
	}
	best := make(map[key]reviewFinding)
	var order []key
	for _, f := range findings {
		// Use first 80 chars of message as dedup key.
		mk := f.Message
		if len(mk) > 80 {
			mk = mk[:80]
		}
		k := key{source: f.Source, messageKey: mk}
		if existing, ok := best[k]; ok {
			if severityRank(f.Severity) > severityRank(existing.Severity) {
				best[k] = f
			}
		} else {
			best[k] = f
			order = append(order, k)
		}
	}
	result := make([]reviewFinding, 0, len(order))
	for _, k := range order {
		result = append(result, best[k])
	}
	return result
}

// extractDiffContent extracts added lines from a diff for use as a search query.
// Skips diff headers and metadata, returns only meaningful code/text content.
func extractDiffContent(diff string, maxLen int) string {
	var buf strings.Builder
	for _, line := range strings.Split(diff, "\n") {
		if !strings.HasPrefix(line, "+") || strings.HasPrefix(line, "+++") {
			continue
		}
		content := strings.TrimPrefix(line, "+")
		content = strings.TrimSpace(content)
		if content == "" || content == "{" || content == "}" {
			continue
		}
		if buf.Len() > 0 {
			buf.WriteByte(' ')
		}
		buf.WriteString(content)
		if buf.Len() >= maxLen {
			break
		}
	}
	return buf.String()
}

// extractDiffKeywords extracts search-relevant keywords from a git diff.
func extractDiffKeywords(diff string) string {
	var keywords []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "+++ b/") {
			path := strings.TrimPrefix(line, "+++ b/")
			ext := filepath.Ext(path)
			switch ext {
			case ".go":
				if !seen["go"] {
					keywords = append(keywords, "Go")
					seen["go"] = true
				}
			case ".ts", ".tsx":
				if !seen["typescript"] {
					keywords = append(keywords, "TypeScript")
					seen["typescript"] = true
				}
			case ".py":
				if !seen["python"] {
					keywords = append(keywords, "Python")
					seen["python"] = true
				}
			}
			// Add directory context (e.g., "hooks", "skills", "rules").
			dir := filepath.Dir(path)
			base := filepath.Base(dir)
			if base != "." && !seen[base] {
				keywords = append(keywords, base)
				seen[base] = true
			}
		}
	}
	if len(keywords) > 5 {
		keywords = keywords[:5]
	}
	return strings.Join(keywords, " ")
}
