package hookhandler

import (
	"math/rand/v2"
	"testing"
)

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

func newTestRNG() *rand.Rand {
	return rand.New(rand.NewPCG(42, 0))
}

func TestBetaSample_StatisticalProperties(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		alpha   float64
		beta    float64
		wantMin float64
		wantMax float64
	}{
		{"high alpha", 10, 1, 0.8, 1.0},
		{"high beta", 1, 10, 0.0, 0.2},
		{"uniform prior", 1, 1, 0.35, 0.65},
		{"balanced", 5, 5, 0.35, 0.65},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rng := newTestRNG()
			var sum float64
			n := 1000
			for range n {
				sum += betaSample(rng, tt.alpha, tt.beta)
			}
			mean := sum / float64(n)
			if mean < tt.wantMin || mean > tt.wantMax {
				t.Errorf("betaSample(%v, %v) mean over %d draws = %v, want [%v, %v]",
					tt.alpha, tt.beta, n, mean, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestBetaSample_Exploration(t *testing.T) {
	t.Parallel()
	// A pattern with ~20% resolution rate should still sometimes produce
	// samples above 0.5 (exploration) but not too often.
	rng := newTestRNG()
	alpha := 5.0  // 4 resolved + 1 prior
	beta := 17.0  // 16 not resolved + 1 prior
	aboveHalf := 0
	n := 1000
	for range n {
		if betaSample(rng, alpha, beta) > 0.5 {
			aboveHalf++
		}
	}
	if aboveHalf == 0 {
		t.Error("Beta(5,17) never exceeded 0.5 in 1000 draws — no exploration")
	}
	if aboveHalf > 200 {
		t.Errorf("Beta(5,17) exceeded 0.5 in %d/1000 draws — too much exploration", aboveHalf)
	}
}

func TestBetaSample_EdgeCases(t *testing.T) {
	t.Parallel()
	rng := newTestRNG()

	// Zero/negative parameters should clamp to 1.
	s := betaSample(rng, 0, 0)
	if s < 0 || s > 1 {
		t.Errorf("betaSample(0, 0) = %v, want [0, 1]", s)
	}

	// Very small shape parameters (fractional, <1).
	s = betaSample(rng, 0.1, 0.1)
	if s < 0 || s > 1 {
		t.Errorf("betaSample(0.1, 0.1) = %v, want [0, 1]", s)
	}
}

func TestGammaSample_Positive(t *testing.T) {
	t.Parallel()
	rng := newTestRNG()
	for range 100 {
		g := gammaSample(rng, 2.0)
		if g < 0 {
			t.Fatalf("gammaSample returned negative: %v", g)
		}
	}
}
