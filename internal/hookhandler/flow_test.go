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

	// Set high velocity, low error rate, success streak → flow.
	_ = sdb.SetContext("ewma_tool_velocity", "8.0")
	_ = sdb.SetContext("ewma_error_rate", "0.05")
	_ = sdb.SetContext("success_streak", "5")
	if !isInFlow(sdb) {
		t.Error("isInFlow() = false with vel=8.0 err=0.05 streak=5, want true")
	}

	// High error rate → not in flow.
	_ = sdb.SetContext("ewma_error_rate", "0.2")
	if isInFlow(sdb) {
		t.Error("isInFlow() = true with err=0.2, want false")
	}
}

func TestClassifyFlowState(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		vel        string
		errRate    string
		acceptance string
		streak     string
		want       FlowState
	}{
		{"fresh session", "", "", "", "", FlowNormal},
		{"productive", "8.0", "0.05", "", "5", FlowProductive},
		{"productive needs streak", "8.0", "0.05", "", "1", FlowNormal},
		{"thrashing", "8.0", "0.30", "", "0", FlowThrashing},
		{"stalled", "1.5", "0.05", "", "0", FlowStalled},
		{"fatigued", "5.0", "0.1", "0.05", "0", FlowFatigued},
		{"normal mid velocity", "4.0", "0.1", "", "0", FlowNormal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openFlowTestDB(t)
			if tt.vel != "" {
				_ = sdb.SetContext("ewma_tool_velocity", tt.vel)
			}
			if tt.errRate != "" {
				_ = sdb.SetContext("ewma_error_rate", tt.errRate)
			}
			if tt.acceptance != "" {
				_ = sdb.SetContext("ewma_acceptance_rate", tt.acceptance)
			}
			if tt.streak != "" {
				_ = sdb.SetContext("success_streak", tt.streak)
			}
			if got := classifyFlowState(sdb); got != tt.want {
				t.Errorf("classifyFlowState() = %d, want %d", got, tt.want)
			}
		})
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

func TestEWMVTracking(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// Initially zero.
	if got := VelocitySigma(sdb); got != 0 {
		t.Errorf("VelocitySigma() = %v on fresh session, want 0", got)
	}
	if got := ErrorRateSigma(sdb); got != 0 {
		t.Errorf("ErrorRateSigma() = %v on fresh session, want 0", got)
	}

	// After updates, variance should grow with varying inputs.
	_ = sdb.SetContext("ewmv_velocity_var", "4.0")
	if got := VelocitySigma(sdb); got < 1.99 || got > 2.01 {
		t.Errorf("VelocitySigma() = %v with var=4.0, want ~2.0", got)
	}

	_ = sdb.SetContext("ewmv_error_var", "0.09")
	if got := ErrorRateSigma(sdb); got < 0.29 || got > 0.31 {
		t.Errorf("ErrorRateSigma() = %v with var=0.09, want ~0.3", got)
	}
}

func TestFlowEventCount(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	if got := FlowEventCount(sdb); got != 0 {
		t.Errorf("FlowEventCount() = %d on fresh session, want 0", got)
	}

	_ = sdb.SetContext("flow_event_count", "15")
	if got := FlowEventCount(sdb); got != 15 {
		t.Errorf("FlowEventCount() = %d, want 15", got)
	}
}

func TestAdaptiveErrorThreshold(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// With insufficient flow data, returns some threshold (from store or default).
	threshold := adaptiveErrorThreshold(sdb)
	if threshold < 0 || threshold > 1.0 {
		t.Errorf("adaptiveErrorThreshold() with no data = %v, want [0, 1.0]", threshold)
	}

	// With sufficient data and meaningful variance, uses EWMV-based UCL.
	_ = sdb.SetContext("flow_event_count", "20")
	_ = sdb.SetContext("ewma_error_rate", "0.1")
	_ = sdb.SetContext("ewmv_error_var", "0.01") // sigma=0.1

	threshold = adaptiveErrorThreshold(sdb)
	// UCL = 0.1 + 2*0.1 = 0.3, clamped to [0.15, 0.6]
	if threshold < 0.25 || threshold > 0.35 {
		t.Errorf("adaptiveErrorThreshold() with mean=0.1 sigma=0.1 = %v, want ~0.3", threshold)
	}

	// With very low sigma, falls back (not EWMV path).
	_ = sdb.SetContext("ewmv_error_var", "0.00001")
	threshold = adaptiveErrorThreshold(sdb)
	// Falls back to store/default; just verify it returns something non-negative.
	if threshold < 0 || threshold > 1.0 {
		t.Errorf("adaptiveErrorThreshold() with tiny sigma = %v, want [0, 1.0]", threshold)
	}
}
