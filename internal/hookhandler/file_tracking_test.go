package hookhandler

import (
	"fmt"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

func openFileTrackingTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-filetrack-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestDetectionConfidence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		complexity string
		fileCount  int
		wantMin    float64
		wantMax    float64
	}{
		{"low complexity few files", "low", 1, 0.1, 0.3},
		{"low complexity many files", "low", 6, 0.05, 0.15},
		{"medium complexity few files", "medium", 1, 0.6, 0.8},
		{"medium complexity many files", "medium", 6, 0.3, 0.4},
		{"high complexity few files", "high", 1, 0.9, 1.01},
		{"high complexity many files", "high", 6, 0.4, 0.6},
		{"unknown complexity", "", 1, 0.4, 0.6},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openFileTrackingTestDB(t)
			if tt.complexity != "" {
				_ = sdb.SetContext("task_complexity", tt.complexity)
			}
			for i := range tt.fileCount {
				_ = sdb.AddWorkingSetFile(fmt.Sprintf("/src/file%d.go", i))
			}
			got := detectionConfidence(sdb)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("detectionConfidence() = %.3f, want [%.2f, %.2f]",
					got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestDetectionConfidence_LowComplexity_BelowThreshold(t *testing.T) {
	t.Parallel()
	sdb := openFileTrackingTestDB(t)
	_ = sdb.SetContext("task_complexity", "low")

	conf := detectionConfidence(sdb)
	if conf >= 0.3 {
		t.Errorf("detectionConfidence() = %.2f for low complexity, want < 0.3", conf)
	}
}
