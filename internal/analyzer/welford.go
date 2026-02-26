package analyzer

import "math"

// WelfordState holds running statistics for a metric using Welford's online algorithm.
type WelfordState struct {
	MetricName string
	Count      int64
	Mean       float64
	M2         float64
}

// Update applies a new observation to the running statistics.
func (w *WelfordState) Update(value float64) {
	w.Count++
	delta := value - w.Mean
	w.Mean += delta / float64(w.Count)
	delta2 := value - w.Mean
	w.M2 += delta * delta2
}

// Variance returns the sample variance. Returns 0 if count < 2.
func (w *WelfordState) Variance() float64 {
	if w.Count < 2 {
		return 0
	}
	return w.M2 / float64(w.Count-1)
}

// StdDev returns the sample standard deviation.
func (w *WelfordState) StdDev() float64 {
	return math.Sqrt(w.Variance())
}

// Threshold returns mean + k*stddev as the adaptive threshold.
// Returns the hardcoded fallback if count < minSamples.
func (w *WelfordState) Threshold(k float64, fallback float64, minSamples int64) float64 {
	if w.Count < minSamples {
		return fallback
	}
	return w.Mean + k*w.StdDev()
}
