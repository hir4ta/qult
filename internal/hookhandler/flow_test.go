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

func TestFlowDetail(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name            string
		vel             string
		errRate         string
		acceptance      string
		streak          string
		wantBudget      int
		wantIncludeWhy  bool
		wantCoChange    bool
		wantMaxAlts     int
	}{
		{
			name:           "normal",
			vel:            "4.0",
			errRate:        "0.1",
			wantBudget:     2000,
			wantIncludeWhy: true,
			wantCoChange:   true,
			wantMaxAlts:    3,
		},
		{
			name:           "productive",
			vel:            "8.0",
			errRate:        "0.05",
			streak:         "5",
			wantBudget:     800,
			wantIncludeWhy: false,
			wantCoChange:   false,
			wantMaxAlts:    1,
		},
		{
			name:           "stalled",
			vel:            "1.5",
			errRate:        "0.05",
			wantBudget:     3000,
			wantIncludeWhy: true,
			wantCoChange:   true,
			wantMaxAlts:    5,
		},
		{
			name:           "thrashing",
			vel:            "8.0",
			errRate:        "0.30",
			wantBudget:     3000,
			wantIncludeWhy: true,
			wantCoChange:   true,
			wantMaxAlts:    5,
		},
		{
			name:           "fatigued",
			vel:            "5.0",
			errRate:        "0.1",
			acceptance:     "0.05",
			wantBudget:     1500,
			wantIncludeWhy: true,
			wantCoChange:   false,
			wantMaxAlts:    2,
		},
		{
			name:           "fresh session defaults to normal",
			wantBudget:     2000,
			wantIncludeWhy: true,
			wantCoChange:   true,
			wantMaxAlts:    3,
		},
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
			fd := flowDetail(sdb)
			if fd.Budget != tt.wantBudget {
				t.Errorf("flowDetail().Budget = %d, want %d", fd.Budget, tt.wantBudget)
			}
			if fd.IncludeWhy != tt.wantIncludeWhy {
				t.Errorf("flowDetail().IncludeWhy = %v, want %v", fd.IncludeWhy, tt.wantIncludeWhy)
			}
			if fd.IncludeCoChange != tt.wantCoChange {
				t.Errorf("flowDetail().IncludeCoChange = %v, want %v", fd.IncludeCoChange, tt.wantCoChange)
			}
			if fd.MaxAlternatives != tt.wantMaxAlts {
				t.Errorf("flowDetail().MaxAlternatives = %d, want %d", fd.MaxAlternatives, tt.wantMaxAlts)
			}
		})
	}
}

func TestFlowBudgetDelegates(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// flowBudget should return the same value as flowDetail().Budget.
	if got, want := flowBudget(sdb), flowDetail(sdb).Budget; got != want {
		t.Errorf("flowBudget() = %d, flowDetail().Budget = %d, want equal", got, want)
	}

	// Set productive flow and verify both agree.
	_ = sdb.SetContext("ewma_tool_velocity", "8.0")
	_ = sdb.SetContext("ewma_error_rate", "0.05")
	_ = sdb.SetContext("success_streak", "5")
	if got, want := flowBudget(sdb), flowDetail(sdb).Budget; got != want {
		t.Errorf("flowBudget() = %d, flowDetail().Budget = %d in productive flow, want equal", got, want)
	}
	if got := flowBudget(sdb); got != 800 {
		t.Errorf("flowBudget() = %d in productive flow, want 800", got)
	}
}

