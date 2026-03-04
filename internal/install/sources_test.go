package install

import (
	"fmt"
	"net/http"
	"net/http/httptest"
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

func TestFilterByPrefix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		urls   []string
		prefix string
		want   int
	}{
		{
			name:   "matching URLs retained",
			urls:   []string{"https://example.com/docs/a", "https://example.com/docs/b"},
			prefix: "/docs/",
			want:   2,
		},
		{
			name:   "non-matching filtered out",
			urls:   []string{"https://example.com/docs/a", "https://example.com/blog/b"},
			prefix: "/docs/",
			want:   1,
		},
		{
			name:   "unparseable URLs filtered out",
			urls:   []string{"://bad-url", "https://example.com/docs/a"},
			prefix: "/docs/",
			want:   1,
		},
		{
			name:   "empty input",
			urls:   nil,
			prefix: "/docs/",
			want:   0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := filterByPrefix(tt.urls, tt.prefix)
			if len(got) != tt.want {
				t.Errorf("filterByPrefix(%v, %q) = %d URLs, want %d", tt.urls, tt.prefix, len(got), tt.want)
			}
		})
	}
}

// setupMockHTTP replaces the package httpClient with a test server client.
// Returns the test server URL. Restores the original client on cleanup.
func setupMockHTTP(t *testing.T, handler http.Handler) string {
	t.Helper()
	orig := httpClient
	t.Cleanup(func() { httpClient = orig })

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	httpClient = srv.Client()
	return srv.URL
}

func TestDiscoverURLs(t *testing.T) {
	t.Run("llms.txt success", func(t *testing.T) {
		srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/docs/llms.txt" {
				fmt.Fprintf(w, "- [Intro](http://%s/docs/intro)\n- [API](http://%s/docs/api)\n", r.Host, r.Host)
				return
			}
			http.NotFound(w, r)
		}))

		src := CustomSource{Name: "Test", URL: srvURL + "/docs"}
		urls, method := discoverURLs(src)
		if method != "llms.txt" {
			t.Errorf("method = %q, want llms.txt", method)
		}
		if len(urls) != 2 {
			t.Fatalf("got %d URLs, want 2", len(urls))
		}
	})

	t.Run("llms.txt fail sitemap success", func(t *testing.T) {
		srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/sitemap.xml" {
				fmt.Fprintf(w, `<?xml version="1.0"?><urlset><url><loc>http://%s/docs/page1</loc></url></urlset>`, r.Host)
				return
			}
			http.NotFound(w, r)
		}))

		src := CustomSource{Name: "Test", URL: srvURL + "/docs"}
		urls, method := discoverURLs(src)
		if method != "sitemap" {
			t.Errorf("method = %q, want sitemap", method)
		}
		if len(urls) != 1 {
			t.Fatalf("got %d URLs, want 1", len(urls))
		}
	})

	t.Run("both fail single page fallback", func(t *testing.T) {
		srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		}))

		src := CustomSource{Name: "Test", URL: srvURL + "/docs"}
		urls, method := discoverURLs(src)
		if method != "single page" {
			t.Errorf("method = %q, want %q", method, "single page")
		}
		if len(urls) != 1 {
			t.Fatalf("got %d URLs, want 1", len(urls))
		}
		if urls[0] != srvURL+"/docs" {
			t.Errorf("urls[0] = %q, want %q", urls[0], srvURL+"/docs")
		}
	})
}

func TestCrawlCustomPage(t *testing.T) {
	t.Run("md URL preferred", func(t *testing.T) {
		srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/docs/page.md" {
				fmt.Fprint(w, "# Page Title\n\nThis is markdown content that should be long enough to produce at least one section.\n")
				return
			}
			http.NotFound(w, r)
		}))

		ss, err := crawlCustomPage(srvURL + "/docs/page")
		if err != nil {
			t.Fatal(err)
		}
		if ss.SourceType != "custom" {
			t.Errorf("SourceType = %q, want custom", ss.SourceType)
		}
		if len(ss.Sections) == 0 {
			t.Error("expected at least one section")
		}
	})

	t.Run("HTML fallback when md fails", func(t *testing.T) {
		srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/docs/page" {
				fmt.Fprint(w, "<html><body><h1>Page Title</h1><p>This is HTML content that should be long enough to produce sections.</p></body></html>")
				return
			}
			http.NotFound(w, r)
		}))

		ss, err := crawlCustomPage(srvURL + "/docs/page")
		if err != nil {
			t.Fatal(err)
		}
		if ss.SourceType != "custom" {
			t.Errorf("SourceType = %q, want custom", ss.SourceType)
		}
	})
}

func TestCrawlCustomSources(t *testing.T) {
	srvURL := setupMockHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/docs/llms.txt":
			fmt.Fprintf(w, "- [Page](http://%s/docs/page)\n", r.Host)
		case "/docs/page.md":
			fmt.Fprint(w, "# Test Page\n\nThis is test content that is long enough to produce at least one section in the output.\n")
		default:
			http.NotFound(w, r)
		}
	}))

	sources := []CustomSource{
		{Name: "TestLib", URL: srvURL + "/docs"},
	}

	result := CrawlCustomSources(sources, nil)
	if len(result) == 0 {
		t.Fatal("expected at least one SeedSource from CrawlCustomSources")
	}
	if result[0].SourceType != "custom" {
		t.Errorf("SourceType = %q, want custom", result[0].SourceType)
	}
}
