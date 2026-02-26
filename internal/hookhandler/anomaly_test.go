package hookhandler

import "testing"

func TestPhaseDist(t *testing.T) {
	t.Parallel()
	dist := phaseDist([]string{"read", "read", "read", "write", "test"})
	if got := dist["read"]; got < 0.59 || got > 0.61 {
		t.Errorf("phaseDist read = %v, want ~0.6", got)
	}
	if got := dist["write"]; got < 0.19 || got > 0.21 {
		t.Errorf("phaseDist write = %v, want ~0.2", got)
	}
}

func TestCountTransitions(t *testing.T) {
	t.Parallel()
	phases := []string{"write", "compile", "write", "test", "write", "compile"}
	if got := countTransitions(phases, "write", "compile"); got != 2 {
		t.Errorf("countTransitions(write→compile) = %d, want 2", got)
	}
	if got := countTransitions(phases, "write", "test"); got != 1 {
		t.Errorf("countTransitions(write→test) = %d, want 1", got)
	}
}

func TestDetectAnomaly_ExploreSpiral(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// Seed 12 read phases.
	for range 12 {
		_ = sdb.RecordPhase("read", "Read")
	}

	anomaly, msg := detectAnomaly(sdb)
	if anomaly != AnomalyExploreSpiral {
		t.Errorf("detectAnomaly() = %q, want explore_spiral", anomaly)
	}
	if msg == "" {
		t.Error("detectAnomaly() msg is empty, want description")
	}
}

func TestDetectAnomaly_DebugSpiral(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// Seed write→compile cycle.
	for range 5 {
		_ = sdb.RecordPhase("read", "Read")
		_ = sdb.RecordPhase("write", "Edit")
		_ = sdb.RecordPhase("compile", "Bash")
	}
	// Set high error rate.
	_ = sdb.SetContext("ewma_error_rate", "0.5")

	anomaly, msg := detectAnomaly(sdb)
	if anomaly != AnomalyDebugSpiral {
		t.Errorf("detectAnomaly() = %q, want debug_spiral", anomaly)
	}
	if msg == "" {
		t.Error("detectAnomaly() msg is empty, want description")
	}
}

func TestDetectAnomaly_Healthy(t *testing.T) {
	t.Parallel()
	sdb := openFlowTestDB(t)

	// Balanced phases.
	for range 4 {
		_ = sdb.RecordPhase("read", "Read")
		_ = sdb.RecordPhase("write", "Edit")
		_ = sdb.RecordPhase("test", "Bash")
	}

	anomaly, _ := detectAnomaly(sdb)
	if anomaly != AnomalyNone {
		t.Errorf("detectAnomaly() = %q, want none", anomaly)
	}
}
