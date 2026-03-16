package mcpserver

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openTestStore creates a temporary SQLite store for testing.
func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// newRequest builds a CallToolRequest with the given arguments.
func newRequest(args map[string]any) mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Arguments = args
	return req
}

// resultText extracts the text string from a CallToolResult.
func resultText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if len(res.Content) == 0 {
		t.Fatal("result has no content")
	}
	tc, ok := res.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("result content is not TextContent: %T", res.Content[0])
	}
	return tc.Text
}

// resultJSON extracts the JSON body from a CallToolResult into a map.
func resultJSON(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	text := resultText(t, res)
	var m map[string]any
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("unmarshal result JSON: %v\nraw: %s", err, text)
	}
	return m
}

// ---------------------------------------------------------------------------
// helper tests
// ---------------------------------------------------------------------------

func TestMarshalResult(t *testing.T) {
	t.Parallel()
	input := map[string]any{
		"key":   "value",
		"count": 42,
	}

	res, err := marshalResult(input)
	if err != nil {
		t.Fatalf("marshalResult error: %v", err)
	}
	if res.IsError {
		t.Fatal("marshalResult returned error result")
	}

	m := resultJSON(t, res)
	if m["key"] != "value" {
		t.Errorf("key = %v, want value", m["key"])
	}
	count, _ := m["count"].(float64)
	if count != 42 {
		t.Errorf("count = %v, want 42", count)
	}
}

func TestTruncate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"short", 10, "short"},
		{"exactly10!", 10, "exactly10!"},
		{"this is longer than ten", 10, "this is lo..."},
		{"", 5, ""},
		{"abc", 3, "abc"},
		{"abcd", 3, "abc..."},
	}
	for _, tc := range cases {
		got := truncate(tc.input, tc.maxLen)
		if got != tc.want {
			t.Errorf("truncate(%q, %d) = %q, want %q", tc.input, tc.maxLen, got, tc.want)
		}
	}
}

func TestParseConfidenceScores(t *testing.T) {
	t.Parallel()

	t.Run("with annotations", func(t *testing.T) {
		t.Parallel()
		content := `## Goals <!-- confidence: 9 -->
Build a REST API

## Authentication <!-- confidence: 3 -->
OAuth2 or API Key (undecided)

## Database <!-- confidence: 7 -->
PostgreSQL with pgx driver
`
		cs := parseConfidenceScores(content)
		if cs.Total != 3 {
			t.Errorf("total = %d, want 3", cs.Total)
		}
		if cs.LowCount != 1 {
			t.Errorf("low_items = %d, want 1 (Authentication=3)", cs.LowCount)
		}
		// avg = (9+3+7)/3 = 6.33
		if cs.Avg < 6.0 || cs.Avg > 6.5 {
			t.Errorf("avg = %.2f, want ~6.33", cs.Avg)
		}
	})

	t.Run("no annotations", func(t *testing.T) {
		t.Parallel()
		cs := parseConfidenceScores("## Goals\nBuild something\n")
		if cs.Total != 0 {
			t.Errorf("total = %d, want 0 for no annotations", cs.Total)
		}
	})

	t.Run("edge scores", func(t *testing.T) {
		t.Parallel()
		content := "## X <!-- confidence: 1 -->\n## Y <!-- confidence: 10 -->\n## Z <!-- confidence: 11 -->\n"
		cs := parseConfidenceScores(content)
		// score 11 is out of range (1-10), should be skipped
		if cs.Total != 2 {
			t.Errorf("total = %d, want 2 (11 out of range)", cs.Total)
		}
	})

	t.Run("source field", func(t *testing.T) {
		t.Parallel()
		content := `## Goal
<!-- confidence: 9 | source: user -->
## Design
<!-- confidence: 5 | source: assumption -->
## Notes
<!-- confidence: 7 -->
`
		cs := parseConfidenceScores(content)
		if cs.Total != 3 {
			t.Errorf("total = %d, want 3", cs.Total)
		}
		// Check source field extraction
		sources := map[string]string{}
		for _, item := range cs.Items {
			sources[item.Section] = item.Source
		}
		if sources["Goal"] != "user" {
			t.Errorf("Goal source = %q, want %q", sources["Goal"], "user")
		}
		if sources["Design"] != "assumption" {
			t.Errorf("Design source = %q, want %q", sources["Design"], "assumption")
		}
		if sources["Notes"] != "" {
			t.Errorf("Notes source = %q, want empty", sources["Notes"])
		}
		// Check low_confidence_warnings (score <= 5 + assumption)
		if len(cs.Warnings) != 1 || cs.Warnings[0] != "Design" {
			t.Errorf("Warnings = %v, want [Design]", cs.Warnings)
		}
	})

	t.Run("grounding field", func(t *testing.T) {
		t.Parallel()
		content := `## Goal
<!-- confidence: 9 | source: user | grounding: verified -->
## Design
<!-- confidence: 7 | source: code | grounding: inferred -->
## Research
<!-- confidence: 5 | source: assumption | grounding: speculative -->
## Notes
<!-- confidence: 8 | source: code -->
`
		cs := parseConfidenceScores(content)
		if cs.Total != 4 {
			t.Errorf("total = %d, want 4", cs.Total)
		}

		groundings := map[string]string{}
		for _, item := range cs.Items {
			groundings[item.Section] = item.Grounding
		}
		if groundings["Goal"] != "verified" {
			t.Errorf("Goal grounding = %q, want %q", groundings["Goal"], "verified")
		}
		if groundings["Design"] != "inferred" {
			t.Errorf("Design grounding = %q, want %q", groundings["Design"], "inferred")
		}
		if groundings["Research"] != "speculative" {
			t.Errorf("Research grounding = %q, want %q", groundings["Research"], "speculative")
		}
		if groundings["Notes"] != "" {
			t.Errorf("Notes grounding = %q, want empty (legacy)", groundings["Notes"])
		}

		if cs.GroundingDist["verified"] != 1 {
			t.Errorf("GroundingDist[verified] = %d, want 1", cs.GroundingDist["verified"])
		}
		if cs.GroundingDist["inferred"] != 1 {
			t.Errorf("GroundingDist[inferred] = %d, want 1", cs.GroundingDist["inferred"])
		}
		if cs.GroundingDist["speculative"] != 1 {
			t.Errorf("GroundingDist[speculative] = %d, want 1", cs.GroundingDist["speculative"])
		}
	})

	t.Run("grounding typo warning", func(t *testing.T) {
		t.Parallel()
		content := `## Goal
<!-- confidence: 8 | source: code | grounding: verfied -->
`
		cs := parseConfidenceScores(content)
		if cs.Total != 1 {
			t.Errorf("total = %d, want 1", cs.Total)
		}
		if cs.Items[0].Grounding != "" {
			t.Errorf("grounding = %q, want empty for typo", cs.Items[0].Grounding)
		}
		if len(cs.GroundingWarns) != 1 {
			t.Errorf("GroundingWarns len = %d, want 1 for unknown value", len(cs.GroundingWarns))
		}
	})

	t.Run("high confidence speculative warning", func(t *testing.T) {
		t.Parallel()
		content := `## Risky
<!-- confidence: 8 | source: inference | grounding: speculative -->
## Safe
<!-- confidence: 3 | source: assumption | grounding: speculative -->
`
		cs := parseConfidenceScores(content)
		var highConfWarns int
		for _, w := range cs.GroundingWarns {
			if strings.Contains(w, "high confidence") {
				highConfWarns++
			}
		}
		if highConfWarns != 1 {
			t.Errorf("high confidence grounding warnings = %d, want 1; warns=%v", highConfWarns, cs.GroundingWarns)
		}
	})
}

func TestHasOnlyCheckedSteps(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		section string
		want    bool
	}{
		{"all checked", "- [x] Step 1\n- [x] Step 2\n", true},
		{"one unchecked", "- [x] Step 1\n- [ ] Step 2\n", false},
		{"empty", "", false},
		{"no items", "Some text\n", false},
		{"uppercase X", "- [X] Step 1\n", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := hasOnlyCheckedSteps(tt.section); got != tt.want {
				t.Errorf("hasOnlyCheckedSteps(%q) = %v, want %v", tt.section, got, tt.want)
			}
		})
	}
}

func TestTruncateForHint(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		input    string
		max      int
		want     string
	}{
		{"short", "hello", 10, "hello"},
		{"exact", "hello", 5, "hello"},
		{"truncate", "hello world", 5, "hello..."},
		{"unicode", "日本語テスト", 3, "日本語..."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := truncateForHint(tt.input, tt.max); got != tt.want {
				t.Errorf("truncateForHint(%q, %d) = %q, want %q", tt.input, tt.max, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Spec handler tests use specHandler from handlers_spec.go — these are
// covered by the spec package tests. Integration tests can be added later.
// ---------------------------------------------------------------------------

// Recall handler tests are in handlers_recall_test.go.
