package store

import (
	"testing"
)

func TestTranslateQuery(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"ascii passthrough", "hooks", "hooks"},
		{"katakana hook", "フック", "hook"},
		{"katakana skill", "スキル", "skill"},
		{"katakana agent", "エージェント", "agent"},
		{"katakana plugin", "プラグイン", "plugin"},
		{"kanji settings", "設定", "settings"},
		{"kanji permission", "権限", "permission"},
		{"mixed", "フックの設定", "hookのsettings"},
		{"no match japanese", "こんにちは", "こんにちは"},
		{"empty", "", ""},
		{"katakana memory", "メモリ", "memory"},
		{"katakana shortcut", "ショートカット", "shortcut"},
		{"katakana worktree", "ワークツリー", "worktree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := TranslateQuery(tt.input)
			if got != tt.want {
				t.Errorf("TranslateQuery(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestLevenshtein(t *testing.T) {
	t.Parallel()
	tests := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"abc", "", 3},
		{"", "abc", 3},
		{"hook", "hook", 0},
		{"hoks", "hooks", 1},
		{"skilss", "skills", 1},
		{"permisions", "permissions", 1},
		{"configration", "configuration", 1},
		{"subagnet", "subagent", 2},
		{"cat", "dog", 3},
	}
	for _, tt := range tests {
		t.Run(tt.a+"_"+tt.b, func(t *testing.T) {
			t.Parallel()
			got := levenshtein(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("levenshtein(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestCorrectTypos(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Seed docs with section_paths containing important terms.
	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "Hooks reference > Hook events", Content: "hooks content", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "Skills > Configure skills", Content: "skills content", SourceType: "docs"},
		{URL: "https://a.com/3", SectionPath: "Configure permissions > Rule syntax", Content: "permissions content", SourceType: "docs"},
		{URL: "https://a.com/4", SectionPath: "Model configuration > Overview", Content: "configuration content", SourceType: "docs"},
		{URL: "https://a.com/5", SectionPath: "Create custom subagent files", Content: "subagent content", SourceType: "docs"},
		{URL: "https://a.com/6", SectionPath: "Connect to MCP servers", Content: "mcp server content", SourceType: "docs"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(&docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}
	st.ResetVocabCache()

	tests := []struct {
		name  string
		input string
		want  string // expected correction (or same if no correction)
	}{
		{"correct word unchanged", "hooks", "hooks"},
		{"typo hoks", "hoks", "hooks"},
		{"typo skilss", "skilss", "skills"},
		{"typo permisions", "permisions", "permissions"},
		{"typo configration", "configration", "configuration"},
		{"typo subagnet", "subagnet", "subagent"},
		{"too short word", "ab", "ab"},
		{"completely wrong", "xyzxyzxyz", "xyzxyzxyz"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := st.CorrectTypos(tt.input)
			if got != tt.want {
				t.Errorf("CorrectTypos(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSearchDocsFTS_Japanese(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "Hooks > Overview", Content: "Hooks allow you to run commands on lifecycle events.", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "Skills > Overview", Content: "Skills are prompt templates that guide Claude.", SourceType: "docs"},
		{URL: "https://a.com/3", SectionPath: "Configure permissions", Content: "Permission rules control what Claude can do.", SourceType: "docs"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(&docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	tests := []struct {
		query    string
		wantHits bool
	}{
		{"フック", true},
		{"スキル", true},
		{"権限", true},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			t.Parallel()
			results, err := st.SearchDocsFTS(tt.query, "", 5)
			if err != nil {
				t.Fatalf("SearchDocsFTS(%q): %v", tt.query, err)
			}
			if tt.wantHits && len(results) == 0 {
				t.Errorf("SearchDocsFTS(%q) = 0 results, want >0", tt.query)
			}
		})
	}
}

func TestSearchDocsFTS_TypoCorrection(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "Hooks reference", Content: "Hooks for lifecycle events.", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "Skills guide", Content: "Skills are templates.", SourceType: "docs"},
		{URL: "https://a.com/3", SectionPath: "Permissions overview", Content: "Configure permissions.", SourceType: "docs"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(&docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	tests := []struct {
		query    string
		wantHits bool
	}{
		{"hoks", true},     // hooks
		{"skilss", true},   // skills
		{"permisions", true}, // permissions
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			t.Parallel()
			results, err := st.SearchDocsFTS(tt.query, "", 5)
			if err != nil {
				t.Fatalf("SearchDocsFTS(%q): %v", tt.query, err)
			}
			if tt.wantHits && len(results) == 0 {
				t.Errorf("SearchDocsFTS(%q) = 0 results, want >0", tt.query)
			}
		})
	}
}

func TestExtractTerms(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  int // expected number of terms
	}{
		{"Hooks > Overview", 2},
		{"Configure permissions > Rule syntax", 4},
		{"", 0},
		{"single", 1},
		{"a.b.c", 3},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := extractTerms(tt.input)
			if len(got) != tt.want {
				t.Errorf("extractTerms(%q) = %v (%d terms), want %d terms", tt.input, got, len(got), tt.want)
			}
		})
	}
}
