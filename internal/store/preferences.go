package store

import (
	"database/sql"
	"fmt"
)

// UserPref represents adaptive suggestion effectiveness data for a pattern.
type UserPref struct {
	Pattern            string
	DeliveryCount      int
	ResolutionCount    int
	IgnoreCount        int
	AvgResponseTimeSec float64
	EffectivenessScore float64
}

// UpsertUserPreference updates the effectiveness tracking for a nudge pattern.
// Uses a weighted moving average: new_score = 0.7 * old + 0.3 * signal.
func (s *Store) UpsertUserPreference(pattern string, resolved bool, responseTimeSec float64) error {
	var existing UserPref
	err := s.db.QueryRow(
		`SELECT delivery_count, resolution_count, ignore_count, avg_response_time_sec, effectiveness_score
		 FROM user_preferences WHERE pattern = ?`, pattern,
	).Scan(&existing.DeliveryCount, &existing.ResolutionCount, &existing.IgnoreCount,
		&existing.AvgResponseTimeSec, &existing.EffectivenessScore)

	if err == sql.ErrNoRows {
		// First delivery of this pattern.
		score := 0.5
		if resolved {
			score = 0.65
		} else {
			score = 0.35
		}
		resCount := 0
		ignCount := 0
		if resolved {
			resCount = 1
		} else {
			ignCount = 1
		}
		_, err = s.db.Exec(
			`INSERT INTO user_preferences (pattern, delivery_count, resolution_count, ignore_count, avg_response_time_sec, effectiveness_score)
			 VALUES (?, 1, ?, ?, ?, ?)`,
			pattern, resCount, ignCount, responseTimeSec, score,
		)
		if err != nil {
			return fmt.Errorf("store: insert user preference: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("store: query user preference: %w", err)
	}

	// Weighted moving average.
	signal := 0.0
	if resolved {
		signal = 1.0
	}
	newScore := 0.7*existing.EffectivenessScore + 0.3*signal

	// Running average for response time (only on resolution).
	newAvgTime := existing.AvgResponseTimeSec
	if resolved && responseTimeSec > 0 {
		total := existing.ResolutionCount
		if total == 0 {
			newAvgTime = responseTimeSec
		} else {
			newAvgTime = (existing.AvgResponseTimeSec*float64(total) + responseTimeSec) / float64(total+1)
		}
	}

	resInc := 0
	ignInc := 0
	if resolved {
		resInc = 1
	} else {
		ignInc = 1
	}

	_, err = s.db.Exec(
		`UPDATE user_preferences
		 SET delivery_count = delivery_count + 1,
		     resolution_count = resolution_count + ?,
		     ignore_count = ignore_count + ?,
		     avg_response_time_sec = ?,
		     effectiveness_score = ?,
		     updated_at = datetime('now')
		 WHERE pattern = ?`,
		resInc, ignInc, newAvgTime, newScore, pattern,
	)
	if err != nil {
		return fmt.Errorf("store: update user preference: %w", err)
	}
	return nil
}

// UserPreference returns the effectiveness data for a pattern.
// Returns nil if no data exists.
func (s *Store) UserPreference(pattern string) (*UserPref, error) {
	var p UserPref
	err := s.db.QueryRow(
		`SELECT pattern, delivery_count, resolution_count, ignore_count, avg_response_time_sec, effectiveness_score
		 FROM user_preferences WHERE pattern = ?`, pattern,
	).Scan(&p.Pattern, &p.DeliveryCount, &p.ResolutionCount, &p.IgnoreCount,
		&p.AvgResponseTimeSec, &p.EffectivenessScore)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: get user preference: %w", err)
	}
	return &p, nil
}
