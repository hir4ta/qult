package store

import (
	"context"
	"testing"
)

func TestSearchFTS(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert test records.
	docs := []DocRow{
		{URL: "memory://proj/1", SectionPath: "project > hook setup", Content: "configured pre-commit hooks for linting", SourceType: SourceMemory},
		{URL: "memory://proj/2", SectionPath: "project > database migration", Content: "added schema v7 with new tables for users", SourceType: SourceMemory},
		{URL: "memory://proj/3", SectionPath: "project > deployment", Content: "deployed to production with zero downtime", SourceType: SourceMemory},
		{URL: "spec://proj/auth", SectionPath: "auth design", Content: "OAuth2 authentication with JWT tokens", SourceType: SourceSpec},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(ctx, &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// FTS search for "hooks" — should match memory about hooks.
	results, err := st.SearchFTS(ctx, "hooks", "", 10)
	if err != nil {
		t.Fatalf("SearchFTS(hooks): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchFTS(hooks) = %d results, want 1", len(results))
	}

	// FTS search with source_type filter.
	results, err = st.SearchFTS(ctx, "hooks", SourceMemory, 10)
	if err != nil {
		t.Fatalf("SearchFTS(hooks, memory): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchFTS(hooks, memory) = %d results, want 1", len(results))
	}

	// FTS search across all types.
	results, err = st.SearchFTS(ctx, "authentication", "", 10)
	if err != nil {
		t.Fatalf("SearchFTS(authentication): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchFTS(authentication) = %d results, want 1", len(results))
	}

	// Empty query returns nil.
	results, err = st.SearchFTS(ctx, "", "", 10)
	if err != nil {
		t.Fatalf("SearchFTS(empty): %v", err)
	}
	if len(results) != 0 {
		t.Errorf("SearchFTS(empty) = %d results, want 0", len(results))
	}
}

func TestSearchFTS_SectionPathWeighting(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert: one with "deploy" in section_path, one with "deploy" in content only.
	docs := []DocRow{
		{URL: "memory://proj/1", SectionPath: "deploy pipeline", Content: "some unrelated content about things", SourceType: SourceMemory},
		{URL: "memory://proj/2", SectionPath: "project > misc notes", Content: "we need to deploy the new service", SourceType: SourceMemory},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(ctx, &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	results, err := st.SearchFTS(ctx, "deploy", "", 10)
	if err != nil {
		t.Fatalf("SearchFTS(deploy): %v", err)
	}
	if len(results) < 2 {
		t.Fatalf("SearchFTS(deploy) = %d results, want >= 2", len(results))
	}
	// section_path match should rank higher (lower BM25 score = better in FTS5).
	if results[0].SectionPath != "deploy pipeline" {
		t.Errorf("SearchFTS(deploy) first result section_path = %q, want %q", results[0].SectionPath, "deploy pipeline")
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
		{"", "xyz", 3},
		{"kitten", "sitting", 3},
		{"authentication", "authetication", 1},
		{"hook", "hook", 0},
		{"hook", "hok", 1},
		{"認証", "認証", 0},
		{"認証", "認識", 1},
	}
	for _, tt := range tests {
		t.Run(tt.a+"_"+tt.b, func(t *testing.T) {
			t.Parallel()
			got := Levenshtein(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("Levenshtein(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestFuzzyMatch(t *testing.T) {
	t.Parallel()
	tests := []struct {
		query, target string
		want          bool
	}{
		{"authentication", "authetication", true},  // 1 char missing
		{"authentication", "authentication", true},  // exact
		{"hook", "hok", true},                        // 1 char missing
		{"ab", "abc", false},                          // too short query
		{"deployment", "deploy", false},              // too different
		{"config", "conifg", true},                    // transposition
		{"database", "databases", true},               // 1 char added
	}
	for _, tt := range tests {
		t.Run(tt.query+"_"+tt.target, func(t *testing.T) {
			t.Parallel()
			got := FuzzyMatch(tt.query, tt.target)
			if got != tt.want {
				t.Errorf("FuzzyMatch(%q, %q) = %v, want %v", tt.query, tt.target, got, tt.want)
			}
		})
	}
}

func TestExpandAliases(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// The store should have seeded aliases from migration.
	expanded, err := st.ExpandAliases(ctx, []string{"auth"})
	if err != nil {
		t.Fatalf("ExpandAliases: %v", err)
	}

	// Should include "auth" itself plus aliases like "authentication", "login", etc.
	has := make(map[string]bool)
	for _, e := range expanded {
		has[e] = true
	}
	if !has["auth"] {
		t.Error("ExpandAliases(auth) missing 'auth'")
	}
	if !has["authentication"] {
		t.Error("ExpandAliases(auth) missing 'authentication'")
	}
	if !has["login"] {
		t.Error("ExpandAliases(auth) missing 'login'")
	}

	// Reverse lookup: "authentication" should expand to include "auth".
	expanded, err = st.ExpandAliases(ctx, []string{"authentication"})
	if err != nil {
		t.Fatalf("ExpandAliases(authentication): %v", err)
	}
	has = make(map[string]bool)
	for _, e := range expanded {
		has[e] = true
	}
	if !has["auth"] {
		t.Error("ExpandAliases(authentication) missing 'auth'")
	}

	// Unknown term returns only itself.
	expanded, err = st.ExpandAliases(ctx, []string{"xyzzy"})
	if err != nil {
		t.Fatalf("ExpandAliases(xyzzy): %v", err)
	}
	if len(expanded) != 1 || expanded[0] != "xyzzy" {
		t.Errorf("ExpandAliases(xyzzy) = %v, want [xyzzy]", expanded)
	}
}

func TestSearchMemoriesFTS(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert memory docs.
	memories := []DocRow{
		{URL: "memory://proj/1", SectionPath: "project > authentication setup", Content: "configured OAuth2 with JWT for login", SourceType: SourceMemory},
		{URL: "memory://proj/2", SectionPath: "project > database", Content: "migrated to SQLite with FTS5", SourceType: SourceMemory},
		{URL: "memory://proj/3", SectionPath: "project > deploy", Content: "deployed to production", SourceType: SourceMemory},
	}
	for i := range memories {
		if _, _, err := st.UpsertDoc(ctx, &memories[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Search "auth" — should find authentication doc via alias expansion.
	results, err := st.SearchMemoriesFTS(ctx, "auth", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesFTS(auth): %v", err)
	}
	if len(results) == 0 {
		t.Error("SearchMemoriesFTS(auth) returned 0 results, want >= 1")
	}

	// Search "db" — should find database doc via alias expansion.
	results, err = st.SearchMemoriesFTS(ctx, "db", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesFTS(db): %v", err)
	}
	if len(results) == 0 {
		t.Error("SearchMemoriesFTS(db) returned 0 results, want >= 1")
	}

	// Empty query returns all memories.
	results, err = st.SearchMemoriesFTS(ctx, "", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesFTS(empty): %v", err)
	}
	if len(results) != 3 {
		t.Errorf("SearchMemoriesFTS(empty) = %d results, want 3", len(results))
	}
}

func TestBuildFTSQuery(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  string
	}{
		{"hook setup", `"hook" AND "setup"`},
		{"", ""},
		{"   ", ""},
		{`test"injection`, `"testinjection"`},
		{"auth", `"auth"`},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := buildFTSQuery(tt.input)
			if got != tt.want {
				t.Errorf("buildFTSQuery(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSchemaTablesExist(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Verify FTS5 virtual table exists.
	var name string
	err := st.DB().QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='records_fts'",
	).Scan(&name)
	if err != nil {
		t.Errorf("records_fts table not found: %v", err)
	}

	// Verify tag_aliases table exists.
	err = st.DB().QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='tag_aliases'",
	).Scan(&name)
	if err != nil {
		t.Errorf("tag_aliases table not found: %v", err)
	}

	// Verify session_links table exists (V3).
	err = st.DB().QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='session_links'",
	).Scan(&name)
	if err != nil {
		t.Errorf("session_links table not found: %v", err)
	}

	// Verify schema version is 5.
	v := st.SchemaVersionCurrent()
	if v != 5 {
		t.Errorf("SchemaVersionCurrent() = %d, want 5", v)
	}
}

func TestSubTypeBoost(t *testing.T) {
	t.Parallel()
	tests := []struct {
		subType string
		want    float64
	}{
		{SubTypeRule, 2.0},
		{SubTypeDecision, 1.5},
		{SubTypePattern, 1.3},
		{SubTypeGeneral, 1.0},
		{"", 1.0},
		{"unknown", 1.0},
	}
	for _, tt := range tests {
		got := SubTypeBoost(tt.subType)
		if got != tt.want {
			t.Errorf("SubTypeBoost(%q) = %v, want %v", tt.subType, got, tt.want)
		}
	}
}

func TestSeedAliasesPopulated(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	var count int
	err := st.DB().QueryRow("SELECT COUNT(*) FROM tag_aliases").Scan(&count)
	if err != nil {
		t.Fatalf("COUNT tag_aliases: %v", err)
	}
	if count < 10 {
		t.Errorf("tag_aliases has %d rows, want >= 10 (seed data)", count)
	}
}
