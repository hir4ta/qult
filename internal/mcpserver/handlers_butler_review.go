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
	Severity string `json:"severity"`           // "info" | "warning"
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
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

// reviewAgainstSpec checks changes against decisions.md, knowledge.md, and requirements.md.
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

	// Check knowledge for dead ends — warn if diff touches areas with known dead ends.
	knowledge, err := sd.ReadFile(spec.FileKnowledge)
	if err == nil && knowledge != "" {
		discoveryCount := max(strings.Count(knowledge, "## ")-1, 0)
		if discoveryCount > 0 {
			findings = append(findings, reviewFinding{
				Layer:    "spec",
				Severity: "info",
				Message:  fmt.Sprintf("Review against %d knowledge entries (including dead ends) in spec.", discoveryCount),
				Source:   sd.FilePath(spec.FileKnowledge),
			})
			if strings.Contains(strings.ToLower(knowledge), "dead end") {
				findings = append(findings, reviewFinding{
					Layer:    "spec",
					Severity: "warning",
					Message:  "Knowledge base contains dead end entries. Review before repeating failed approaches.",
					Source:   sd.FilePath(spec.FileKnowledge),
				})
			}
		}
	}

	// Check out-of-scope — extract scope items and check diff for potential violations.
	requirements, err := sd.ReadFile(spec.FileRequirements)
	if err == nil && strings.Contains(requirements, "## Out of Scope") {
		findings = append(findings, reviewFinding{
			Layer:    "spec",
			Severity: "info",
			Message:  "Out of Scope section exists in requirements. Verify changes respect scope boundaries.",
			Source:   sd.FilePath(spec.FileRequirements),
		})
	}

	// Check tasks.md for incomplete prerequisites.
	tasks, err := sd.ReadFile(spec.FileTasks)
	if err == nil && tasks != "" {
		incomplete := strings.Count(tasks, "- [ ]")
		complete := strings.Count(tasks, "- [x]") + strings.Count(tasks, "- [X]")
		if incomplete > 0 || complete > 0 {
			findings = append(findings, reviewFinding{
				Layer:    "spec",
				Severity: "info",
				Message:  fmt.Sprintf("Task progress: %d/%d complete.", complete, complete+incomplete),
				Source:   sd.FilePath(spec.FileTasks),
			})
		}
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

// reviewAgainstKnowledge performs semantic search for related spec knowledge.
func reviewAgainstKnowledge(ctx context.Context, st *store.Store, emb *embedder.Embedder, diff, focus string) []reviewFinding {
	var findings []reviewFinding

	query := focus
	if query == "" {
		// Extract meaningful content from diff (skip headers, use added lines).
		query = extractDiffContent(diff, 500)
	}
	if query == "" {
		return findings
	}

	queryVec, err := emb.EmbedForSearch(ctx, query)
	if err != nil {
		return findings
	}

	matches, err := st.HybridSearch(queryVec, query, "spec", 3, 12)
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

	for _, doc := range docs {
		findings = append(findings, reviewFinding{
			Layer:    "knowledge",
			Severity: "info",
			Message:  fmt.Sprintf("Related spec knowledge: %s", truncate(doc.SectionPath, 100)),
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
