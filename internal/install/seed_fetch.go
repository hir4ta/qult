package install

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

const (
	docsIndexURL    = "https://code.claude.com/docs/llms.txt"
	changelogURL    = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"
	engineeringURL  = "https://www.anthropic.com/engineering"
	fetchTimeout    = 30 * time.Second
	maxSectionChars = 4000 // truncate very long sections for effective embedding
)

var httpClient = &http.Client{Timeout: fetchTimeout}

// CrawlProgress provides callbacks for crawl progress reporting.
type CrawlProgress struct {
	OnDocsPage func(done, total int)
	OnBlogPost func(done, total int)
}

// CrawlStats tracks conditional fetch statistics.
type CrawlStats struct {
	Fetched    int // pages fetched (new or modified)
	NotModified int // pages skipped (304 Not Modified)
}

// Crawl fetches all documentation sources and returns the seed data.
// If st is non-nil, uses HTTP conditional requests (ETag/If-Modified-Since)
// to skip unchanged pages. Pass nil for a fresh crawl without conditionals.
func Crawl(ctx context.Context, progress *CrawlProgress, st *store.Store) (*SeedFile, *CrawlStats, error) {
	sf := &SeedFile{
		CrawledAt: time.Now().UTC().Format(time.RFC3339),
	}
	stats := &CrawlStats{}
	now := time.Now().UTC().Format(time.RFC3339)

	// 1. Fetch and crawl Claude Code docs.
	urls, err := fetchDocsIndex()
	if err != nil {
		return nil, nil, fmt.Errorf("fetch docs index: %w", err)
	}

	var docsFail int
	for i, pageURL := range urls {
		if progress != nil && progress.OnDocsPage != nil {
			progress.OnDocsPage(i+1, len(urls))
		}

		// CrawlDocsPage fetches the .md URL.
		mdURL := pageURL
		if !strings.HasSuffix(mdURL, ".md") {
			mdURL += ".md"
		}

		src, skipped, err := crawlPageConditional(ctx, st, pageURL, mdURL, "docs", now)
		if err != nil {
			docsFail++
			continue
		}
		if skipped {
			stats.NotModified++
			continue
		}
		stats.Fetched++
		if src != nil && len(src.Sections) > 0 {
			sf.Sources = append(sf.Sources, *src)
		}
	}

	// 2. Fetch changelog (v2.x only).
	clSrc, clSkipped, clErr := fetchConditional(ctx, st, changelogURL, now)
	if clErr == nil {
		if clSkipped {
			stats.NotModified++
		} else {
			stats.Fetched++
			clSources := crawlChangelog(clSrc)
			sf.Sources = append(sf.Sources, clSources...)
		}
	}

	// 3. Fetch engineering blog posts.
	blogURLs, err := fetchBlogIndex()
	if err == nil {
		for i, blogURL := range blogURLs {
			if progress != nil && progress.OnBlogPost != nil {
				progress.OnBlogPost(i+1, len(blogURLs))
			}

			src, skipped, err := crawlPageConditional(ctx, st, blogURL, blogURL, "engineering", now)
			if err != nil {
				continue
			}
			if skipped {
				stats.NotModified++
				continue
			}
			stats.Fetched++
			if src != nil && len(src.Sections) > 0 {
				sf.Sources = append(sf.Sources, *src)
			}
		}
	}

	if docsFail > len(urls)/5 {
		return sf, stats, fmt.Errorf("too many doc failures (%d/%d); check network or site structure", docsFail, len(urls))
	}
	return sf, stats, nil
}

// crawlPageConditional fetches a page with conditional requests when a store
// is available. Returns the parsed SeedSource, whether the page was skipped
// (304), and any error.
func crawlPageConditional(ctx context.Context, st *store.Store, canonicalURL, fetchURL, sourceType, now string) (*SeedSource, bool, error) {
	var etag, lastMod string
	if st != nil {
		if meta, err := st.GetCrawlMeta(ctx, canonicalURL); err == nil && meta != nil {
			etag = meta.ETag
			lastMod = meta.LastModified
		}
	}

	var body string
	if etag != "" || lastMod != "" {
		res, err := FetchPageConditionalCtx(ctx, fetchURL, etag, lastMod)
		if err != nil {
			return nil, false, err
		}
		if res.NotModified {
			// Update last_crawled_at even on 304.
			if st != nil {
				_ = st.UpsertCrawlMeta(ctx, &store.CrawlMeta{
					URL:           canonicalURL,
					ETag:          cond(res.ETag != "", res.ETag, etag),
					LastModified:  cond(res.LastModified != "", res.LastModified, lastMod),
					LastCrawledAt: now,
				})
			}
			return nil, true, nil
		}
		body = res.Body
		etag = res.ETag
		lastMod = res.LastModified
	} else {
		// No prior metadata — plain fetch, but capture response headers.
		res, err := FetchPageConditionalCtx(ctx, fetchURL, "", "")
		if err != nil {
			return nil, false, err
		}
		body = res.Body
		etag = res.ETag
		lastMod = res.LastModified
	}

	// Save metadata for next crawl.
	if st != nil {
		_ = st.UpsertCrawlMeta(ctx, &store.CrawlMeta{
			URL:           canonicalURL,
			ETag:          etag,
			LastModified:  lastMod,
			LastCrawledAt: now,
		})
	}

	// Parse based on source type.
	switch sourceType {
	case "docs":
		title := extractTitle(body, canonicalURL)
		cleaned := stripJSX(body)
		sections := SplitMarkdownSections(title, cleaned)
		return &SeedSource{
			URL:        canonicalURL,
			SourceType: "docs",
			Sections:   sections,
		}, false, nil
	case "engineering":
		content := extractArticleContent(body)
		if content == "" {
			return nil, false, fmt.Errorf("no article content found")
		}
		title := extractHTMLTitle(body)
		if title == "" {
			parts := strings.Split(canonicalURL, "/")
			title = parts[len(parts)-1]
		}
		sections := SplitMarkdownSections(title, content)
		return &SeedSource{
			URL:        canonicalURL,
			SourceType: "engineering",
			Sections:   sections,
		}, false, nil
	default:
		return nil, false, fmt.Errorf("unknown source type: %s", sourceType)
	}
}

// fetchConditional fetches a raw page body with conditional requests.
// Returns the body, whether the page was skipped (304), and any error.
func fetchConditional(ctx context.Context, st *store.Store, url, now string) (string, bool, error) {
	var etag, lastMod string
	if st != nil {
		if meta, err := st.GetCrawlMeta(ctx, url); err == nil && meta != nil {
			etag = meta.ETag
			lastMod = meta.LastModified
		}
	}

	res, err := FetchPageConditionalCtx(ctx, url, etag, lastMod)
	if err != nil {
		return "", false, err
	}
	if res.NotModified {
		if st != nil {
			_ = st.UpsertCrawlMeta(ctx, &store.CrawlMeta{
				URL:           url,
				ETag:          cond(res.ETag != "", res.ETag, etag),
				LastModified:  cond(res.LastModified != "", res.LastModified, lastMod),
				LastCrawledAt: now,
			})
		}
		return "", true, nil
	}

	if st != nil {
		_ = st.UpsertCrawlMeta(ctx, &store.CrawlMeta{
			URL:           url,
			ETag:          res.ETag,
			LastModified:  res.LastModified,
			LastCrawledAt: now,
		})
	}
	return res.Body, false, nil
}

// cond returns a if non-empty, otherwise b.
func cond(ok bool, a, b string) string {
	if ok {
		return a
	}
	return b
}

// CrawlSeed fetches all documentation sources and writes a seed JSON file.
func CrawlSeed(outputPath string) error {
	fmt.Println("Fetching docs index from llms.txt...")
	sf, _, err := Crawl(context.Background(), &CrawlProgress{
		OnDocsPage: func(done, total int) {
			fmt.Printf("\r  Crawling docs [%d/%d]", done, total)
		},
		OnBlogPost: func(done, total int) {
			fmt.Printf("\r  Crawling blog [%d/%d]", done, total)
		},
	}, nil)
	if sf == nil {
		return err
	}

	totalSections := 0
	for _, src := range sf.Sources {
		totalSections += len(src.Sections)
	}

	data, jsonErr := json.MarshalIndent(sf, "", "  ")
	if jsonErr != nil {
		return fmt.Errorf("marshal seed: %w", jsonErr)
	}
	data = append(data, '\n')

	if writeErr := os.WriteFile(outputPath, data, 0o644); writeErr != nil {
		return fmt.Errorf("write seed file: %w", writeErr)
	}

	fmt.Printf("\n✓ Seed data written to %s (%d sources, %d sections, %.1f KB)\n",
		outputPath, len(sf.Sources), totalSections, float64(len(data))/1024)

	return err // may contain crawl warning
}

// FetchPage performs an HTTP GET and returns the response body as a string.
func FetchPage(url string) (string, error) {
	return FetchPageCtx(context.Background(), url)
}

// FetchPageCtx performs an HTTP GET with context and returns the response body.
func FetchPageCtx(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "claude-alfred/seed-crawler")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	// Cap response size to 10 MB to prevent OOM from unexpected responses.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ConditionalResult holds the result of a conditional HTTP fetch.
type ConditionalResult struct {
	Body         string
	NotModified  bool
	ETag         string
	LastModified string
}

// FetchPageConditional performs an HTTP GET with conditional request headers.
// If etag or lastModified are non-empty, sets If-None-Match / If-Modified-Since.
// On 304 Not Modified, returns NotModified=true with an empty Body.
func FetchPageConditional(url, etag, lastModified string) (*ConditionalResult, error) {
	return FetchPageConditionalCtx(context.Background(), url, etag, lastModified)
}

// FetchPageConditionalCtx is like FetchPageConditional but accepts a context.
func FetchPageConditionalCtx(ctx context.Context, url, etag, lastModified string) (*ConditionalResult, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "claude-alfred/seed-crawler")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastModified != "" {
		req.Header.Set("If-Modified-Since", lastModified)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return &ConditionalResult{
			NotModified:  true,
			ETag:         resp.Header.Get("ETag"),
			LastModified: resp.Header.Get("Last-Modified"),
		}, nil
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	return &ConditionalResult{
		Body:         string(body),
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
	}, nil
}

// --- Docs ---

// fetchDocsIndex reads llms.txt and extracts documentation page URLs.
func fetchDocsIndex() ([]string, error) {
	body, err := FetchPage(docsIndexURL)
	if err != nil {
		return nil, err
	}

	var urls []string
	// llms.txt contains markdown links: - [Title](url)
	// or plain URLs, one per line.
	linkRe := regexp.MustCompile(`\(https://code\.claude\.com/docs/en/[^)]+\)`)
	for _, match := range linkRe.FindAllString(body, -1) {
		url := strings.Trim(match, "()")
		// Normalize: strip .md extension for the canonical URL
		url = strings.TrimSuffix(url, ".md")
		urls = append(urls, url)
	}

	// Fallback: try plain URL lines.
	if len(urls) == 0 {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "https://code.claude.com/docs/en/") {
				urls = append(urls, strings.TrimSuffix(line, ".md"))
			}
		}
	}

	if len(urls) == 0 {
		return nil, fmt.Errorf("no doc URLs found in llms.txt")
	}
	return urls, nil
}

// CrawlDocsPage fetches a docs page and splits into sections.
func CrawlDocsPage(url string) (*SeedSource, error) {
	// Fetch the .md version which returns raw markdown.
	mdURL := url
	if !strings.HasSuffix(mdURL, ".md") {
		mdURL += ".md"
	}

	body, err := FetchPage(mdURL)
	if err != nil {
		return nil, err
	}

	// Extract page title from first # heading or URL slug.
	title := extractTitle(body, url)

	// Strip MDX/JSX components.
	cleaned := stripJSX(body)

	sections := SplitMarkdownSections(title, cleaned)
	return &SeedSource{
		URL:        url,
		SourceType: "docs",
		Sections:   sections,
	}, nil
}

// --- Changelog ---

var changelogVersionRe = regexp.MustCompile(`^##\s+([\d.]+)`)

// crawlChangelog parses changelog markdown and extracts v2.x entries.
func crawlChangelog(content string) []SeedSource {
	cleaned := stripJSX(content)
	lines := strings.Split(cleaned, "\n")

	var sections []SeedSection
	var curVersion string
	var curContent strings.Builder
	latestVersion := ""

	for _, line := range lines {
		if m := changelogVersionRe.FindStringSubmatch(line); m != nil {
			// Flush previous version.
			if curVersion != "" && strings.HasPrefix(curVersion, "2.") {
				sections = append(sections, SeedSection{
					Path:    "v" + curVersion,
					Content: truncate(strings.TrimSpace(curContent.String())),
				})
			}
			curVersion = m[1]
			if latestVersion == "" {
				latestVersion = curVersion
			}
			curContent.Reset()
			continue
		}
		if curVersion != "" {
			curContent.WriteString(line)
			curContent.WriteByte('\n')
		}
	}
	// Flush last version.
	if curVersion != "" && strings.HasPrefix(curVersion, "2.") {
		sections = append(sections, SeedSection{
			Path:    "v" + curVersion,
			Content: truncate(strings.TrimSpace(curContent.String())),
		})
	}

	if len(sections) == 0 {
		return nil
	}
	return []SeedSource{{
		URL:        changelogURL,
		SourceType: "changelog",
		Version:    latestVersion,
		Sections:   sections,
	}}
}

// --- Engineering Blog ---

var blogLinkRe = regexp.MustCompile(`href="(/engineering/[a-z0-9-]+)"`)

// fetchBlogIndex fetches the engineering page and extracts blog post URLs.
func fetchBlogIndex() ([]string, error) {
	body, err := FetchPage(engineeringURL)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var urls []string
	for _, match := range blogLinkRe.FindAllStringSubmatch(body, -1) {
		path := match[1]
		if seen[path] {
			continue
		}
		seen[path] = true
		urls = append(urls, "https://www.anthropic.com"+path)
	}

	// Blog may have pagination; try page 2.
	body2, err := FetchPage(engineeringURL + "?page=2")
	if err == nil {
		for _, match := range blogLinkRe.FindAllStringSubmatch(body2, -1) {
			path := match[1]
			if seen[path] {
				continue
			}
			seen[path] = true
			urls = append(urls, "https://www.anthropic.com"+path)
		}
	}

	return urls, nil
}

// crawlBlogPost fetches a blog post and extracts article content as sections.
func crawlBlogPost(url string) (*SeedSource, error) {
	body, err := FetchPage(url)
	if err != nil {
		return nil, err
	}

	// Extract article content from HTML.
	content := extractArticleContent(body)
	if content == "" {
		return nil, fmt.Errorf("no article content found")
	}

	// Extract title from <h1> or <title>.
	title := extractHTMLTitle(body)
	if title == "" {
		// Use URL slug as fallback.
		parts := strings.Split(url, "/")
		title = parts[len(parts)-1]
	}

	sections := SplitMarkdownSections(title, content)
	return &SeedSource{
		URL:        url,
		SourceType: "engineering",
		Sections:   sections,
	}, nil
}

// --- Markdown Parsing Helpers ---

var (
	headingRe    = regexp.MustCompile(`^(#{2,3})\s+(.+)`)
	jsxTagRe     = regexp.MustCompile(`</?(?:Tip|Note|Warning|Info|Frame|Steps|Step|Tabs|Tab|Accordion|AccordionGroup|Card|CardGroup|CodeGroup|ResponseField|ParamField|Expandable|Check|Icon|Snippet|Update)[^>]*>`)
	importLineRe = regexp.MustCompile(`(?m)^import\s+.*$`)
	exportLineRe = regexp.MustCompile(`(?m)^export\s+.*$`)
	h1TagRe      = regexp.MustCompile(`<h1[^>]*>(.*?)</h1>`)
	titleTagRe   = regexp.MustCompile(`<title[^>]*>(.*?)</title>`)
	pTagRe       = regexp.MustCompile(`</?p[^>]*>`)
	brTagRe      = regexp.MustCompile(`<br\s*/?\s*>`)
	liTagRe      = regexp.MustCompile(`<li[^>]*>`)
	codeTagRe    = regexp.MustCompile(`<code[^>]*>(.*?)</code>`)
	preTagRe     = regexp.MustCompile(`<pre[^>]*>`)
	multiBlankRe = regexp.MustCompile(`\n{3,}`)
	htmlTagRe    = regexp.MustCompile(`<[^>]+>`)
)

// SplitMarkdownSections splits markdown content by h2/h3 headings.
func SplitMarkdownSections(pageTitle, content string) []SeedSection {
	lines := strings.Split(content, "\n")

	type heading struct {
		level int    // 2 or 3
		text  string
		line  int
	}

	var headings []heading
	for i, line := range lines {
		if m := headingRe.FindStringSubmatch(line); m != nil {
			headings = append(headings, heading{
				level: len(m[1]),
				text:  strings.TrimSpace(m[2]),
				line:  i,
			})
		}
	}

	// Build sections.
	var sections []SeedSection

	// Content before first heading.
	if len(headings) > 0 && headings[0].line > 0 {
		pre := joinLines(lines[:headings[0].line])
		pre = cleanSection(pre)
		if len(pre) > 50 {
			sections = append(sections, SeedSection{
				Path:    pageTitle + " > Overview",
				Content: truncate(pre),
			})
		}
	} else if len(headings) == 0 && len(content) > 50 {
		// No headings at all; treat entire content as one section.
		cleaned := cleanSection(content)
		if len(cleaned) > 50 {
			sections = append(sections, SeedSection{
				Path:    pageTitle,
				Content: truncate(cleaned),
			})
		}
	}

	// Each heading to next heading (or EOF).
	var curH2 string
	for i, h := range headings {
		endLine := len(lines)
		if i+1 < len(headings) {
			endLine = headings[i+1].line
		}

		bodyText := joinLines(lines[h.line+1 : endLine])
		bodyText = cleanSection(bodyText)

		if h.level == 2 {
			curH2 = h.text
		}

		var path string
		if h.level == 3 && curH2 != "" {
			path = pageTitle + " > " + curH2 + " > " + h.text
		} else {
			path = pageTitle + " > " + h.text
		}

		if len(bodyText) > 30 {
			sections = append(sections, SeedSection{
				Path:    path,
				Content: truncate(bodyText),
			})
		}
	}

	return sections
}

// extractTitle gets the page title from the first # heading or URL slug.
func extractTitle(markdown, url string) string {
	for _, line := range strings.SplitN(markdown, "\n", 20) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") && !strings.HasPrefix(line, "## ") {
			return strings.TrimPrefix(line, "# ")
		}
	}
	// Fallback: URL slug.
	parts := strings.Split(strings.TrimSuffix(url, "/"), "/")
	slug := parts[len(parts)-1]
	// Simple title-case: capitalize first letter of each word.
	words := strings.Split(slug, "-")
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// stripJSX removes MDX/JSX component tags from markdown content.
func stripJSX(content string) string {
	content = jsxTagRe.ReplaceAllString(content, "")
	content = importLineRe.ReplaceAllString(content, "")
	content = exportLineRe.ReplaceAllString(content, "")
	return content
}

// extractArticleContent extracts the main text content from HTML.
func extractArticleContent(html string) string {
	// Try to find <article> content first.
	articleStart := strings.Index(html, "<article")
	articleEnd := strings.LastIndex(html, "</article>")
	if articleStart >= 0 && articleEnd > articleStart {
		// Move past the opening tag.
		tagEnd := strings.Index(html[articleStart:], ">")
		if tagEnd >= 0 {
			html = html[articleStart+tagEnd+1 : articleEnd]
		}
	}

	// Strip all HTML tags and convert to plain text.
	return HTMLToText(html)
}

// extractHTMLTitle extracts the title from HTML.
func extractHTMLTitle(html string) string {
	// Try <h1>.
	if m := h1TagRe.FindStringSubmatch(html); m != nil {
		return stripHTMLTags(m[1])
	}
	// Try <title>.
	if m := titleTagRe.FindStringSubmatch(html); m != nil {
		title := stripHTMLTags(m[1])
		// Often includes site name: "Title | Site".
		if idx := strings.LastIndex(title, " | "); idx > 0 {
			return title[:idx]
		}
		if idx := strings.LastIndex(title, " - "); idx > 0 {
			return title[:idx]
		}
		return title
	}
	return ""
}

// htmlHeadingRes are pre-compiled regexps for h1-h3 heading replacement.
var htmlHeadingRes = [3]*regexp.Regexp{
	regexp.MustCompile(`<h1[^>]*>(.*?)</h1>`),
	regexp.MustCompile(`<h2[^>]*>(.*?)</h2>`),
	regexp.MustCompile(`<h3[^>]*>(.*?)</h3>`),
}

// HTMLToText converts HTML to readable plain text with markdown-style headings.
func HTMLToText(html string) string {
	// Replace headings with markdown equivalents.
	for i := 3; i >= 1; i-- {
		prefix := strings.Repeat("#", i) + " "
		re := htmlHeadingRes[i-1]
		html = re.ReplaceAllStringFunc(html, func(match string) string {
			inner := re.FindStringSubmatch(match)
			if len(inner) > 1 {
				return "\n" + prefix + stripHTMLTags(inner[1]) + "\n"
			}
			return match
		})
	}

	html = pTagRe.ReplaceAllString(html, "\n")
	html = brTagRe.ReplaceAllString(html, "\n")
	html = liTagRe.ReplaceAllString(html, "\n- ")
	html = strings.ReplaceAll(html, "</li>", "")
	html = codeTagRe.ReplaceAllString(html, "`$1`")
	html = preTagRe.ReplaceAllString(html, "\n```\n")
	html = strings.ReplaceAll(html, "</pre>", "\n```\n")
	html = stripHTMLTags(html)
	// Decode common HTML entities.
	html = strings.ReplaceAll(html, "&amp;", "&")
	html = strings.ReplaceAll(html, "&lt;", "<")
	html = strings.ReplaceAll(html, "&gt;", ">")
	html = strings.ReplaceAll(html, "&quot;", "\"")
	html = strings.ReplaceAll(html, "&#39;", "'")
	html = strings.ReplaceAll(html, "&nbsp;", " ")
	html = multiBlankRe.ReplaceAllString(html, "\n\n")

	return strings.TrimSpace(html)
}

// stripHTMLTags removes all HTML tags from a string.
func stripHTMLTags(s string) string {
	return strings.TrimSpace(htmlTagRe.ReplaceAllString(s, ""))
}

// joinLines joins a slice of lines into a single string.
func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}

// cleanSection strips whitespace and removes YAML frontmatter.
func cleanSection(s string) string {
	s = strings.TrimSpace(s)
	// Strip YAML frontmatter.
	if strings.HasPrefix(s, "---") {
		if idx := strings.Index(s[3:], "---"); idx >= 0 {
			s = strings.TrimSpace(s[idx+6:])
		}
	}
	return s
}

// truncate limits section content length for effective embedding.
func truncate(s string) string {
	if len(s) <= maxSectionChars {
		return s
	}
	// Truncate at last space before limit.
	cut := s[:maxSectionChars]
	if idx := strings.LastIndex(cut, " "); idx > maxSectionChars/2 {
		cut = cut[:idx]
	}
	return cut + " [...]"
}
