package store

import "testing"

func TestClassifySentenceBySignals(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		text string
		want string
	}{
		// Error solutions via signals.
		{"solved by", "this was solved by upgrading the driver", "error_solution"},
		{"caused by", "the timeout was caused by connection pool exhaustion", "error_solution"},
		{"happens when", "this happens when the cache is cold", "error_solution"},
		{"fails if", "authentication fails if token is expired", "error_solution"},

		// Decisions via signals.
		{"instead of", "we use redis instead of memcached for better persistence", "decision"},
		{"rather than", "chose polling rather than websockets for simplicity", "decision"},
		{"switched to", "switched to jwt tokens for stateless auth", "decision"},
		{"japanese decision", "memcachedではなくredisを使用", "decision"},

		// Architecture via signals.
		{"responsible for", "the gateway is responsible for rate limiting", "architecture"},
		{"validates", "middleware validates all incoming requests", "architecture"},
		{"prevents", "this guard prevents duplicate submissions", "architecture"},
		{"delegates to", "the handler delegates to the service layer", "architecture"},
		{"japanese arch", "ゲートウェイがリクエストを処理する", "architecture"},

		// No match.
		{"generic code", "const maxRetries = 3", ""},
		{"short", "ok", ""},
		{"unrelated", "the weather is nice today", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifySentenceBySignals(tt.text)
			if got != tt.want {
				t.Errorf("classifySentenceBySignals(%q) = %q, want %q", tt.text, got, tt.want)
			}
		})
	}
}

func TestClassifySentence_SignalFallback(t *testing.T) {
	t.Parallel()

	// Keyword match takes priority.
	got := classifySentence("the error was fixed by updating the config")
	if got != "error_solution" {
		t.Errorf("keyword match: got %q, want %q", got, "error_solution")
	}

	// Signal-only match (no keywords like "architecture" or "pattern").
	got = classifySentence("the gateway is responsible for rate limiting all incoming traffic")
	if got != "architecture" {
		t.Errorf("signal match: got %q, want %q", got, "architecture")
	}

	// Neither keyword nor signal.
	got = classifySentence("the quick brown fox jumps over the lazy dog")
	if got != "" {
		t.Errorf("no match: got %q, want empty", got)
	}
}

func TestRankPatterns(t *testing.T) {
	t.Parallel()

	patterns := []PatternRow{
		{ID: 1, PatternType: "architecture", Content: "arch pattern"},
		{ID: 2, PatternType: "error_solution", Content: "error fix"},
		{ID: 3, PatternType: "decision", Content: "design choice"},
	}

	tests := []struct {
		name     string
		ctx      *RankContext
		wantFirst int64
	}{
		{
			name:      "bugfix boosts error_solution",
			ctx:       &RankContext{TaskType: "bugfix"},
			wantFirst: 2,
		},
		{
			name:      "feature boosts architecture",
			ctx:       &RankContext{TaskType: "feature"},
			wantFirst: 1,
		},
		{
			name:      "refactor boosts decision",
			ctx:       &RankContext{TaskType: "refactor"},
			wantFirst: 3,
		},
		{
			name:      "nil context preserves order",
			ctx:       nil,
			wantFirst: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			// Copy to avoid mutation across subtests.
			input := make([]PatternRow, len(patterns))
			copy(input, patterns)

			ranked := RankPatterns(input, tt.ctx)
			if ranked[0].ID != tt.wantFirst {
				t.Errorf("first result ID = %d, want %d", ranked[0].ID, tt.wantFirst)
			}
		})
	}
}

func TestDomainAffinity(t *testing.T) {
	t.Parallel()

	p := PatternRow{
		Tags:  []string{"error_solution", "database"},
		Files: []string{"/app/internal/auth/handler.go"},
	}

	tests := []struct {
		name   string
		domain string
		want   float64
	}{
		{"matching tag", "database", 1.3},
		{"matching file", "auth", 1.2},
		{"no match", "ui", 1.0},
		{"general domain", "general", 1.0},
		{"empty domain", "", 1.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := domainAffinity(tt.domain, p)
			if got != tt.want {
				t.Errorf("domainAffinity(%q) = %v, want %v", tt.domain, got, tt.want)
			}
		})
	}
}
