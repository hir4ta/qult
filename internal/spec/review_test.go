package spec

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoadReview(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	sd := &SpecDir{ProjectPath: dir, TaskSlug: "test-task"}

	// Create spec directory.
	if _, err := Init(dir, "test-task", "test"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	// Save a review.
	r := &Review{
		Timestamp: time.Date(2026, 3, 15, 10, 30, 0, 0, time.UTC),
		Status:    ReviewChangesRequested,
		Summary:   "needs work on auth section",
		Comments: []ReviewComment{
			{File: "design.md", Line: 42, Body: "security risk here"},
			{File: "requirements.md", Line: 15, Body: "scope too broad"},
		},
	}
	if err := sd.SaveReview(r); err != nil {
		t.Fatalf("SaveReview: %v", err)
	}

	// Load latest.
	latest, err := sd.LatestReview()
	if err != nil {
		t.Fatalf("LatestReview: %v", err)
	}
	if latest == nil {
		t.Fatal("LatestReview returned nil")
	}
	if latest.Status != ReviewChangesRequested {
		t.Errorf("Status = %q, want %q", latest.Status, ReviewChangesRequested)
	}
	if len(latest.Comments) != 2 {
		t.Errorf("len(Comments) = %d, want 2", len(latest.Comments))
	}
	if latest.Summary != "needs work on auth section" {
		t.Errorf("Summary = %q, want %q", latest.Summary, "needs work on auth section")
	}
}

func TestMultipleReviews(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	sd := &SpecDir{ProjectPath: dir, TaskSlug: "multi-review"}

	if _, err := Init(dir, "multi-review", "test"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	// Save two reviews.
	r1 := &Review{
		Timestamp: time.Date(2026, 3, 15, 10, 0, 0, 0, time.UTC),
		Status:    ReviewChangesRequested,
		Comments:  []ReviewComment{{File: "design.md", Line: 1, Body: "first"}},
	}
	r2 := &Review{
		Timestamp: time.Date(2026, 3, 15, 11, 0, 0, 0, time.UTC),
		Status:    ReviewApproved,
	}
	if err := sd.SaveReview(r1); err != nil {
		t.Fatalf("SaveReview r1: %v", err)
	}
	if err := sd.SaveReview(r2); err != nil {
		t.Fatalf("SaveReview r2: %v", err)
	}

	// Latest should be r2 (approved).
	latest, err := sd.LatestReview()
	if err != nil {
		t.Fatalf("LatestReview: %v", err)
	}
	if latest.Status != ReviewApproved {
		t.Errorf("Status = %q, want %q", latest.Status, ReviewApproved)
	}

	// All reviews.
	all, err := sd.AllReviews()
	if err != nil {
		t.Fatalf("AllReviews: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("len(AllReviews) = %d, want 2", len(all))
	}
}

func TestUnresolvedComments(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	sd := &SpecDir{ProjectPath: dir, TaskSlug: "unresolved"}

	if _, err := Init(dir, "unresolved", "test"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	r := &Review{
		Status: ReviewChangesRequested,
		Comments: []ReviewComment{
			{File: "design.md", Line: 1, Body: "fix this", Resolved: false},
			{File: "design.md", Line: 5, Body: "already fixed", Resolved: true},
			{File: "requirements.md", Line: 10, Body: "clarify", Resolved: false},
		},
	}
	if err := sd.SaveReview(r); err != nil {
		t.Fatalf("SaveReview: %v", err)
	}

	unresolved, err := sd.UnresolvedComments()
	if err != nil {
		t.Fatalf("UnresolvedComments: %v", err)
	}
	if len(unresolved) != 2 {
		t.Errorf("len(UnresolvedComments) = %d, want 2", len(unresolved))
	}
}

func TestNoReviews(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	sd := &SpecDir{ProjectPath: dir, TaskSlug: "no-reviews"}

	if _, err := Init(dir, "no-reviews", "test"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	latest, err := sd.LatestReview()
	if err != nil {
		t.Fatalf("LatestReview: %v", err)
	}
	if latest != nil {
		t.Error("expected nil for no reviews")
	}
}

func TestSetReviewStatus(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	if _, err := Init(dir, "status-test", "test"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	// Set review status.
	if err := SetReviewStatus(dir, "status-test", ReviewPending); err != nil {
		t.Fatalf("SetReviewStatus: %v", err)
	}

	// Read back.
	status := ReviewStatusFor(dir, "status-test")
	if status != ReviewPending {
		t.Errorf("ReviewStatusFor = %q, want %q", status, ReviewPending)
	}

	// Update to approved.
	if err := SetReviewStatus(dir, "status-test", ReviewApproved); err != nil {
		t.Fatalf("SetReviewStatus(approved): %v", err)
	}
	status = ReviewStatusFor(dir, "status-test")
	if status != ReviewApproved {
		t.Errorf("ReviewStatusFor = %q, want %q", status, ReviewApproved)
	}
}

func TestReviewsDir(t *testing.T) {
	t.Parallel()
	sd := &SpecDir{ProjectPath: "/tmp/proj", TaskSlug: "my-task"}
	want := filepath.Join("/tmp/proj", ".alfred", "specs", "my-task", "reviews")
	got := sd.ReviewsDir()
	if got != want {
		t.Errorf("ReviewsDir() = %q, want %q", got, want)
	}
}
