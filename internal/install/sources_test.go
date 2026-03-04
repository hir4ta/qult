package install

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseSourcesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sources.yaml")

	content := `sources:
  - name: Next.js
    url: https://nextjs.org/docs
  - name: Go
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
	if len(sf.Sources) != 2 {
		t.Fatalf("got %d sources, want 2", len(sf.Sources))
	}
	if sf.Sources[0].Name != "Next.js" {
		t.Errorf("sources[0].Name = %q, want Next.js", sf.Sources[0].Name)
	}
	if sf.Sources[0].URL != "https://nextjs.org/docs" {
		t.Errorf("sources[0].URL = %q, want https://nextjs.org/docs", sf.Sources[0].URL)
	}
	if sf.Sources[1].PathPrefix != "/doc/" {
		t.Errorf("sources[1].PathPrefix = %q, want /doc/", sf.Sources[1].PathPrefix)
	}
}

func TestParseSourcesFile_NotExist(t *testing.T) {
	sf, err := ParseSourcesFile("/nonexistent/sources.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if sf != nil {
		t.Fatal("expected nil for nonexistent file")
	}
}

func TestParseSourcesFile_Empty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sources.yaml")
	if err := os.WriteFile(path, []byte("sources: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	sf, err := ParseSourcesFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(sf.Sources) != 0 {
		t.Fatalf("got %d sources, want 0", len(sf.Sources))
	}
}

func TestParseLLMsTxt(t *testing.T) {
	body := `# Documentation

- [Getting Started](https://example.com/docs/getting-started)
- [API Reference](https://example.com/docs/api)
`
	urls := ParseLLMsTxt(body, "https://example.com")
	if len(urls) != 2 {
		t.Fatalf("got %d URLs, want 2", len(urls))
	}
	if urls[0] != "https://example.com/docs/getting-started" {
		t.Errorf("urls[0] = %q", urls[0])
	}
}

func TestParseLLMsTxt_PlainURLs(t *testing.T) {
	body := `https://example.com/docs/intro
https://example.com/docs/api
`
	urls := ParseLLMsTxt(body, "https://example.com")
	if len(urls) != 2 {
		t.Fatalf("got %d URLs, want 2", len(urls))
	}
}

func TestParseSitemap(t *testing.T) {
	xml := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs/intro</loc></url>
  <url><loc>https://example.com/docs/api</loc></url>
  <url><loc>https://example.com/blog/post1</loc></url>
</urlset>`
	urls := ParseSitemap(xml, "/docs/")
	if len(urls) != 2 {
		t.Fatalf("got %d URLs, want 2", len(urls))
	}
	if urls[0] != "https://example.com/docs/intro" {
		t.Errorf("urls[0] = %q", urls[0])
	}
}

func TestParseSitemap_NoFilter(t *testing.T) {
	xml := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`
	urls := ParseSitemap(xml, "")
	if len(urls) != 2 {
		t.Fatalf("got %d URLs, want 2", len(urls))
	}
}
