package analyzer

import "testing"

func TestWelfordUpdate_SingleValue(t *testing.T) {
	t.Parallel()
	w := WelfordState{MetricName: "test"}
	w.Update(5.0)

	if w.Count != 1 {
		t.Errorf("Count = %d, want 1", w.Count)
	}
	if w.Mean != 5.0 {
		t.Errorf("Mean = %v, want 5.0", w.Mean)
	}
	if w.M2 != 0.0 {
		t.Errorf("M2 = %v, want 0.0", w.M2)
	}
	if w.Variance() != 0 {
		t.Errorf("Variance = %v, want 0", w.Variance())
	}
}

func TestWelfordUpdate_KnownValues(t *testing.T) {
	t.Parallel()
	// [2, 4, 4, 4, 5, 5, 7, 9] -> mean=5, variance≈4
	w := WelfordState{MetricName: "test"}
	for _, v := range []float64{2, 4, 4, 4, 5, 5, 7, 9} {
		w.Update(v)
	}

	if w.Count != 8 {
		t.Errorf("Count = %d, want 8", w.Count)
	}
	if diff := w.Mean - 5.0; diff > 0.001 || diff < -0.001 {
		t.Errorf("Mean = %v, want ~5.0", w.Mean)
	}
	// Sample variance = 4.571...
	wantVar := 4.571
	if diff := w.Variance() - wantVar; diff > 0.01 || diff < -0.01 {
		t.Errorf("Variance = %v, want ~%v", w.Variance(), wantVar)
	}
}

func TestWelfordThreshold_FallbackWhenFewSamples(t *testing.T) {
	t.Parallel()
	w := WelfordState{MetricName: "test"}
	for range 5 {
		w.Update(3.0)
	}

	got := w.Threshold(2.0, 99.0, 10)
	if got != 99.0 {
		t.Errorf("Threshold with count<minSamples = %v, want fallback 99.0", got)
	}
}

func TestWelfordThreshold_AdaptiveWhenEnough(t *testing.T) {
	t.Parallel()
	w := WelfordState{MetricName: "test"}
	// All same value -> stddev=0, threshold=mean.
	for range 15 {
		w.Update(5.0)
	}

	got := w.Threshold(2.0, 99.0, 10)
	if got != 5.0 {
		t.Errorf("Threshold with zero variance = %v, want 5.0 (mean)", got)
	}
}

func TestWelfordStdDev(t *testing.T) {
	t.Parallel()
	w := WelfordState{MetricName: "test"}
	for _, v := range []float64{2, 4, 4, 4, 5, 5, 7, 9} {
		w.Update(v)
	}

	sd := w.StdDev()
	if sd < 2.0 || sd > 2.2 {
		t.Errorf("StdDev = %v, want ~2.138", sd)
	}
}
