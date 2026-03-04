package install

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadCustomSources_ViaParseSourcesFile(t *testing.T) {
	t.Parallel()

	t.Run("valid YAML parsed correctly", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		path := filepath.Join(dir, "sources.yaml")
		content := `sources:
  - name: React
    url: https://react.dev/docs
  - name: Go Stdlib
    url: https://pkg.go.dev
    path_prefix: /doc/
`
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}

		sf, err := ParseSourcesFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if sf == nil {
			t.Fatal("expected non-nil SourcesFile")
		}
		if len(sf.Sources) != 2 {
			t.Fatalf("got %d sources, want 2", len(sf.Sources))
		}
		if sf.Sources[0].Name != "React" {
			t.Errorf("sources[0].Name = %q, want React", sf.Sources[0].Name)
		}
		if sf.Sources[1].PathPrefix != "/doc/" {
			t.Errorf("sources[1].PathPrefix = %q, want /doc/", sf.Sources[1].PathPrefix)
		}
	})

	t.Run("file does not exist returns nil nil", func(t *testing.T) {
		t.Parallel()
		sf, err := ParseSourcesFile("/nonexistent/path/sources.yaml")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if sf != nil {
			t.Fatal("expected nil SourcesFile for nonexistent file")
		}
	})

	t.Run("invalid YAML returns error", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		path := filepath.Join(dir, "sources.yaml")
		if err := os.WriteFile(path, []byte("{{{{not yaml"), 0o644); err != nil {
			t.Fatal(err)
		}

		_, err := ParseSourcesFile(path)
		if err == nil {
			t.Fatal("expected error for invalid YAML")
		}
	})
}

func TestSourceURLMap(t *testing.T) {
	t.Parallel()

	t.Run("multiple sources", func(t *testing.T) {
		t.Parallel()
		sources := []CustomSource{
			{Name: "React", URL: "https://react.dev/docs"},
			{Name: "Go", URL: "https://pkg.go.dev"},
		}
		m := SourceURLMap(sources)
		if len(m) != 2 {
			t.Fatalf("got %d entries, want 2", len(m))
		}
		if m["https://react.dev/docs"] != "React" {
			t.Errorf("map[react.dev] = %q, want React", m["https://react.dev/docs"])
		}
		if m["https://pkg.go.dev"] != "Go" {
			t.Errorf("map[pkg.go.dev] = %q, want Go", m["https://pkg.go.dev"])
		}
	})

	t.Run("empty sources", func(t *testing.T) {
		t.Parallel()
		m := SourceURLMap(nil)
		if len(m) != 0 {
			t.Fatalf("got %d entries, want 0", len(m))
		}
	})
}

func TestHarvestSources_Empty(t *testing.T) {
	t.Parallel()

	// Empty sources should return zero result immediately without needing store/embedder.
	result, err := HarvestSources(context.TODO(), nil, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Applied != 0 || result.Unchanged != 0 || result.Embedded != 0 {
		t.Errorf("HarvestSources(nil sources) = %+v, want zero result", result)
	}
}
