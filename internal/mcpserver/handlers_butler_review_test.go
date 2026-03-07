package mcpserver

import (
	"testing"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

func setupTestSpec(t *testing.T, dir, slug string) *spec.SpecDir {
	t.Helper()
	sd, err := spec.Init(dir, slug, "test task")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}
	sd.WriteFile(spec.FileDecisions, "# Decisions\n\n## Use SQLite\n- **Chosen:** SQLite\n- **Reason:** Embedded\n")
	return sd
}

func TestDeduplicateFindings(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		input    []reviewFinding
		wantLen  int
		wantSev  []string // expected severities in order
	}{
		{
			name:    "empty",
			input:   []reviewFinding{},
			wantLen: 0,
		},
		{
			name: "no duplicates",
			input: []reviewFinding{
				{Layer: "spec", Severity: "info", Message: "msg A", Source: "a"},
				{Layer: "knowledge", Severity: "warning", Message: "msg B", Source: "b"},
			},
			wantLen: 2,
			wantSev: []string{"info", "warning"},
		},
		{
			name: "duplicate keeps higher severity",
			input: []reviewFinding{
				{Layer: "spec", Severity: "info", Message: "same message here", Source: "src"},
				{Layer: "knowledge", Severity: "warning", Message: "same message here", Source: "src"},
			},
			wantLen: 1,
			wantSev: []string{"warning"},
		},
		{
			name: "different sources not deduped",
			input: []reviewFinding{
				{Layer: "spec", Severity: "info", Message: "same message", Source: "src1"},
				{Layer: "knowledge", Severity: "info", Message: "same message", Source: "src2"},
			},
			wantLen: 2,
		},
		{
			name: "critical beats warning",
			input: []reviewFinding{
				{Layer: "spec", Severity: "warning", Message: "dead end found", Source: "s"},
				{Layer: "spec", Severity: "critical", Message: "dead end found", Source: "s"},
				{Layer: "spec", Severity: "info", Message: "dead end found", Source: "s"},
			},
			wantLen: 1,
			wantSev: []string{"critical"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := deduplicateFindings(tt.input)
			if len(got) != tt.wantLen {
				t.Fatalf("deduplicateFindings() = %d findings, want %d", len(got), tt.wantLen)
			}
			for i, sev := range tt.wantSev {
				if i < len(got) && got[i].Severity != sev {
					t.Errorf("finding[%d].Severity = %q, want %q", i, got[i].Severity, sev)
				}
			}
		})
	}
}

func TestSeverityRank(t *testing.T) {
	t.Parallel()
	if severityRank("critical") <= severityRank("warning") {
		t.Error("critical should rank higher than warning")
	}
	if severityRank("warning") <= severityRank("info") {
		t.Error("warning should rank higher than info")
	}
	if severityRank("info") != severityRank("unknown") {
		t.Error("info and unknown should have same rank")
	}
}

func TestExtractOutOfScopeItems(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		input   string
		wantLen int
		want    []string
	}{
		{
			name:    "no out of scope section",
			input:   "## Goal\nBuild something\n",
			wantLen: 0,
		},
		{
			name:    "with items",
			input:   "## Goal\nBuild\n\n## Out of Scope\n- subagent\n- LLM summary\n- cross-task search\n\n## Notes\nfoo\n",
			wantLen: 3,
			want:    []string{"subagent", "LLM summary", "cross-task search"},
		},
		{
			name:    "empty section",
			input:   "## Out of Scope\n\n## Next\nstuff\n",
			wantLen: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractOutOfScopeItems(tt.input)
			if len(got) != tt.wantLen {
				t.Fatalf("extractOutOfScopeItems() = %d items, want %d (got %v)", len(got), tt.wantLen, got)
			}
			for i, w := range tt.want {
				if i < len(got) && got[i] != w {
					t.Errorf("item[%d] = %q, want %q", i, got[i], w)
				}
			}
		})
	}
}

func TestExtractDiffContent(t *testing.T) {
	t.Parallel()
	diff := "+++ b/main.go\n+package main\n+\n+func hello() {\n+}\n+import \"fmt\"\n"
	got := extractDiffContent(diff, 100)
	if got == "" {
		t.Error("extractDiffContent() returned empty")
	}
	// Should skip +++ header, empty lines, and lone braces. "func hello() {" is kept (not a lone brace).
	if got != "package main func hello() { import \"fmt\"" {
		t.Errorf("extractDiffContent() = %q", got)
	}
}

func TestExtractDiffKeywords(t *testing.T) {
	t.Parallel()
	diff := "+++ b/internal/mcpserver/server.go\n+++ b/cmd/alfred/main.go\n"
	got := extractDiffKeywords(diff)
	if got == "" {
		t.Error("extractDiffKeywords() returned empty")
	}
}

func TestExtractDecisionExcerpts(t *testing.T) {
	t.Parallel()
	decisions := "# Decisions\n\n## Use YAML for active state\nWe chose YAML.\n\n## Server auth approach\nJWT tokens.\n"
	diff := "+++ b/internal/spec/active.go\n--- a/internal/spec/active.go\n+yaml parsing\n"

	got := extractDecisionExcerpts(decisions, diff)
	// "active" in the file path should match "Use YAML for active state" heading.
	found := false
	for _, e := range got {
		if e == "Use YAML for active state" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected decision excerpt about 'active state', got %v", got)
	}
}

func TestReviewAgainstSpec(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	sd := setupTestSpec(t, dir, "review-spec")

	diff := "+++ b/main.go\n+package main\n+func main() {}\n"

	findings := reviewAgainstSpec(sd, diff)

	// Should have at least info finding about decisions.
	found := false
	for _, f := range findings {
		if f.Layer == "spec" {
			found = true
		}
	}
	if !found {
		t.Error("reviewAgainstSpec should produce spec-layer findings")
	}
}

func TestReviewAgainstSpecOutOfScope(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	sd := setupTestSpec(t, dir, "scope-test")

	// Add out-of-scope items.
	requirements := "# Requirements\n\n## Goal\nBuild search\n\n## Out of Scope\n- billing system\n- user authentication\n"
	sd.WriteFile("requirements.md", requirements)

	// Diff that mentions an out-of-scope item.
	diff := "+++ b/billing.go\n+package billing\n+func ProcessPayment() { // billing system implementation }\n"

	findings := reviewAgainstSpec(sd, diff)

	foundCritical := false
	for _, f := range findings {
		if f.Severity == "critical" && f.Layer == "spec" {
			foundCritical = true
		}
	}
	if !foundCritical {
		t.Error("should detect out-of-scope violation as critical")
	}
}

func TestReviewAgainstBestPractices(t *testing.T) {
	t.Parallel()
	diff := "+++ b/main.go\n+package main\n+func main() {}\n"

	// With nil store, should produce no findings (graceful).
	findings := reviewAgainstBestPractices(nil, diff, "")
	if len(findings) != 0 {
		t.Errorf("nil store should return 0 findings, got %d", len(findings))
	}
}

func TestGetReviewDiff(t *testing.T) {
	t.Parallel()
	// Non-git directory: should return empty.
	diff := getReviewDiff(t.TempDir())
	if diff != "" {
		t.Errorf("non-git dir should return empty diff, got %q", diff)
	}
}

func TestExtractDiffContentMaxLen(t *testing.T) {
	t.Parallel()
	diff := "+++ b/main.go\n+line1\n+line2\n+line3\n+line4\n+line5\n"
	got := extractDiffContent(diff, 10)
	if len(got) > 15 { // some slack for the last word
		t.Errorf("should respect maxLen, got len=%d: %q", len(got), got)
	}
}

func TestExtractDiffKeywordsMultiLang(t *testing.T) {
	t.Parallel()
	diff := "+++ b/cmd/app/main.go\n+++ b/web/app.ts\n+++ b/scripts/run.py\n"
	got := extractDiffKeywords(diff)
	if got == "" {
		t.Fatal("should extract keywords")
	}
	for _, lang := range []string{"Go", "TypeScript", "Python"} {
		if !contains(got, lang) {
			t.Errorf("should detect %s, got %q", lang, got)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsWord(s, sub))
}

func containsWord(s, word string) bool {
	for _, w := range splitWords(s) {
		if w == word {
			return true
		}
	}
	return false
}

func splitWords(s string) []string {
	var words []string
	current := ""
	for _, c := range s {
		if c == ' ' {
			if current != "" {
				words = append(words, current)
				current = ""
			}
		} else {
			current += string(c)
		}
	}
	if current != "" {
		words = append(words, current)
	}
	return words
}
