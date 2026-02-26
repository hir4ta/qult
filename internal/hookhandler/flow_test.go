package hookhandler

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openFlowTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-flow-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestEwmaUpdate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		prev    float64
		value   float64
		alpha   float64
		wantMin float64
		wantMax float64
	}{
		{"first value (prev=0)", 0, 10.0, 0.3, 2.99, 3.01}, // alpha*10 + (1-alpha)*0 = 3.0
		{"smooth high", 5.0, 10.0, 0.3, 6.4, 6.6},
		{"smooth low", 10.0, 0.0, 0.3, 6.9, 7.1},
		{"alpha 1.0 uses latest", 5.0, 10.0, 1.0, 9.99, 10.01},
		{"alpha 0.0 uses prev", 5.0, 10.0, 0.0, 4.99, 5.01},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := ewmaUpdate(tt.prev, tt.value, tt.alpha)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("ewmaUpdate(%v, %v, %v) = %v, want [%v, %v]",
					tt.prev, tt.value, tt.alpha, got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestIsInFlow(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// Initially not in flow.
	if isInFlow(sdb) {
		t.Error("isInFlow() = true on fresh session, want false")
	}

	// Set high velocity, low error rate → flow.
	_ = sdb.SetContext("ewma_tool_velocity", "8.0")
	_ = sdb.SetContext("ewma_error_rate", "0.05")
	if !isInFlow(sdb) {
		t.Error("isInFlow() = false with vel=8.0 err=0.05, want true")
	}

	// High error rate → not in flow.
	_ = sdb.SetContext("ewma_error_rate", "0.2")
	if isInFlow(sdb) {
		t.Error("isInFlow() = true with err=0.2, want false")
	}
}

func TestSuggestionFatigue(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// No data → no fatigue.
	if suggestionFatigue(sdb) {
		t.Error("suggestionFatigue() = true on fresh session, want false")
	}

	// Low acceptance → fatigue.
	_ = sdb.SetContext("ewma_acceptance_rate", "0.05")
	if !suggestionFatigue(sdb) {
		t.Error("suggestionFatigue() = false with rate=0.05, want true")
	}

	// Good acceptance → no fatigue.
	_ = sdb.SetContext("ewma_acceptance_rate", "0.5")
	if suggestionFatigue(sdb) {
		t.Error("suggestionFatigue() = true with rate=0.5, want false")
	}
}
