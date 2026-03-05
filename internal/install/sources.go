package install

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// SourcesFile is the top-level structure for user-defined documentation sources.
type SourcesFile struct {
	Sources []CustomSource `yaml:"sources"`
}

// CustomSource represents a user-defined documentation source.
type CustomSource struct {
	Name            string   `yaml:"name"`
	URL             string   `yaml:"url"`
	PathPrefix      string   `yaml:"path_prefix,omitempty"`
	MaxPages        int      `yaml:"max_pages,omitempty"`
	ExcludePatterns []string `yaml:"exclude_patterns,omitempty"`
}

// MaxPages is only applied when explicitly set in sources.yaml.

// excludeSegments are path segments that indicate non-documentation pages.
// A URL is excluded if any segment of its path exactly matches one of these.
var excludeSegments = []string{
	"changelog", "changelogs",
	"releases", "release-notes",
	"blog", "news",
	"pricing", "enterprise", "contact", "support",
	"playground", "dashboard", "login", "signup",
	"community", "discussions", "forum",
}

// excludePrefixes are path prefixes that indicate non-documentation content.
var excludePrefixes = []string{
	"/api/", // REST API endpoints (not docs about APIs)
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
	OnSource    func(name string, done, total int)
	OnPage      func(name string, done, total int)
	OnDiscovery func(name, method string, count int)
}

// CrawlCustomSources crawls all user-defined sources and returns SeedSources.
// Phase 1: discover URLs for all sources. Phase 2: crawl pages with cumulative progress.
func CrawlCustomSources(sources []CustomSource, progress *CrawlCustomProgress) []SeedSource {
	// Phase 1: Discover URLs for all sources.
	type sourceURLs struct {
		src    CustomSource
		urls   []string
		method string
	}
	discovered := make([]sourceURLs, 0, len(sources))
	totalPages := 0
	for i, src := range sources {
		if progress != nil && progress.OnSource != nil {
			progress.OnSource(src.Name, i+1, len(sources))
		}

		urls, method := discoverURLs(src)

		// Apply max_pages limit (only when explicitly set).
		if src.MaxPages > 0 && len(urls) > src.MaxPages {
			urls = urls[:src.MaxPages]
		}

		if progress != nil && progress.OnDiscovery != nil {
			progress.OnDiscovery(src.Name, method, len(urls))
		}
		discovered = append(discovered, sourceURLs{src, urls, method})
		totalPages += len(urls)
	}

	// Phase 2: Crawl pages with cumulative progress.
	var result []SeedSource
	crawled := 0
	for _, d := range discovered {
		for _, pageURL := range d.urls {
			crawled++
			if progress != nil && progress.OnPage != nil {
				progress.OnPage(d.src.Name, crawled, totalPages)
			}

			ss, err := crawlCustomPage(pageURL)
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
// Returns discovered URLs and the method used ("llms.txt", "sitemap", "single page").
// Applies same-domain filtering, built-in exclude patterns, and user exclude patterns.
func discoverURLs(src CustomSource) ([]string, string) {
	parsed, err := url.Parse(src.URL)
	if err != nil {
		return nil, ""
	}

	host := parsed.Host

	// Try llms.txt at various locations.
	for _, llmsPath := range []string{
		src.URL + "/llms.txt",
		parsed.Scheme + "://" + parsed.Host + "/llms.txt",
	} {
		body, err := FetchPage(llmsPath)
		if err == nil && len(body) > 0 {
			urls := ParseLLMsTxt(body, parsed.Scheme+"://"+parsed.Host)
			if len(urls) > 0 {
				urls = filterSameDomain(urls, host)
				if src.PathPrefix != "" {
					urls = filterByPrefix(urls, src.PathPrefix)
				}
				urls = filterExcludePatterns(urls, src.ExcludePatterns)
				return urls, "llms.txt"
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
			urls = filterExcludePatterns(urls, src.ExcludePatterns)
			return urls, "sitemap"
		}
	}

	// Last resort: just the URL itself.
	return []string{src.URL}, "single page"
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

// filterSameDomain keeps only URLs whose host matches the source host.
func filterSameDomain(urls []string, host string) []string {
	var out []string
	for _, u := range urls {
		parsed, err := url.Parse(u)
		if err != nil {
			continue
		}
		if parsed.Host == host {
			out = append(out, u)
		}
	}
	return out
}

// filterExcludePatterns removes URLs matching built-in or user-defined exclude patterns.
func filterExcludePatterns(urls []string, userPatterns []string) []string {
	var out []string
	for _, u := range urls {
		parsed, err := url.Parse(u)
		if err != nil {
			continue
		}
		if shouldExclude(parsed.Path, userPatterns) {
			continue
		}
		out = append(out, u)
	}
	return out
}

// shouldExclude returns true if the path matches any built-in or user exclude pattern.
func shouldExclude(path string, userPatterns []string) bool {
	// Check built-in segment exclusions.
	segments := strings.Split(strings.Trim(path, "/"), "/")
	for _, seg := range segments {
		lower := strings.ToLower(seg)
		for _, excl := range excludeSegments {
			if lower == excl {
				return true
			}
		}
	}
	// Check built-in prefix exclusions.
	for _, prefix := range excludePrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	// Check user-defined patterns.
	for _, pat := range userPatterns {
		if strings.Contains(path, pat) {
			return true
		}
	}
	return false
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
func crawlCustomPage(pageURL string) (*SeedSource, error) {
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
