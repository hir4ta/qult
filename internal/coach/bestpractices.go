package coach

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	bestPracticesURL = "https://code.claude.com/docs/en/best-practices"
	cacheTTL         = 1 * time.Hour
	fetchTimeout     = 10 * time.Second
)

var (
	bpCache   string
	bpFetched time.Time
	bpMu      sync.Mutex
)

// FetchBestPractices returns the latest Claude Code best practices from official docs.
// Results are cached for 1 hour to avoid excessive requests.
func FetchBestPractices() (string, error) {
	bpMu.Lock()
	defer bpMu.Unlock()

	if bpCache != "" && time.Since(bpFetched) < cacheTTL {
		return bpCache, nil
	}

	client := &http.Client{Timeout: fetchTimeout}
	resp, err := client.Get(bestPracticesURL)
	if err != nil {
		if bpCache != "" {
			return bpCache, nil // return stale cache on error
		}
		return "", fmt.Errorf("fetch best practices: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if bpCache != "" {
			return bpCache, nil
		}
		return "", fmt.Errorf("fetch best practices: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		if bpCache != "" {
			return bpCache, nil
		}
		return "", fmt.Errorf("read best practices: %w", err)
	}

	text := stripHTML(string(body))
	text = collapseWhitespace(text)

	// Truncate to keep prompt size reasonable
	if len(text) > 8000 {
		text = text[:8000]
	}

	bpCache = text
	bpFetched = time.Now()
	return text, nil
}

var htmlTagRe = regexp.MustCompile(`<[^>]*>`)

func stripHTML(s string) string {
	// Remove script and style blocks
	s = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`).ReplaceAllString(s, "")
	s = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`).ReplaceAllString(s, "")
	// Remove HTML tags
	s = htmlTagRe.ReplaceAllString(s, " ")
	// Decode common entities
	r := strings.NewReplacer(
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
		"&nbsp;", " ",
	)
	return r.Replace(s)
}

func collapseWhitespace(s string) string {
	// Collapse multiple blank lines into one
	s = regexp.MustCompile(`\n{3,}`).ReplaceAllString(s, "\n\n")
	// Trim lines
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
