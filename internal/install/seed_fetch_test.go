package install

import (
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
