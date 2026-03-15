package spec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ReviewStatus represents the approval state of a spec.
type ReviewStatus string

const (
	ReviewPending          ReviewStatus = "pending"
	ReviewApproved         ReviewStatus = "approved"
	ReviewChangesRequested ReviewStatus = "changes_requested"
)

// ReviewComment is an inline comment on a specific line of a spec file.
type ReviewComment struct {
	File     string `json:"file"`               // "requirements.md", "design.md", etc.
	Line     int    `json:"line"`               // 1-based line number
	Body     string `json:"body"`               // comment text
	Resolved bool   `json:"resolved,omitempty"` // marked resolved by Claude Code
}

// Review is a single review session (one "Submit Review" action).
type Review struct {
	Timestamp time.Time       `json:"timestamp"`
	Status    ReviewStatus    `json:"status"`              // approved or changes_requested
	Comments  []ReviewComment `json:"comments,omitempty"`  // inline comments
	Summary   string          `json:"summary,omitempty"`   // overall review note
}

// ReviewsDir returns the path to a task's reviews directory.
func (s *SpecDir) ReviewsDir() string {
	return filepath.Join(s.Dir(), "reviews")
}

// SaveReview persists a review to the reviews/ directory as JSON.
func (s *SpecDir) SaveReview(r *Review) error {
	dir := s.ReviewsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create reviews dir: %w", err)
	}

	if r.Timestamp.IsZero() {
		r.Timestamp = time.Now().UTC()
	}

	filename := fmt.Sprintf("review-%s.json", r.Timestamp.Format("20060102-150405"))
	path := filepath.Join(dir, filename)

	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal review: %w", err)
	}
	return os.WriteFile(path, data, 0o644)
}

// LatestReview reads the most recent review from the reviews/ directory.
// Returns nil if no reviews exist.
func (s *SpecDir) LatestReview() (*Review, error) {
	dir := s.ReviewsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read reviews dir: %w", err)
	}

	// Files are named review-YYYYMMDD-HHMMSS.json → lexicographic sort = chronological.
	var latest string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			latest = e.Name()
		}
	}
	if latest == "" {
		return nil, nil
	}

	data, err := os.ReadFile(filepath.Join(dir, latest))
	if err != nil {
		return nil, fmt.Errorf("read review %s: %w", latest, err)
	}

	var r Review
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("unmarshal review %s: %w", latest, err)
	}
	return &r, nil
}

// AllReviews reads all reviews sorted chronologically (oldest first).
func (s *SpecDir) AllReviews() ([]Review, error) {
	dir := s.ReviewsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read reviews dir: %w", err)
	}

	var reviews []Review
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var r Review
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		reviews = append(reviews, r)
	}
	return reviews, nil
}

// UnresolvedComments returns all comments from the latest review that are not resolved.
func (s *SpecDir) UnresolvedComments() ([]ReviewComment, error) {
	r, err := s.LatestReview()
	if err != nil || r == nil {
		return nil, err
	}
	var unresolved []ReviewComment
	for _, c := range r.Comments {
		if !c.Resolved {
			unresolved = append(unresolved, c)
		}
	}
	return unresolved, nil
}
