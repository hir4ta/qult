package hookhandler

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
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



