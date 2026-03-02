package install

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	docsIndexURL    = "https://code.claude.com/docs/llms.txt"
	changelogURL    = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"
	engineeringURL  = "https://www.anthropic.com/engineering"
	fetchTimeout    = 30 * time.Second
	maxSectionChars = 4000 // truncate very long sections for effective embedding
)

var httpClient = &http.Client{Timeout: fetchTimeout}

// CrawlSeed fetches all documentation sources and writes a seed JSON file.
func CrawlSeed(outputPath string) error {
	sf := &SeedFile{
		CrawledAt: time.Now().UTC().Format(time.RFC3339),
	}

	// 1. Fetch and crawl Claude Code docs.
	fmt.Println("Fetching docs index from llms.txt...")
	urls, err := fetchDocsIndex()
	if err != nil {
		return fmt.Errorf("fetch docs index: %w", err)
	}
	fmt.Printf("Found %d documentation pages\n", len(urls))

	var docsOK, docsFail int
	for i, pageURL := range urls {
		fmt.Printf("\r  Crawling docs [%d/%d]", i+1, len(urls))
		src, err := crawlDocsPage(pageURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "\n  Warning: %s: %v\n", pageURL, err)
			docsFail++
			continue
		}
		if len(src.Sections) > 0 {
			sf.Sources = append(sf.Sources, *src)
			docsOK++
		}
	}
	fmt.Printf("\r  Docs: %d OK, %d failed\n", docsOK, docsFail)

	// 2. Fetch changelog (v2.x only).
	fmt.Println("Fetching changelog...")
	body, err := fetchPage(changelogURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  Warning: changelog fetch failed: %v\n", err)
	} else {
		clSources := crawlChangelog(body)
		sf.Sources = append(sf.Sources, clSources...)
		totalVersions := 0
		for _, s := range clSources {
			totalVersions += len(s.Sections)
		}
		fmt.Printf("  Changelog: %d versions extracted\n", totalVersions)
	}

	// 3. Fetch engineering blog posts.
	fmt.Println("Fetching engineering blog index...")
	blogURLs, err := fetchBlogIndex()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  Warning: blog index fetch failed: %v\n", err)
	} else {
		fmt.Printf("Found %d blog posts\n", len(blogURLs))
		var blogOK, blogFail int
		for i, blogURL := range blogURLs {
			fmt.Printf("\r  Crawling blog [%d/%d]", i+1, len(blogURLs))
			src, err := crawlBlogPost(blogURL)
			if err != nil {
				fmt.Fprintf(os.Stderr, "\n  Warning: %s: %v\n", blogURL, err)
				blogFail++
				continue
			}
			if len(src.Sections) > 0 {
				sf.Sources = append(sf.Sources, *src)
				blogOK++
			}
		}
		fmt.Printf("\r  Blog: %d OK, %d failed\n", blogOK, blogFail)
	}

	// 4. Write output.
	totalSections := 0
	for _, src := range sf.Sources {
		totalSections += len(src.Sections)
	}

	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal seed: %w", err)
	}
	data = append(data, '\n')

	if err := os.WriteFile(outputPath, data, 0o644); err != nil {
		return fmt.Errorf("write seed file: %w", err)
	}

	fmt.Printf("\n✓ Seed data written to %s (%d sources, %d sections, %.1f KB)\n",
		outputPath, len(sf.Sources), totalSections, float64(len(data))/1024)

	if docsFail > len(urls)/5 {
		return fmt.Errorf("too many doc failures (%d/%d); check network or site structure", docsFail, len(urls))
	}
	return nil
}

// FetchAndParseChangelog fetches the Claude Code changelog with the given
// timeout and parses it into seed sources. Used by auto-harvest in SessionStart.
func FetchAndParseChangelog(timeout time.Duration) ([]SeedSource, error) {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest("GET", changelogURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "claude-alfred/auto-harvest")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return crawlChangelog(string(body)), nil
}

// fetchPage performs an HTTP GET and returns the response body as a string.
func fetchPage(url string) (string, error) {
	req, err := http.NewRequest("GET", url, nil)
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

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// --- Docs ---

// fetchDocsIndex reads llms.txt and extracts documentation page URLs.
func fetchDocsIndex() ([]string, error) {
	body, err := fetchPage(docsIndexURL)
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

// crawlDocsPage fetches a docs page and splits into sections.
func crawlDocsPage(url string) (*SeedSource, error) {
	// Fetch the .md version which returns raw markdown.
	mdURL := url
	if !strings.HasSuffix(mdURL, ".md") {
		mdURL += ".md"
	}

	body, err := fetchPage(mdURL)
	if err != nil {
		return nil, err
	}

	// Extract page title from first # heading or URL slug.
	title := extractTitle(body, url)

	// Strip MDX/JSX components.
	cleaned := stripJSX(body)

	sections := splitMarkdownSections(title, cleaned)
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
	body, err := fetchPage(engineeringURL)
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
	body2, err := fetchPage(engineeringURL + "?page=2")
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
	body, err := fetchPage(url)
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

	sections := splitMarkdownSections(title, content)
	return &SeedSource{
		URL:        url,
		SourceType: "engineering",
		Sections:   sections,
	}, nil
}

// --- Markdown Parsing Helpers ---

var (
	headingRe = regexp.MustCompile(`^(#{2,3})\s+(.+)`)
	jsxTagRe  = regexp.MustCompile(`</?(?:Tip|Note|Warning|Info|Frame|Steps|Step|Tabs|Tab|Accordion|AccordionGroup|Card|CardGroup|CodeGroup|ResponseField|ParamField|Expandable|Check|Icon|Snippet|Update)[^>]*>`)
)

// splitMarkdownSections splits markdown content by h2/h3 headings.
func splitMarkdownSections(pageTitle, content string) []SeedSection {
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
	// Remove import statements.
	importRe := regexp.MustCompile(`(?m)^import\s+.*$`)
	content = importRe.ReplaceAllString(content, "")
	// Remove export statements.
	exportRe := regexp.MustCompile(`(?m)^export\s+.*$`)
	content = exportRe.ReplaceAllString(content, "")
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
	return htmlToText(html)
}

// extractHTMLTitle extracts the title from HTML.
func extractHTMLTitle(html string) string {
	// Try <h1>.
	h1Re := regexp.MustCompile(`<h1[^>]*>(.*?)</h1>`)
	if m := h1Re.FindStringSubmatch(html); m != nil {
		return stripHTMLTags(m[1])
	}
	// Try <title>.
	titleRe := regexp.MustCompile(`<title[^>]*>(.*?)</title>`)
	if m := titleRe.FindStringSubmatch(html); m != nil {
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

// htmlToText converts HTML to readable plain text with markdown-style headings.
func htmlToText(html string) string {
	// Replace headings with markdown equivalents.
	for i := 3; i >= 1; i-- {
		prefix := strings.Repeat("#", i) + " "
		openTag := fmt.Sprintf(`<h%d[^>]*>`, i)
		closeTag := fmt.Sprintf(`</h%d>`, i)
		re := regexp.MustCompile(openTag + `(.*?)` + closeTag)
		html = re.ReplaceAllStringFunc(html, func(match string) string {
			inner := re.FindStringSubmatch(match)
			if len(inner) > 1 {
				return "\n" + prefix + stripHTMLTags(inner[1]) + "\n"
			}
			return match
		})
	}

	// Replace <p> with double newline.
	html = regexp.MustCompile(`</?p[^>]*>`).ReplaceAllString(html, "\n")
	// Replace <br> with newline.
	html = regexp.MustCompile(`<br\s*/?\s*>`).ReplaceAllString(html, "\n")
	// Replace <li> with bullet.
	html = regexp.MustCompile(`<li[^>]*>`).ReplaceAllString(html, "\n- ")
	html = strings.ReplaceAll(html, "</li>", "")
	// Replace <code> inline.
	html = regexp.MustCompile(`<code[^>]*>(.*?)</code>`).ReplaceAllString(html, "`$1`")
	// Replace <pre> blocks.
	html = regexp.MustCompile(`<pre[^>]*>`).ReplaceAllString(html, "\n```\n")
	html = strings.ReplaceAll(html, "</pre>", "\n```\n")
	// Strip remaining tags.
	html = stripHTMLTags(html)
	// Decode common HTML entities.
	html = strings.ReplaceAll(html, "&amp;", "&")
	html = strings.ReplaceAll(html, "&lt;", "<")
	html = strings.ReplaceAll(html, "&gt;", ">")
	html = strings.ReplaceAll(html, "&quot;", "\"")
	html = strings.ReplaceAll(html, "&#39;", "'")
	html = strings.ReplaceAll(html, "&nbsp;", " ")
	// Collapse multiple blank lines.
	multiBlank := regexp.MustCompile(`\n{3,}`)
	html = multiBlank.ReplaceAllString(html, "\n\n")

	return strings.TrimSpace(html)
}

// stripHTMLTags removes all HTML tags from a string.
func stripHTMLTags(s string) string {
	re := regexp.MustCompile(`<[^>]+>`)
	return strings.TrimSpace(re.ReplaceAllString(s, ""))
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
