package store

import (
	"database/sql"
	"fmt"
)

// FeedbackRating represents the rating for a suggestion.
type FeedbackRating string

const (
	RatingHelpful          FeedbackRating = "helpful"
	RatingPartiallyHelpful FeedbackRating = "partially_helpful"
	RatingNotHelpful       FeedbackRating = "not_helpful"
	RatingMisleading       FeedbackRating = "misleading"
)

// FeedbackStats holds aggregated feedback statistics for a pattern.
type FeedbackStats struct {
	TotalCount   int
	Helpful      int
	Partial      int
	NotHelpful   int
	Misleading   int
	WeightedScore float64 // [-1, 1] range
}

// InsertFeedback records explicit feedback for a suggestion pattern.
func (s *Store) InsertFeedback(sessionID, pattern string, rating FeedbackRating, comment string, suggestionID int64) error {
	var sugID sql.NullInt64
	if suggestionID > 0 {
		sugID = sql.NullInt64{Int64: suggestionID, Valid: true}
	}
	_, err := s.db.Exec(
		`INSERT INTO feedbacks (session_id, pattern, rating, suggestion_id, comment)
		 VALUES (?, ?, ?, ?, ?)`,
		sessionID, pattern, string(rating), sugID, comment,
	)
	if err != nil {
		return fmt.Errorf("store: insert feedback: %w", err)
	}
	return nil
}

// PatternFeedbackStats returns aggregated feedback stats for a pattern.
// Uses data from the last 90 days for relevance.
func (s *Store) PatternFeedbackStats(pattern string) (*FeedbackStats, error) {
	rows, err := s.db.Query(
		`SELECT rating, COUNT(*) FROM feedbacks
		 WHERE pattern = ? AND created_at > datetime('now', '-90 days')
		 GROUP BY rating`, pattern,
	)
	if err != nil {
		return nil, fmt.Errorf("store: feedback stats: %w", err)
	}
	defer rows.Close()

	stats := &FeedbackStats{}
	for rows.Next() {
		var rating string
		var count int
		if err := rows.Scan(&rating, &count); err != nil {
			continue
		}
		switch FeedbackRating(rating) {
		case RatingHelpful:
			stats.Helpful = count
		case RatingPartiallyHelpful:
			stats.Partial = count
		case RatingNotHelpful:
			stats.NotHelpful = count
		case RatingMisleading:
			stats.Misleading = count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: feedback stats rows: %w", err)
	}

	stats.TotalCount = stats.Helpful + stats.Partial + stats.NotHelpful + stats.Misleading
	if stats.TotalCount == 0 {
		return stats, nil
	}

	// Weighted score: helpful=+0.8, partial=+0.3, not_helpful=-0.4, misleading=-0.8
	weighted := float64(stats.Helpful)*0.8 +
		float64(stats.Partial)*0.3 +
		float64(stats.NotHelpful)*(-0.4) +
		float64(stats.Misleading)*(-0.8)
	stats.WeightedScore = weighted / float64(stats.TotalCount)

	return stats, nil
}

// AllFeedbackStats returns aggregated feedback stats across all patterns.
func (s *Store) AllFeedbackStats() (*FeedbackStats, error) {
	rows, err := s.db.Query(
		`SELECT rating, COUNT(*) FROM feedbacks
		 WHERE created_at > datetime('now', '-90 days')
		 GROUP BY rating`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: all feedback stats: %w", err)
	}
	defer rows.Close()

	stats := &FeedbackStats{}
	for rows.Next() {
		var rating string
		var count int
		if err := rows.Scan(&rating, &count); err != nil {
			continue
		}
		switch FeedbackRating(rating) {
		case RatingHelpful:
			stats.Helpful = count
		case RatingPartiallyHelpful:
			stats.Partial = count
		case RatingNotHelpful:
			stats.NotHelpful = count
		case RatingMisleading:
			stats.Misleading = count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: all feedback stats rows: %w", err)
	}

	stats.TotalCount = stats.Helpful + stats.Partial + stats.NotHelpful + stats.Misleading
	if stats.TotalCount > 0 {
		weighted := float64(stats.Helpful)*0.8 +
			float64(stats.Partial)*0.3 +
			float64(stats.NotHelpful)*(-0.4) +
			float64(stats.Misleading)*(-0.8)
		stats.WeightedScore = weighted / float64(stats.TotalCount)
	}

	return stats, nil
}

// CheckFeedbackContradiction compares the most recent auto-feedback and explicit feedback
// for a pattern. Returns true if they contradict (e.g., auto=helpful but explicit=misleading),
// indicating auto-feedback inference is unreliable for this pattern.
func (s *Store) CheckFeedbackContradiction(pattern string) bool {
	// Get the most recent auto feedback (comment starts with "auto:").
	var autoRating string
	err := s.db.QueryRow(
		`SELECT rating FROM feedbacks
		 WHERE pattern = ? AND comment LIKE 'auto:%'
		 ORDER BY created_at DESC LIMIT 1`, pattern,
	).Scan(&autoRating)
	if err != nil {
		return false
	}

	// Get the most recent explicit feedback (no "auto:" comment).
	var explicitRating string
	err = s.db.QueryRow(
		`SELECT rating FROM feedbacks
		 WHERE pattern = ? AND (comment IS NULL OR comment = '' OR comment NOT LIKE 'auto:%')
		 ORDER BY created_at DESC LIMIT 1`, pattern,
	).Scan(&explicitRating)
	if err != nil {
		return false
	}

	// Contradiction: auto says positive but explicit says negative, or vice versa.
	autoPositive := autoRating == string(RatingHelpful) || autoRating == string(RatingPartiallyHelpful)
	explicitNegative := explicitRating == string(RatingNotHelpful) || explicitRating == string(RatingMisleading)
	if autoPositive && explicitNegative {
		return true
	}

	autoNegative := autoRating == string(RatingNotHelpful) || autoRating == string(RatingMisleading)
	explicitPositive := explicitRating == string(RatingHelpful) || explicitRating == string(RatingPartiallyHelpful)
	return autoNegative && explicitPositive
}

// RecentFeedbacks returns the most recent feedbacks, optionally filtered by pattern.
func (s *Store) RecentFeedbacks(pattern string, limit int) ([]map[string]any, error) {
	if limit < 1 {
		limit = 10
	}

	query := `SELECT session_id, pattern, rating, comment, created_at FROM feedbacks`
	var args []any
	if pattern != "" {
		query += ` WHERE pattern = ?`
		args = append(args, pattern)
	}
	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: recent feedbacks: %w", err)
	}
	defer rows.Close()

	var results []map[string]any
	for rows.Next() {
		var sessionID, pat, rating, created string
		var comment sql.NullString
		if err := rows.Scan(&sessionID, &pat, &rating, &comment, &created); err != nil {
			continue
		}
		entry := map[string]any{
			"session_id": sessionID,
			"pattern":    pat,
			"rating":     rating,
			"created_at": created,
		}
		if comment.Valid {
			entry["comment"] = comment.String
		}
		results = append(results, entry)
	}
	return results, rows.Err()
}
