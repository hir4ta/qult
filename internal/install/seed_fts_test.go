package install

import (
	"fmt"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// TestSeedFTS_AllPages seeds all docs and verifies that every page is
// findable via FTS5 search using terms from its section path.
func TestSeedFTS_AllPages(t *testing.T) {
	t.Parallel()

	sf, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("LoadEmbedded: %v", err)
	}
	if len(sf.Sources) == 0 {
		t.Skip("empty seed (dev build)")
	}

	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	// Seed all docs.
	total := 0
	for _, src := range sf.Sources {
		for _, sec := range src.Sections {
			doc := &store.DocRow{
				URL:         src.URL,
				SectionPath: sec.Path,
				Content:     sec.Content,
				SourceType:  src.SourceType,
				Version:     src.Version,
				CrawledAt:   sf.CrawledAt,
				TTLDays:     365,
			}
			if _, _, err := st.UpsertDoc(doc); err != nil {
				t.Fatalf("UpsertDoc %q: %v", sec.Path, err)
			}
			total++
		}
	}
	t.Logf("Seeded %d docs from %d sources", total, len(sf.Sources))

	// Verify every page URL is findable by searching a keyword from its first section.
	for _, src := range sf.Sources {
		if len(src.Sections) == 0 {
			continue
		}
		// Extract first meaningful word from section path as search term.
		query := firstMeaningfulWord(src.Sections[0].Path)
		if query == "" {
			continue
		}
		results, err := st.SearchDocsFTS(query, "", 50)
		if err != nil {
			t.Errorf("FTS5 %q (url=%s): error=%v", query, src.URL, err)
			continue
		}
		if len(results) == 0 {
			t.Errorf("FTS5 %q (url=%s): 0 results, expected at least 1", query, src.URL)
		}
	}
}

// TestSeedFTS_ProblematicQueries tests real-world queries that contain
// unicode61 token separators (the original bug).
func TestSeedFTS_ProblematicQueries(t *testing.T) {
	t.Parallel()

	sf, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("LoadEmbedded: %v", err)
	}
	if len(sf.Sources) == 0 {
		t.Skip("empty seed (dev build)")
	}

	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	for _, src := range sf.Sources {
		for _, sec := range src.Sections {
			doc := &store.DocRow{
				URL:         src.URL,
				SectionPath: sec.Path,
				Content:     sec.Content,
				SourceType:  src.SourceType,
				Version:     src.Version,
				CrawledAt:   sf.CrawledAt,
				TTLDays:     365,
			}
			if _, _, err := st.UpsertDoc(doc); err != nil {
				t.Fatalf("UpsertDoc: %v", err)
			}
		}
	}

	// Queries that previously returned 0 results due to token separators.
	tests := []struct {
		name  string
		query string
	}{
		{"original bug", "custom agent .claude/agents markdown frontmatter allowed_tools model haiku sonnet opus"},
		{"dotfile path", ".claude/rules/next/structure.md"},
		{"underscore heavy", "pre_tool_use hook allowed_tools"},
		{"mixed separators", "claude-code settings.json hooks"},
		{"email-like", "user@example.com authentication"},
		{"url-like", "https://code.claude.com/docs subagent"},
		{"colon syntax", "column:value search FTS5"},
		{"parentheses", "func(ctx context.Context) handler"},
		{"curly braces", "config{hooks} settings"},
		{"asterisk plus", "glob* pattern+ matching"},
		{"japanese with separators", "フック設定.claude/hooks"},
		{"caret and tilde", "version^2 ~approximate"},
	}
	for _, tt := range tests {
		// No t.Parallel() — subtests share the store.
		results, err := st.SearchDocsFTS(tt.query, "", 10)
		if err != nil {
			t.Errorf("[%s] SearchDocsFTS(%q): unexpected error: %v", tt.name, tt.query, err)
			continue
		}
		if len(results) == 0 {
			sanitized := store.SanitizeFTS5Query(tt.query)
			t.Errorf("[%s] SearchDocsFTS(%q): 0 results (sanitized=%q)", tt.name, tt.query, sanitized)
		}
	}
}

// TestSeedFTS_SanitizeNeverCrashes verifies SanitizeFTS5Query handles
// all kinds of adversarial input without panicking.
func TestSeedFTS_SanitizeNeverCrashes(t *testing.T) {
	t.Parallel()

	inputs := []string{
		"",
		"   ",
		"AND OR NOT NEAR",
		"---",
		"...",
		"///",
		"___",
		`"""`,
		"((()))",
		"***",
		"+++",
		"^^^",
		":::",
		"{}{}{}",
		"@#~@#~",
		"\t\n\r",
		"\x00\x01\x02",
		"🎉🚀💻",
		"日本語のクエリ",
		"混合query with 日本語 and émojis 🎉",
		string(make([]byte, 10000)),
		"a",
		"  a  ",
		"AND a",
		"a AND",
	}
	for i, input := range inputs {
		t.Run(fmt.Sprintf("input_%d", i), func(t *testing.T) {
			t.Parallel()
			// Must not panic.
			result := store.SanitizeFTS5Query(input)
			_ = result
		})
	}
}

// TestSeedFTS_SanitizeThenMatchNeverErrors verifies that any sanitized
// query can be safely passed to FTS5 MATCH without SQL errors.
func TestSeedFTS_SanitizeThenMatchNeverErrors(t *testing.T) {
	t.Parallel()

	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	// Insert a doc so FTS table exists.
	doc := &store.DocRow{
		URL:         "https://example.com",
		SectionPath: "Test",
		Content:     "test content for FTS5 safety check",
		SourceType:  "docs",
		TTLDays:     365,
	}
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// Adversarial queries that might break FTS5 MATCH syntax.
	queries := []string{
		`"unclosed quote`,
		`") DROP TABLE docs; --`,
		`* OR *`,
		`NEAR("a", "b", 5)`,
		`{col1 col2}: term`,
		`column:`,
		`:value`,
		`a OR`,
		`OR b`,
		`NOT`,
		`a NOT b AND c OR d NEAR e`,
		`.claude/agents AND hooks OR "settings.json"`,
		`((nested (parens)))`,
		"hello\x00world",
		`前tool使用 AND フック`,
	}
	for _, q := range queries {
		// No t.Parallel() — subtests share the store.
		_, err := st.SearchDocsFTS(q, "", 5)
		if err != nil {
			t.Errorf("SearchDocsFTS(%q): unexpected error: %v", q, err)
		}
	}
}

// firstMeaningfulWord extracts the first word (>3 chars, not a stop word)
// from a section path like "Create custom subagents > Overview".
func firstMeaningfulWord(path string) string {
	stop := map[string]bool{
		"the": true, "and": true, "for": true, "with": true,
		"use": true, "how": true, "run": true, "set": true,
		"get": true, "add": true, "new": true, "all": true,
	}
	sanitized := store.SanitizeFTS5Query(path)
	for _, w := range splitWords(sanitized) {
		if len(w) > 3 && !stop[w] {
			return w
		}
	}
	return ""
}

func splitWords(s string) []string {
	var words []string
	for _, w := range split(s) {
		if w != "" {
			words = append(words, w)
		}
	}
	return words
}

func split(s string) []string {
	return append([]string{}, splitOn(s, ' ')...)
}

func splitOn(s string, sep byte) []string {
	var result []string
	start := 0
	for i := range len(s) {
		if s[i] == sep {
			if i > start {
				result = append(result, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		result = append(result, s[start:])
	}
	return result
}
