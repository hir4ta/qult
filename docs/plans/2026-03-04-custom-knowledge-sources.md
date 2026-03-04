# Custom Knowledge Sources Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ユーザーが `~/.claude-alfred/sources.yaml` に技術ドキュメント URL を登録し、`harvest` で自動クロール＋ナレッジ化できるようにする。

**Architecture:** sources.yaml パース → llms.txt 優先 / sitemap.xml フォールバックで URL 一覧取得 → 既存の Markdown 分割・HTML 変換で SeedSource 生成 → 既存の ApplySeedData で DB + embedding 格納。

**Tech Stack:** Go, YAML (gopkg.in/yaml.v3), 既存の install パッケージ

---

### Task 1: seed_fetch.go の関数を export

**Files:**
- Modify: `internal/install/seed_fetch.go`

**Step 1: 関数名を export 化**

以下の関数をリネーム（小文字 → 大文字開始）：

```go
// seed_fetch.go

// fetchPage → FetchPage (既存の Crawl 内からも使われるので呼び出し元も修正)
func FetchPage(url string) (string, error) {

// crawlDocsPage → CrawlDocsPage
func CrawlDocsPage(url string) (*SeedSource, error) {

// splitMarkdownSections → SplitMarkdownSections
func SplitMarkdownSections(pageTitle, content string) []SeedSection {

// extractTitle → ExtractTitle
func extractTitle(markdown, url string) string {  // これは内部のみなので据え置き

// htmlToText → HTMLToText
func HTMLToText(html string) string {
```

**Step 2: パッケージ内の呼び出し元を修正**

`seed_fetch.go` 内で `fetchPage` → `FetchPage` 等に修正（同一パッケージ内なので動作は変わらない）。

**Step 3: ビルド確認**

Run: `go build ./...`
Expected: SUCCESS

**Step 4: テスト確認**

Run: `go test ./internal/install/...`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/install/seed_fetch.go
git commit -m "refactor: seed_fetch の関数を export 化"
```

---

### Task 2: sources.yaml パース + カスタムクロール実装

**Files:**
- Create: `internal/install/sources.go`
- Create: `internal/install/sources_test.go`

**Step 1: テストを書く**

```go
// internal/install/sources_test.go
package install

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseSourcesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sources.yaml")

	yaml := `sources:
  - name: Next.js
    url: https://nextjs.org/docs
  - name: Go
    url: https://pkg.go.dev
    path_prefix: /doc/
`
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
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

func TestParseLLMsTxt(t *testing.T) {
	body := `# Documentation

- [Getting Started](https://example.com/docs/getting-started)
- [API Reference](https://example.com/docs/api)
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
}
```

**Step 2: テスト失敗確認**

Run: `go test ./internal/install/ -run "TestParseSources|TestParseLLMs|TestParseSitemap" -v`
Expected: FAIL (functions not defined)

**Step 3: 実装**

```go
// internal/install/sources.go
package install

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// SourcesFile is the top-level structure for user-defined documentation sources.
type SourcesFile struct {
	Sources []CustomSource `yaml:"sources"`
}

// CustomSource represents a user-defined documentation source.
type CustomSource struct {
	Name       string `yaml:"name"`
	URL        string `yaml:"url"`
	PathPrefix string `yaml:"path_prefix,omitempty"`
}

// ParseSourcesFile reads and parses a sources.yaml file.
// Returns nil, nil if the file does not exist.
func ParseSourcesFile(path string) (*SourcesFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read sources: %w", err)
	}

	var sf SourcesFile
	if err := yaml.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("parse sources: %w", err)
	}
	return &sf, nil
}

// DefaultSourcesPath returns ~/.claude-alfred/sources.yaml.
func DefaultSourcesPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return home + "/.claude-alfred/sources.yaml"
}

// CrawlCustomProgress provides callbacks for custom source crawl progress.
type CrawlCustomProgress struct {
	OnSource func(name string, done, total int)
	OnPage   func(done, total int)
}

// CrawlCustomSources crawls all user-defined sources and returns SeedSources.
func CrawlCustomSources(sources []CustomSource, progress *CrawlCustomProgress) []SeedSource {
	var result []SeedSource
	for i, src := range sources {
		if progress != nil && progress.OnSource != nil {
			progress.OnSource(src.Name, i+1, len(sources))
		}

		urls := discoverURLs(src)
		for j, pageURL := range urls {
			if progress != nil && progress.OnPage != nil {
				progress.OnPage(j+1, len(urls))
			}

			ss, err := crawlCustomPage(pageURL, src.Name)
			if err != nil {
				continue
			}
			if len(ss.Sections) > 0 {
				result = append(result, *ss)
			}
		}
	}
	return result
}

// discoverURLs tries llms.txt first, then sitemap.xml.
func discoverURLs(src CustomSource) []string {
	parsed, err := url.Parse(src.URL)
	if err != nil {
		return nil
	}

	// Try llms.txt at various locations.
	for _, llmsPath := range []string{
		src.URL + "/llms.txt",
		parsed.Scheme + "://" + parsed.Host + "/llms.txt",
	} {
		body, err := FetchPage(llmsPath)
		if err == nil && len(body) > 0 {
			urls := ParseLLMsTxt(body, parsed.Scheme+"://"+parsed.Host)
			if len(urls) > 0 {
				if src.PathPrefix != "" {
					urls = filterByPrefix(urls, src.PathPrefix)
				}
				return urls
			}
		}
	}

	// Fallback: sitemap.xml
	sitemapURL := parsed.Scheme + "://" + parsed.Host + "/sitemap.xml"
	body, err := FetchPage(sitemapURL)
	if err == nil {
		prefix := src.PathPrefix
		if prefix == "" {
			prefix = parsed.Path
		}
		urls := ParseSitemap(body, prefix)
		if len(urls) > 0 {
			return urls
		}
	}

	// Last resort: just the URL itself.
	return []string{src.URL}
}

var llmsTxtLinkRe = regexp.MustCompile(`\(?(https?://[^\s)]+)\)?`)

// ParseLLMsTxt extracts URLs from a llms.txt file.
func ParseLLMsTxt(body, baseURL string) []string {
	var urls []string
	seen := make(map[string]bool)
	for _, match := range llmsTxtLinkRe.FindAllStringSubmatch(body, -1) {
		u := strings.TrimRight(match[1], ")")
		if seen[u] {
			continue
		}
		seen[u] = true
		urls = append(urls, u)
	}

	// Also try plain URL lines.
	if len(urls) == 0 {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "http") && !seen[line] {
				seen[line] = true
				urls = append(urls, line)
			}
		}
	}
	return urls
}

var sitemapLocRe = regexp.MustCompile(`<loc>\s*(.*?)\s*</loc>`)

// ParseSitemap extracts URLs from sitemap XML, filtered by path prefix.
func ParseSitemap(xml, pathPrefix string) []string {
	var urls []string
	for _, match := range sitemapLocRe.FindAllStringSubmatch(xml, -1) {
		u := match[1]
		parsed, err := url.Parse(u)
		if err != nil {
			continue
		}
		if pathPrefix != "" && !strings.HasPrefix(parsed.Path, pathPrefix) {
			continue
		}
		urls = append(urls, u)
	}
	return urls
}

func filterByPrefix(urls []string, prefix string) []string {
	var out []string
	for _, u := range urls {
		parsed, err := url.Parse(u)
		if err != nil {
			continue
		}
		if strings.HasPrefix(parsed.Path, prefix) {
			out = append(out, u)
		}
	}
	return out
}

// crawlCustomPage fetches a page and splits into sections.
func crawlCustomPage(pageURL, sourceName string) (*SeedSource, error) {
	// Try .md version first.
	mdURL := pageURL
	if !strings.HasSuffix(mdURL, ".md") {
		mdURL += ".md"
	}
	body, err := FetchPage(mdURL)
	if err != nil {
		// Fall back to HTML.
		body, err = FetchPage(pageURL)
		if err != nil {
			return nil, err
		}
		// Convert HTML to text.
		body = HTMLToText(body)
	}

	title := extractTitle(body, pageURL)
	cleaned := stripJSX(body)
	sections := SplitMarkdownSections(title, cleaned)

	return &SeedSource{
		URL:        pageURL,
		SourceType: "custom",
		Sections:   sections,
	}, nil
}
```

**Step 4: go.mod に yaml 依存追加**

Run: `go get gopkg.in/yaml.v3`

**Step 5: テスト通過確認**

Run: `go test ./internal/install/ -run "TestParseSources|TestParseLLMs|TestParseSitemap" -v`
Expected: PASS

**Step 6: Commit**

```bash
git add internal/install/sources.go internal/install/sources_test.go go.mod go.sum
git commit -m "feat: カスタムナレッジソース sources.yaml パース + クロール実装"
```

---

### Task 3: harvest にカスタムソースを統合

**Files:**
- Modify: `cmd/alfred/harvest.go:266-292`
- Modify: `internal/install/seed_fetch.go` (Crawl 関数にカスタムソースを合流)

**Step 1: Crawl 関数にカスタムソースを統合**

`internal/install/seed_fetch.go` の `Crawl` 関数の末尾にカスタムソース追加：

```go
// Crawl の CrawlProgress に追加
type CrawlProgress struct {
	OnDocsPage     func(done, total int)
	OnBlogPost     func(done, total int)
	OnCustomSource func(name string, done, total int)
	OnCustomPage   func(done, total int)
}

// Crawl 関数の末尾（engineeringブログの後）に追加:

	// 4. Crawl custom sources.
	sf, err := ParseSourcesFile(DefaultSourcesPath())
	if err == nil && sf != nil && len(sf.Sources) > 0 {
		customSources := CrawlCustomSources(sf.Sources, &CrawlCustomProgress{
			OnSource: func(name string, done, total int) {
				if progress != nil && progress.OnCustomSource != nil {
					progress.OnCustomSource(name, done, total)
				}
			},
			OnPage: func(done, total int) {
				if progress != nil && progress.OnCustomPage != nil {
					progress.OnCustomPage(done, total)
				}
			},
		})
		result.Sources = append(result.Sources, customSources...)
	}
```

**Step 2: harvest TUI にカスタムソース進捗表示を追加**

`cmd/alfred/harvest.go` に以下を追加：

- メッセージ型: `crawlCustomMsg struct{ name string; done, total int }`
- harvestModel にフィールド: `customName string`, `customDone, customTotal int`
- View にカスタムソースの進捗行を追加
- runHarvest の Crawl コールバックにカスタム進捗を追加

**Step 3: ビルド確認**

Run: `go build -o alfred ./cmd/alfred`
Expected: SUCCESS

**Step 4: テスト確認**

Run: `go test ./...`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/install/seed_fetch.go cmd/alfred/harvest.go
git commit -m "feat: harvest にカスタムナレッジソースを統合"
```

---

### Task 4: 動作確認 + ビルド

**Step 1: テスト sources.yaml を作成**

```bash
mkdir -p ~/.claude-alfred
cat > ~/.claude-alfred/sources.yaml << 'EOF'
sources:
  - name: Next.js
    url: https://nextjs.org/docs
EOF
```

**Step 2: ビルド**

Run: `go build -o alfred ./cmd/alfred`

**Step 3: harvest 実行して動作確認**

Run: `./alfred harvest`
Expected: カスタムソースのクロール進捗が表示され、Next.js ドキュメントが DB に格納される

**Step 4: knowledge 検索で確認**

alfred serve 経由で knowledge ツールを呼び、Next.js 関連のクエリが結果に含まれることを確認

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: カスタムナレッジソース機能完成"
```
