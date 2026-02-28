package hookhandler

import (
	"math/rand/v2"
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
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

func TestIsAtWorkflowBoundary(t *testing.T) {
	t.Parallel()
	sdb := openDeliveryTestDB(t)

	// Initially not at boundary.
	if isAtWorkflowBoundary(sdb) {
		t.Error("isAtWorkflowBoundary() = true on fresh session, want false")
	}

	// Set flag → should return true and consume it.
	_ = sdb.SetContext("at_workflow_boundary", "true")
	if !isAtWorkflowBoundary(sdb) {
		t.Error("isAtWorkflowBoundary() = false after setting flag, want true")
	}

	// Flag consumed — second call should return false.
	if isAtWorkflowBoundary(sdb) {
		t.Error("isAtWorkflowBoundary() = true after consumption, want false")
	}
}

func TestWorkflowBoundaryBoost(t *testing.T) {
	// Not parallel — modifies package globals (ctxTaskType, ctxVelocityState).
	sdb := openDeliveryTestDB(t)

	// Reset contextual globals so Thompson Sampling uses base pattern keys.
	ctxTaskType = ""
	ctxVelocityState = ""

	// Without boundary flag: isAtWorkflowBoundary returns false.
	if isAtWorkflowBoundary(sdb) {
		t.Error("isAtWorkflowBoundary() = true without flag, want false")
	}

	// Set boundary flag: should return true and consume it.
	_ = sdb.SetContext("at_workflow_boundary", "true")
	if !isAtWorkflowBoundary(sdb) {
		t.Error("isAtWorkflowBoundary() = false with flag set, want true")
	}

	// Verify the boost logic in RouteDelivery: at a boundary, Medium priority
	// is promoted to High before Thompson Sampling. We test via Critical priority
	// (which bypasses Thompson Sampling entirely) to verify the routing pipeline.
	_ = sdb.SetContext("at_workflow_boundary", "true")
	d := RouteDelivery(sdb, "test-critical-boundary", PriorityCritical)
	if d.Channel != ChannelImmediate {
		t.Errorf("Critical priority at boundary: channel = %d, want %d (immediate)", d.Channel, ChannelImmediate)
	}
}

func TestContextualPatternKey(t *testing.T) {
	// Not parallel — modifies package globals (ctxTaskType, ctxVelocityState).
	tests := []struct {
		name     string
		taskType string
		velState string
		cluster  string
		pattern  string
		want     string
	}{
		{"no context", "", "", "", "workflow", "workflow"},
		{"task only", "bugfix", "", "", "workflow", "workflow:bugfix:balanced"},
		{"velocity_ignored", "", "fast", "", "workflow", "workflow"},
		{"full context", "feature", "slow", "", "checkpoint", "checkpoint:feature:balanced"},
		{"with cluster", "bugfix", "fast", "conservative", "workflow", "workflow:bugfix:conservative"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctxTaskType = tt.taskType
			ctxVelocityState = tt.velState
			ctxUserCluster = tt.cluster
			got := contextualPatternKey(tt.pattern)
			if got != tt.want {
				t.Errorf("contextualPatternKey(%q) = %q, want %q", tt.pattern, got, tt.want)
			}
		})
	}
}

func TestSetDeliveryContext(t *testing.T) {
	// Not parallel — modifies package globals.
	sdb := openDeliveryTestDB(t)

	// Set task_type and velocity.
	_ = sdb.SetContext("task_type", "refactor")
	_ = sdb.SetContext("ewma_tool_velocity", "12.0")
	SetDeliveryContext(sdb)

	if ctxTaskType != "refactor" {
		t.Errorf("ctxTaskType = %q, want %q", ctxTaskType, "refactor")
	}
	if ctxVelocityState != "fast" {
		t.Errorf("ctxVelocityState = %q, want %q", ctxVelocityState, "fast")
	}

	// Low velocity → slow.
	_ = sdb.SetContext("ewma_tool_velocity", "1.0")
	SetDeliveryContext(sdb)
	if ctxVelocityState != "slow" {
		t.Errorf("ctxVelocityState = %q, want %q", ctxVelocityState, "slow")
	}

	// Normal velocity.
	_ = sdb.SetContext("ewma_tool_velocity", "5.0")
	SetDeliveryContext(sdb)
	if ctxVelocityState != "normal" {
		t.Errorf("ctxVelocityState = %q, want %q", ctxVelocityState, "normal")
	}
}

func TestRouteDelivery_LowComplexity_Suppresses(t *testing.T) {
	// Not parallel — modifies package globals.
	sdb := openDeliveryTestDB(t)
	ctxTaskType = ""
	ctxVelocityState = ""
	ctxUserCluster = ""

	_ = sdb.SetContext("task_complexity", "low")

	// Medium priority suppressed for low-complexity tasks.
	// Use unique pattern names with no store history to avoid graduated demotion interference.
	d := RouteDelivery(sdb, "test-complexity-gate-med", PriorityMedium)
	if d.Channel != ChannelSuppress {
		t.Errorf("RouteDelivery(Medium, low complexity) channel = %d, want %d (suppress)",
			d.Channel, ChannelSuppress)
	}

	// Low priority also suppressed.
	d = RouteDelivery(sdb, "test-complexity-gate-low", PriorityLow)
	if d.Channel != ChannelSuppress {
		t.Errorf("RouteDelivery(Low, low complexity) channel = %d, want %d (suppress)",
			d.Channel, ChannelSuppress)
	}

	// High priority still goes through.
	d = RouteDelivery(sdb, "test-complexity-gate-high", PriorityHigh)
	if d.Channel == ChannelSuppress {
		t.Error("RouteDelivery(High, low complexity) should not suppress")
	}

	// Critical always passes.
	d = RouteDelivery(sdb, "destructive", PriorityCritical)
	if d.Channel != ChannelImmediate {
		t.Errorf("RouteDelivery(Critical, low complexity) channel = %d, want %d (immediate)",
			d.Channel, ChannelImmediate)
	}
}

func TestRouteDelivery_HighComplexity_NoSuppression(t *testing.T) {
	// Not parallel — modifies package globals.
	sdb := openDeliveryTestDB(t)
	ctxTaskType = ""
	ctxVelocityState = ""
	ctxUserCluster = ""

	_ = sdb.SetContext("task_complexity", "high")

	// Medium priority should NOT be suppressed for high-complexity tasks.
	// Use unique pattern name with no store history to avoid graduated demotion interference.
	d := RouteDelivery(sdb, "test-complexity-gate-med", PriorityMedium)
	if d.Channel == ChannelSuppress {
		t.Error("RouteDelivery(Medium, high complexity) should not suppress")
	}
}

func openDeliveryTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-delivery-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}
