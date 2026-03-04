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
func discoverURLs(src CustomSource) ([]string, string) {
	parsed, err := url.Parse(src.URL)
	if err != nil {
		return nil, ""
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
