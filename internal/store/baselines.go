package store

import (
	"fmt"
	"math"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
)

// GetBaseline returns the Welford state for a metric, or nil if not found.
func (s *Store) GetBaseline(metricName string) (*analyzer.WelfordState, error) {
	var w analyzer.WelfordState
	err := s.db.QueryRow(
		`SELECT metric_name, count, mean, m2 FROM adaptive_baselines WHERE metric_name = ?`,
		metricName,
	).Scan(&w.MetricName, &w.Count, &w.Mean, &w.M2)
	if err != nil {
		return nil, fmt.Errorf("store: get baseline: %w", err)
	}
	return &w, nil
}

// UpdateBaseline atomically applies a new observation to a metric's running stats
// using Welford's online algorithm within a transaction.
func (s *Store) UpdateBaseline(metricName string, value float64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: begin tx for baseline: %w", err)
	}
	defer tx.Rollback() //nolint: errcheck

	var count int64
	var mean, m2 float64
	err = tx.QueryRow(
		`SELECT count, mean, m2 FROM adaptive_baselines WHERE metric_name = ?`,
		metricName,
	).Scan(&count, &mean, &m2)

	if err != nil {
		// Row doesn't exist yet — insert.
		_, err = tx.Exec(
			`INSERT INTO adaptive_baselines (metric_name, count, mean, m2) VALUES (?, 1, ?, 0.0)`,
			metricName, value,
		)
		if err != nil {
			return fmt.Errorf("store: insert baseline: %w", err)
		}
		return tx.Commit()
	}

	// Welford update.
	count++
	delta := value - mean
	mean += delta / float64(count)
	delta2 := value - mean
	m2 += delta * delta2

	_, err = tx.Exec(
		`UPDATE adaptive_baselines SET count = ?, mean = ?, m2 = ?, last_updated = datetime('now')
		 WHERE metric_name = ?`,
		count, mean, m2, metricName,
	)
	if err != nil {
		return fmt.Errorf("store: update baseline: %w", err)
	}
	return tx.Commit()
}

// GetAdaptiveThreshold returns the adaptive threshold for a metric.
// Falls back to hardcodedDefault when fewer than minSamples observations exist.
func (s *Store) GetAdaptiveThreshold(metricName string, k float64, hardcodedDefault float64, minSamples int64) (float64, error) {
	w, err := s.GetBaseline(metricName)
	if err != nil {
		return hardcodedDefault, nil
	}
	if w.Count < minSamples {
		return hardcodedDefault, nil
	}
	sd := math.Sqrt(w.M2 / float64(w.Count-1))
	return w.Mean + k*sd, nil
}
