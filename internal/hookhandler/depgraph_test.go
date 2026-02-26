package hookhandler

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTransitiveImporters(t *testing.T) {
	t.Parallel()

	// Build a simple dep graph:
	//   A → B → C
	//   A → D
	//   E → C
	graph := depGraph{
		"A": {"B", "D"},
		"B": {"C"},
		"E": {"C"},
	}

	tests := []struct {
		name     string
		pkg      string
		maxDepth int
		wantMin  int // minimum expected count
	}{
		{"leaf node", "C", 3, 0},
		{"root with direct deps", "A", 1, 2},    // B, D
		{"root with transitive", "A", 3, 3},      // B, D, C
		{"mid node", "B", 3, 1},                   // C
		{"shared dep", "E", 3, 1},                  // C
		{"unknown pkg", "Z", 3, 0},
		{"nil graph", "A", 3, 0},
		{"depth 0", "A", 0, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			g := graph
			if tt.name == "nil graph" {
				g = nil
			}
			got := transitiveImporters(g, tt.pkg, tt.maxDepth)
			if len(got) < tt.wantMin {
				t.Errorf("transitiveImporters(%q, %d) = %d results, want >= %d",
					tt.pkg, tt.maxDepth, len(got), tt.wantMin)
			}
		})
	}
}

func TestNormalizeModule(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{"./utils", "utils"},
		{"../lib/helpers", "lib/helpers"},
		{"../../deep/nested", "deep/nested"},
		{"../../../a/b", "a/b"},
		{"react", "react"},
		{"./components/Button.tsx", "components/Button"},
		{"utils.py", "utils"},
		{"lodash", "lodash"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := normalizeModule(tt.input)
			if got != tt.want {
				t.Errorf("normalizeModule(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestGoModulePath(t *testing.T) {
	t.Parallel()

	t.Run("valid go.mod", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		content := "module github.com/example/project\n\ngo 1.22\n"
		if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		got := goModulePath(dir)
		if got != "github.com/example/project" {
			t.Errorf("goModulePath() = %q, want %q", got, "github.com/example/project")
		}
	})

	t.Run("no go.mod", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		got := goModulePath(dir)
		if got != "" {
			t.Errorf("goModulePath() = %q, want empty", got)
		}
	})
}

func TestComputeBlastScore_TransitiveImporters(t *testing.T) {
	t.Parallel()

	base := &ImpactInfo{
		Importers: []string{"a.go"},
		TestFiles: []string{"a_test.go"},
	}
	baseScore := computeBlastScore(base)

	withTransitive := &ImpactInfo{
		Importers:           []string{"a.go"},
		TestFiles:           []string{"a_test.go"},
		TransitiveImporterN: 3,
	}
	transitiveScore := computeBlastScore(withTransitive)

	if transitiveScore <= baseScore {
		t.Errorf("transitive importers should increase blast score: base=%d, withTransitive=%d",
			baseScore, transitiveScore)
	}

	// 3 transitive importers × 3 pts = 9 pts difference.
	if diff := transitiveScore - baseScore; diff != 9 {
		t.Errorf("expected 9 point increase, got %d", diff)
	}
}
