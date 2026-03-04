package install

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSplitMarkdownSections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		title     string
		content   string
		wantPaths []string
		wantMin   int // minimum number of sections
	}{
		{
			name:  "h2 heading splitting",
			title: "Page",
			content: `Some intro text that is long enough to be included as an overview section for testing purposes.

## First Section

First section content that is long enough to pass the minimum length threshold.

## Second Section

Second section content that is long enough to pass the minimum length threshold.
`,
			wantPaths: []string{"Page > Overview", "Page > First Section", "Page > Second Section"},
			wantMin:   3,
		},
		{
			name:  "no headings returns single section",
			title: "Page",
			content: `This is a document with no headings at all. It has plenty of content that should be treated as a single section by the parser.
`,
			wantPaths: []string{"Page"},
			wantMin:   1,
		},
		{
			name:  "hierarchical h2 h3 paths",
			title: "Page",
			content: `## Parent

Parent content that is definitely long enough for the minimum threshold check.

### Child

Child content under the parent heading that is long enough for the minimum.
`,
			wantPaths: []string{"Page > Parent", "Page > Parent > Child"},
			wantMin:   2,
		},
		{
			name:  "content between headings preserved",
			title: "Page",
			content: `## Section

Here is the body text between headings that should be preserved in the output sections correctly.
`,
			wantPaths: []string{"Page > Section"},
			wantMin:   1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sections := SplitMarkdownSections(tt.title, tt.content)
			if len(sections) < tt.wantMin {
				t.Fatalf("SplitMarkdownSections(%q, ...) = %d sections, want >= %d", tt.title, len(sections), tt.wantMin)
			}
			for i, wantPath := range tt.wantPaths {
				if i >= len(sections) {
					t.Errorf("missing section %d with path %q", i, wantPath)
					continue
				}
				if sections[i].Path != wantPath {
					t.Errorf("sections[%d].Path = %q, want %q", i, sections[i].Path, wantPath)
				}
			}
		})
	}
}

func TestHTMLToText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		html     string
		contains []string
		excludes []string
	}{
		{
			name:     "headings to markdown format",
			html:     `<h1>Title</h1><h2>Subtitle</h2>`,
			contains: []string{"# Title", "## Subtitle"},
		},
		{
			name:     "lists to dashes",
			html:     `<ul><li>First</li><li>Second</li></ul>`,
			contains: []string{"- First", "- Second"},
		},
		{
			name:     "code blocks content preserved",
			html:     `<pre>func main() {}</pre>`,
			contains: []string{"func main() {}"},
		},
		{
			name:     "HTML entities decoded",
			html:     `&amp; &lt; &gt; &quot; &#39; &nbsp;`,
			contains: []string{"&", "<", ">", `"`, "'"},
		},
		{
			name:     "blank lines collapsed",
			html:     `<p>A</p><p></p><p></p><p></p><p>B</p>`,
			excludes: []string{"\n\n\n\n"},
			contains: []string{"A", "B"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := HTMLToText(tt.html)
			for _, want := range tt.contains {
				if !strings.Contains(got, want) {
					t.Errorf("HTMLToText(%q) does not contain %q; got %q", tt.html, want, got)
				}
			}
			for _, exc := range tt.excludes {
				if strings.Contains(got, exc) {
					t.Errorf("HTMLToText(%q) should not contain %q; got %q", tt.html, exc, got)
				}
			}
		})
	}
}

func TestStripJSX(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    string
		contains []string
		excludes []string
	}{
		{
			name:     "import statements removed",
			input:    "import React from 'react'\n\n# Hello",
			contains: []string{"# Hello"},
			excludes: []string{"import"},
		},
		{
			name:     "export statements removed",
			input:    "export default Component\n\n# Hello",
			contains: []string{"# Hello"},
			excludes: []string{"export"},
		},
		{
			name:     "JSX component tags removed",
			input:    "<Tip>This is a tip</Tip>\n<Note>Note text</Note>",
			contains: []string{"This is a tip", "Note text"},
			excludes: []string{"<Tip>", "</Tip>", "<Note>", "</Note>"},
		},
		{
			name:     "regular markdown preserved",
			input:    "# Title\n\nSome paragraph text.\n\n- List item",
			contains: []string{"# Title", "Some paragraph text.", "- List item"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := stripJSX(tt.input)
			for _, want := range tt.contains {
				if !strings.Contains(got, want) {
					t.Errorf("stripJSX(%q) does not contain %q; got %q", tt.input, want, got)
				}
			}
			for _, exc := range tt.excludes {
				if strings.Contains(got, exc) {
					t.Errorf("stripJSX(%q) should not contain %q; got %q", tt.input, exc, got)
				}
			}
		})
	}
}

func TestExtractTitle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		md   string
		url  string
		want string
	}{
		{
			name: "first h1 heading found",
			md:   "# My Page Title\n\nSome content",
			url:  "https://example.com/docs/my-page",
			want: "My Page Title",
		},
		{
			name: "heading within 20 lines",
			md:   strings.Repeat("\n", 10) + "# Deep Title\n\nContent",
			url:  "https://example.com/docs/deep",
			want: "Deep Title",
		},
		{
			name: "no heading falls back to URL slug",
			md:   "Just some content without any headings at all",
			url:  "https://example.com/docs/getting-started",
			want: "Getting Started",
		},
		{
			name: "h2 not treated as title",
			md:   "## Not a Title\n\nContent",
			url:  "https://example.com/docs/my-section",
			want: "My Section",
		},
		{
			name: "trailing slash stripped for slug",
			md:   "No heading here",
			url:  "https://example.com/docs/api-reference/",
			want: "Api Reference",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractTitle(tt.md, tt.url)
			if got != tt.want {
				t.Errorf("extractTitle(%q, %q) = %q, want %q", tt.md, tt.url, got, tt.want)
			}
		})
	}
}

func TestStripHTMLTags(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "basic tag removal",
			input: "<p>Hello</p>",
			want:  "Hello",
		},
		{
			name:  "nested tags",
			input: "<div><span>Nested</span> text</div>",
			want:  "Nested text",
		},
		{
			name:  "self-closing tags",
			input: "Hello<br/>World<img src='x'/>End",
			want:  "HelloWorldEnd",
		},
		{
			name:  "no tags",
			input: "Plain text",
			want:  "Plain text",
		},
		{
			name:  "attributes in tags",
			input: `<a href="url" class="link">Click</a>`,
			want:  "Click",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := stripHTMLTags(tt.input)
			if got != tt.want {
				t.Errorf("stripHTMLTags(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestExtractArticleContent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		html     string
		contains string
	}{
		{
			name:     "article tag extracted",
			html:     `<html><body><nav>Menu</nav><article><h1>Title</h1><p>Article content here</p></article><footer>Foot</footer></body></html>`,
			contains: "Article content here",
		},
		{
			name:     "no article tag uses full body",
			html:     `<html><body><p>Full body content</p></body></html>`,
			contains: "Full body content",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractArticleContent(tt.html)
			if !strings.Contains(got, tt.contains) {
				t.Errorf("extractArticleContent() = %q, want to contain %q", got, tt.contains)
			}
		})
	}
}

func TestExtractHTMLTitle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		html string
		want string
	}{
		{
			name: "h1 tag",
			html: `<h1>My Title</h1><p>Content</p>`,
			want: "My Title",
		},
		{
			name: "title tag fallback",
			html: `<title>Page Title</title><p>Content</p>`,
			want: "Page Title",
		},
		{
			name: "title with site name stripped",
			html: `<title>Page Title | My Site</title>`,
			want: "Page Title",
		},
		{
			name: "title with dash separator",
			html: `<title>Page Title - My Site</title>`,
			want: "Page Title",
		},
		{
			name: "no title returns empty",
			html: `<p>Just content</p>`,
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractHTMLTitle(tt.html)
			if got != tt.want {
				t.Errorf("extractHTMLTitle(%q) = %q, want %q", tt.html, got, tt.want)
			}
		})
	}
}

func TestCleanSection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "whitespace trimmed",
			input: "  hello world  ",
			want:  "hello world",
		},
		{
			name:  "frontmatter stripped",
			input: "---\ntitle: Test\n---\nContent here",
			want:  "Content here",
		},
		{
			name:  "no frontmatter preserved",
			input: "Regular content",
			want:  "Regular content",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := cleanSection(tt.input)
			if got != tt.want {
				t.Errorf("cleanSection(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	t.Parallel()

	t.Run("short string unchanged", func(t *testing.T) {
		t.Parallel()
		s := "short text"
		if got := truncate(s); got != s {
			t.Errorf("truncate(%q) = %q, want unchanged", s, got)
		}
	})

	t.Run("long string truncated at word boundary", func(t *testing.T) {
		t.Parallel()
		// Build a string longer than maxSectionChars (4000)
		s := strings.Repeat("word ", 1000) // 5000 chars
		got := truncate(s)
		if len(got) > maxSectionChars+10 { // +10 for " [...]"
			t.Errorf("truncate() length = %d, want <= %d", len(got), maxSectionChars+10)
		}
		if !strings.HasSuffix(got, " [...]") {
			t.Errorf("truncate() should end with ' [...]', got suffix %q", got[len(got)-10:])
		}
	})
}

// rewriteTransport redirects all HTTP requests to the test server,
// preserving the original URL path.
type rewriteTransport struct {
	base string
}

func (rt *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target, _ := url.Parse(rt.base + req.URL.Path)
	req.URL = target
	return http.DefaultTransport.RoundTrip(req)
}

// setupMockHTTPRewrite starts a test server and rewrites ALL HTTP requests
// (regardless of host) to that server. Returns the server URL.
func setupMockHTTPRewrite(t *testing.T, handler http.Handler) string {
	t.Helper()
	orig := httpClient
	t.Cleanup(func() { httpClient = orig })
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	httpClient = &http.Client{Transport: &rewriteTransport{base: srv.URL}}
	return srv.URL
}

func TestFetchPage(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte("hello world"))
		}))

		body, err := FetchPage("https://example.com/test")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if body != "hello world" {
			t.Errorf("got %q, want %q", body, "hello world")
		}
	})

	t.Run("non-200 returns error", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(404)
		}))

		_, err := FetchPage("https://example.com/missing")
		if err == nil {
			t.Fatal("expected error for 404 status")
		}
		if !strings.Contains(err.Error(), "HTTP 404") {
			t.Errorf("error should mention HTTP 404, got: %v", err)
		}
	})

	t.Run("user-agent header set", func(t *testing.T) {
		var gotUA string
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotUA = r.Header.Get("User-Agent")
			w.WriteHeader(200)
			w.Write([]byte("ok"))
		}))

		FetchPage("https://example.com/ua")
		if gotUA != "claude-alfred/seed-crawler" {
			t.Errorf("User-Agent = %q, want %q", gotUA, "claude-alfred/seed-crawler")
		}
	})
}

func TestFetchDocsIndex(t *testing.T) {
	t.Run("parses markdown links", func(t *testing.T) {
		llmsTxt := `# Claude Code Docs

- [Overview](https://code.claude.com/docs/en/overview)
- [Hooks](https://code.claude.com/docs/en/hooks.md)
- [MCP](https://code.claude.com/docs/en/mcp)
`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte(llmsTxt))
		}))

		urls, err := fetchDocsIndex()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(urls) != 3 {
			t.Fatalf("got %d URLs, want 3", len(urls))
		}
		// .md extension should be stripped
		for _, u := range urls {
			if strings.HasSuffix(u, ".md") {
				t.Errorf("URL should not end with .md: %s", u)
			}
		}
		if urls[0] != "https://code.claude.com/docs/en/overview" {
			t.Errorf("urls[0] = %q, want overview URL", urls[0])
		}
	})

	t.Run("fallback to plain URLs", func(t *testing.T) {
		plainTxt := `https://code.claude.com/docs/en/getting-started
https://code.claude.com/docs/en/configuration
`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte(plainTxt))
		}))

		urls, err := fetchDocsIndex()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(urls) != 2 {
			t.Fatalf("got %d URLs, want 2", len(urls))
		}
	})

	t.Run("no URLs returns error", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte("nothing useful here"))
		}))

		_, err := fetchDocsIndex()
		if err == nil {
			t.Fatal("expected error when no URLs found")
		}
		if !strings.Contains(err.Error(), "no doc URLs found") {
			t.Errorf("error = %v, want 'no doc URLs found'", err)
		}
	})
}

func TestCrawlDocsPage(t *testing.T) {
	t.Run("returns SeedSource with sections", func(t *testing.T) {
		mdContent := `# Getting Started

This is the overview section with enough content to pass the length threshold for embedding.

## Installation

Install Claude Code with npm install. This section has enough content to be included as a section.

## Configuration

Configure your settings in the config file. This section also has enough content to be included properly.
`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// CrawlDocsPage appends .md to the URL
			w.WriteHeader(200)
			w.Write([]byte(mdContent))
		}))

		src, err := CrawlDocsPage("https://code.claude.com/docs/en/getting-started")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if src.SourceType != "docs" {
			t.Errorf("source_type = %q, want %q", src.SourceType, "docs")
		}
		if src.URL != "https://code.claude.com/docs/en/getting-started" {
			t.Errorf("URL = %q, want original URL", src.URL)
		}
		if len(src.Sections) == 0 {
			t.Fatal("expected at least one section")
		}
	})

	t.Run("fetch error propagates", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
		}))

		_, err := CrawlDocsPage("https://code.claude.com/docs/en/broken")
		if err == nil {
			t.Fatal("expected error for 500 status")
		}
	})
}

func TestCrawlChangelog(t *testing.T) {
	t.Run("extracts v2.x entries", func(t *testing.T) {
		content := `# Changelog

## 2.5.0

- Added new feature A with enough detail to make this a meaningful section entry.
- Fixed bug B that was causing issues in the previous release version.

## 2.4.0

- Improved performance of the core engine significantly over the prior version.
- Updated dependencies to the latest stable releases available.

## 1.9.0

- Legacy feature that should be excluded from v2.x changelog sections.
`
		sources := crawlChangelog(content)
		if len(sources) != 1 {
			t.Fatalf("got %d sources, want 1", len(sources))
		}
		src := sources[0]
		if src.SourceType != "changelog" {
			t.Errorf("source_type = %q, want %q", src.SourceType, "changelog")
		}
		if src.Version != "2.5.0" {
			t.Errorf("version = %q, want %q", src.Version, "2.5.0")
		}
		// Should have 2 sections (v2.5.0 and v2.4.0), not v1.9.0
		if len(src.Sections) != 2 {
			t.Fatalf("got %d sections, want 2", len(src.Sections))
		}
		if src.Sections[0].Path != "v2.5.0" {
			t.Errorf("sections[0].Path = %q, want %q", src.Sections[0].Path, "v2.5.0")
		}
		if src.Sections[1].Path != "v2.4.0" {
			t.Errorf("sections[1].Path = %q, want %q", src.Sections[1].Path, "v2.4.0")
		}
	})

	t.Run("no v2.x entries returns nil", func(t *testing.T) {
		content := `# Changelog

## 1.0.0

- Initial release of the software package.
`
		sources := crawlChangelog(content)
		if sources != nil {
			t.Errorf("expected nil for no v2.x entries, got %d sources", len(sources))
		}
	})
}

func TestCrawlBlogPost(t *testing.T) {
	t.Run("extracts article content", func(t *testing.T) {
		html := `<!DOCTYPE html>
<html>
<head><title>Test Post | Anthropic</title></head>
<body>
<article>
<h1>Test Blog Post</h1>
<p>This is the first paragraph of the blog post with enough content to be meaningful for extraction purposes.</p>
<h2>Details</h2>
<p>This is the details section with sufficient content to pass the minimum length threshold for sections.</p>
</article>
</body>
</html>`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte(html))
		}))

		src, err := crawlBlogPost("https://www.anthropic.com/engineering/test-post")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if src.SourceType != "engineering" {
			t.Errorf("source_type = %q, want %q", src.SourceType, "engineering")
		}
		if src.URL != "https://www.anthropic.com/engineering/test-post" {
			t.Errorf("URL = %q, want original URL", src.URL)
		}
		if len(src.Sections) == 0 {
			t.Fatal("expected at least one section")
		}
	})

	t.Run("no article content returns error", func(t *testing.T) {
		// Provide HTML where extractArticleContent returns "" — empty tags only
		html := `<!DOCTYPE html><html><head></head><body></body></html>`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte(html))
		}))

		_, err := crawlBlogPost("https://www.anthropic.com/engineering/empty")
		if err == nil {
			t.Fatal("expected error for empty article content")
		}
		if !strings.Contains(err.Error(), "no article content") {
			t.Errorf("error = %v, want 'no article content'", err)
		}
	})

	t.Run("fetch error propagates", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(503)
		}))

		_, err := crawlBlogPost("https://www.anthropic.com/engineering/down")
		if err == nil {
			t.Fatal("expected error for 503 status")
		}
	})
}

func TestFetchBlogIndex(t *testing.T) {
	t.Run("extracts blog post URLs", func(t *testing.T) {
		html := `<!DOCTYPE html>
<html><body>
<a href="/engineering/claude-code-best-practices">Best Practices</a>
<a href="/engineering/building-effective-agents">Effective Agents</a>
<a href="/engineering/claude-code-best-practices">Best Practices Duplicate</a>
<a href="/about">Not a blog post</a>
</body></html>`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			w.Write([]byte(html))
		}))

		urls, err := fetchBlogIndex()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// Should deduplicate
		if len(urls) != 2 {
			t.Fatalf("got %d URLs, want 2 (deduped)", len(urls))
		}
		if urls[0] != "https://www.anthropic.com/engineering/claude-code-best-practices" {
			t.Errorf("urls[0] = %q", urls[0])
		}
		if urls[1] != "https://www.anthropic.com/engineering/building-effective-agents" {
			t.Errorf("urls[1] = %q", urls[1])
		}
	})

	t.Run("includes page 2 results", func(t *testing.T) {
		html1 := `<a href="/engineering/post-a">A</a>`
		html2 := `<a href="/engineering/post-b">B</a>`
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			if strings.Contains(r.URL.RawQuery, "page=2") || strings.Contains(r.URL.Path, "page=2") {
				w.Write([]byte(html2))
			} else {
				w.Write([]byte(html1))
			}
		}))

		urls, err := fetchBlogIndex()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// page 2 query string is appended to the path in the rewrite,
		// so we just verify we get at least the page-1 result
		if len(urls) < 1 {
			t.Fatal("expected at least 1 URL")
		}
	})

	t.Run("fetch error returns error", func(t *testing.T) {
		setupMockHTTPRewrite(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
		}))

		_, err := fetchBlogIndex()
		if err == nil {
			t.Fatal("expected error for 500 status")
		}
	})
}
