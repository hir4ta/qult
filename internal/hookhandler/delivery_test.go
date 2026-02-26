package hookhandler

import "testing"

func TestBetaExpectation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		alpha      float64
		beta       float64
		wantMin    float64
		wantMax    float64
	}{
		{"all resolved", 11.0, 1.0, 0.9, 1.0},
		{"none resolved", 1.0, 11.0, 0.0, 0.1},
		{"balanced", 6.0, 6.0, 0.45, 0.55},
		{"uniform prior", 1.0, 1.0, 0.45, 0.55},
		{"mostly resolved", 8.0, 3.0, 0.7, 0.8},
		{"mostly ignored", 3.0, 8.0, 0.2, 0.35},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := betaExpectation(tt.alpha, tt.beta)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("betaExpectation(%v, %v) = %v, want [%v, %v]",
					tt.alpha, tt.beta, got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestAdjustFromEstimate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		estimate float64
		base     SuggestionPriority
		want     SuggestionPriority
	}{
		{"high effectiveness keeps priority", 0.8, PriorityHigh, PriorityHigh},
		{"moderate effectiveness downgrades by 1", 0.35, PriorityHigh, PriorityMedium},
		{"low effectiveness downgrades by 2", 0.15, PriorityHigh, PriorityLow},
		{"very low effectiveness suppresses", 0.05, PriorityHigh, PrioritySuppressed},
		{"critical stays at moderate", 0.35, PriorityCritical, PriorityHigh},
		{"low base not downgraded past low", 0.35, PriorityLow, PriorityLow},
		{"medium downgraded by 2 caps at low", 0.15, PriorityMedium, PriorityLow},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := adjustFromEstimate(tt.estimate, tt.base)
			if got != tt.want {
				t.Errorf("adjustFromEstimate(%v, %v) = %v, want %v",
					tt.estimate, tt.base, got, tt.want)
			}
		})
	}
}
