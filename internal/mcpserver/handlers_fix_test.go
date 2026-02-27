package mcpserver

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func TestMarshalResult_Success(t *testing.T) {
	t.Parallel()
	result, err := marshalResult(map[string]any{"success": true, "count": 42})
	if err != nil {
		t.Fatalf("marshalResult() error = %v", err)
	}
	if result.IsError {
		t.Fatal("marshalResult() returned error result for valid input")
	}

	text := result.Content[0].(mcp.TextContent).Text
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("marshalResult() produced invalid JSON: %v", err)
	}
	if parsed["success"] != true {
		t.Errorf("parsed[success] = %v, want true", parsed["success"])
	}
}

func TestMarshalResult_EncodeError(t *testing.T) {
	t.Parallel()
	// math.NaN() cannot be encoded to JSON.
	result, err := marshalResult(map[string]any{"bad": math.NaN()})
	if err != nil {
		t.Fatalf("marshalResult() error = %v, want nil with error result", err)
	}
	if !result.IsError {
		t.Error("marshalResult() should return error result for un-encodable input")
	}
}

func TestMarshalResult_NilInput(t *testing.T) {
	t.Parallel()
	result, err := marshalResult(nil)
	if err != nil {
		t.Fatalf("marshalResult(nil) error = %v", err)
	}
	if result.IsError {
		t.Error("marshalResult(nil) should succeed — JSON null is valid")
	}
}

func TestMarshalResult_EmptyMap(t *testing.T) {
	t.Parallel()
	result, err := marshalResult(map[string]any{})
	if err != nil {
		t.Fatalf("marshalResult({}) error = %v", err)
	}
	if result.IsError {
		t.Error("marshalResult({}) should succeed")
	}
	text := result.Content[0].(mcp.TextContent).Text
	if text != "{}" {
		t.Errorf("marshalResult({}) = %q, want %q", text, "{}")
	}
}

func TestContextPressure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		compactCount int
		turnCount    int
		want         string
	}{
		{"no_compact_low_turns", 0, 10, "low"},
		{"no_compact_high_turns", 0, 50, "medium"},
		{"one_compact", 1, 20, "medium"},
		{"three_compacts", 3, 30, "high"},
		{"frequent_compacts", 2, 15, "high"},   // turnsPerCompact = 15/3 = 5 < 10
		{"sparse_compacts", 1, 100, "medium"},   // turnsPerCompact = 100/2 = 50
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := contextPressure(tt.compactCount, tt.turnCount)
			if got != tt.want {
				t.Errorf("contextPressure(%d, %d) = %q, want %q",
					tt.compactCount, tt.turnCount, got, tt.want)
			}
		})
	}
}

func TestReadBurstState_NoDB(t *testing.T) {
	t.Parallel()
	// Non-existent session → nil burst state.
	result := readBurstState("nonexistent-session-id", map[string]any{})
	if result != nil {
		t.Errorf("readBurstState(nonexistent) = %v, want nil", result)
	}
}

func TestEnrichAlertsFromSessionDB(t *testing.T) {
	t.Parallel()
	sdb, err := sessiondb.Open("test-enrich-alerts-" + t.Name())
	if err != nil {
		t.Fatalf("sessiondb.Open() error = %v", err)
	}
	defer sdb.Close()

	_ = sdb.SetContext("ewma_tool_velocity", "5.2")
	_ = sdb.SetContext("ewma_error_rate", "0.1")

	resp := &AlertsResponse{}
	enrichAlertsFromSessionDB(sdb, resp)

	if resp.FlowMetrics == nil {
		t.Fatal("enrichAlertsFromSessionDB did not set FlowMetrics")
	}
	if resp.FlowMetrics.ToolVelocity != 5.2 {
		t.Errorf("FlowMetrics.ToolVelocity = %v, want 5.2", resp.FlowMetrics.ToolVelocity)
	}
	if resp.FlowMetrics.ErrorRate != 0.1 {
		t.Errorf("FlowMetrics.ErrorRate = %v, want 0.1", resp.FlowMetrics.ErrorRate)
	}
}

func TestEnrichAlertsFromSessionDB_Empty(t *testing.T) {
	t.Parallel()
	sdb, err := sessiondb.Open("test-enrich-empty-" + t.Name())
	if err != nil {
		t.Fatalf("sessiondb.Open() error = %v", err)
	}
	defer sdb.Close()

	resp := &AlertsResponse{}
	enrichAlertsFromSessionDB(sdb, resp)

	if resp.FlowMetrics != nil {
		t.Error("enrichAlertsFromSessionDB should not set FlowMetrics when no EWMA data exists")
	}
}

// TestFixHandler_Integration tests the fixHandler end-to-end with real temp files.
func TestFixHandler_Integration(t *testing.T) {
	t.Parallel()
	handler := fixHandler()

	t.Run("go_defer_in_loop", func(t *testing.T) {
		t.Parallel()
		// Create a temp Go file with a defer-in-loop pattern.
		dir := t.TempDir()
		fp := filepath.Join(dir, "main.go")
		code := "package main\n\nfunc run() {\n\tfor i := 0; i < 10; i++ {\n\t\tdefer cleanup()\n\t}\n}\n"
		if err := os.WriteFile(fp, []byte(code), 0644); err != nil {
			t.Fatal(err)
		}

		result, err := handler(context.Background(), newFixRequest(fp, "go_defer_in_loop", "", 5))
		if err != nil {
			t.Fatalf("fixHandler error = %v", err)
		}
		parsed := parseFixResult(t, result)
		if parsed["success"] != true {
			t.Errorf("success = %v, want true", parsed["success"])
		}
		if parsed["before"] == nil || parsed["after"] == nil {
			t.Error("expected before/after in result")
		}
	})

	t.Run("unknown_extension", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		fp := filepath.Join(dir, "data.xyz")
		if err := os.WriteFile(fp, []byte("some data"), 0644); err != nil {
			t.Fatal(err)
		}

		result, err := handler(context.Background(), newFixRequest(fp, "some_rule", "", 1))
		if err != nil {
			t.Fatalf("fixHandler error = %v", err)
		}
		parsed := parseFixResult(t, result)
		if parsed["success"] != false {
			t.Errorf("success = %v, want false (no fixer for .xyz)", parsed["success"])
		}
		if parsed["reason"] == nil {
			t.Error("expected reason field for no-fixer case")
		}
	})

	t.Run("unknown_rule", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		fp := filepath.Join(dir, "main.go")
		if err := os.WriteFile(fp, []byte("package main\n\nfunc main() {}\n"), 0644); err != nil {
			t.Fatal(err)
		}

		result, err := handler(context.Background(), newFixRequest(fp, "nonexistent_rule", "", 3))
		if err != nil {
			t.Fatalf("fixHandler error = %v", err)
		}
		parsed := parseFixResult(t, result)
		if parsed["success"] != false {
			t.Errorf("success = %v, want false (unknown rule)", parsed["success"])
		}
	})

	t.Run("missing_file", func(t *testing.T) {
		t.Parallel()
		result, err := handler(context.Background(), newFixRequest("/nonexistent/path.go", "go_defer_in_loop", "", 1))
		if err != nil {
			t.Fatalf("fixHandler error = %v", err)
		}
		if !result.IsError {
			t.Error("expected MCP error for missing file")
		}
	})

	t.Run("missing_params", func(t *testing.T) {
		t.Parallel()
		// No file_path.
		result, err := handler(context.Background(), newFixRequest("", "some_rule", "", 1))
		if err != nil {
			t.Fatalf("fixHandler error = %v", err)
		}
		if !result.IsError {
			t.Error("expected MCP error for missing file_path")
		}
	})
}

// newFixRequest builds an mcp.CallToolRequest for the fix handler.
func newFixRequest(filePath, rule, message string, line int) mcp.CallToolRequest {
	args := map[string]any{
		"file_path":    filePath,
		"finding_rule": rule,
		"line":         float64(line),
	}
	if message != "" {
		args["message"] = message
	}
	return mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      "buddy_fix",
			Arguments: args,
		},
	}
}

// parseFixResult extracts the JSON body from a non-error MCP result.
func parseFixResult(t *testing.T, result *mcp.CallToolResult) map[string]any {
	t.Helper()
	if result.IsError {
		t.Fatalf("unexpected MCP error result")
	}
	text := result.Content[0].(mcp.TextContent).Text
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("invalid JSON in result: %v\n%s", err, text)
	}
	return parsed
}
