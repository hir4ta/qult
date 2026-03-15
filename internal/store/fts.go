package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// SearchFTS performs a full-text search on the records_fts virtual table using BM25 ranking.
// Optionally filters by source_type. Returns results ordered by relevance.
// section_path matches are weighted 3x higher than content matches.
func (s *Store) SearchFTS(ctx context.Context, query string, sourceType string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}

	// Build FTS5 query: each word is a term, joined with AND.
	ftsQuery := buildFTSQuery(query)
	if ftsQuery == "" {
		return nil, nil
	}

	var sqlQuery string
	var args []any

	if sourceType != "" {
		sqlQuery = `SELECT r.id, r.url, r.section_path, r.content, r.content_hash,
			r.source_type, r.version, r.crawled_at, r.ttl_days,
			bm25(records_fts, 1.0, 3.0) AS rank
		FROM records_fts f
		JOIN records r ON r.rowid = f.rowid
		WHERE records_fts MATCH ? AND r.source_type = ?
		ORDER BY rank
		LIMIT ?`
		args = []any{ftsQuery, sourceType, limit}
	} else {
		sqlQuery = `SELECT r.id, r.url, r.section_path, r.content, r.content_hash,
			r.source_type, r.version, r.crawled_at, r.ttl_days,
			bm25(records_fts, 1.0, 3.0) AS rank
		FROM records_fts f
		JOIN records r ON r.rowid = f.rowid
		WHERE records_fts MATCH ?
		ORDER BY rank
		LIMIT ?`
		args = []any{ftsQuery, limit}
	}

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		// FTS5 query syntax error or table missing — fall back gracefully.
		return nil, fmt.Errorf("store: fts search: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		var rank float64
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &version, &d.CrawledAt, &d.TTLDays, &rank); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// buildFTSQuery converts a natural language query into FTS5 syntax.
// Each word becomes a quoted term, joined with AND.
// Strips FTS5 special characters to prevent injection.
func buildFTSQuery(query string) string {
	words := strings.Fields(query)
	var terms []string
	for _, w := range words {
		w = sanitizeFTSTerm(w)
		if w == "" {
			continue
		}
		terms = append(terms, `"`+w+`"`)
	}
	return strings.Join(terms, " AND ")
}

// sanitizeFTSTerm removes FTS5 special characters from a search term.
func sanitizeFTSTerm(term string) string {
	var b strings.Builder
	for _, r := range term {
		// Allow letters, digits, CJK characters, and common punctuation.
		if r == '"' || r == '*' || r == '^' || r == '{' || r == '}' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ExpandAliases expands a list of search terms using the tag_aliases table.
// For each term, if it matches a tag or alias, all related terms are included.
// Returns deduplicated expanded terms.
func (s *Store) ExpandAliases(ctx context.Context, terms []string) ([]string, error) {
	if len(terms) == 0 {
		return nil, nil
	}

	seen := make(map[string]bool, len(terms)*2)
	for _, t := range terms {
		seen[strings.ToLower(t)] = true
	}

	for _, t := range terms {
		lower := strings.ToLower(t)

		// Find aliases where this term is the tag.
		rows, err := s.db.QueryContext(ctx,
			`SELECT alias FROM tag_aliases WHERE LOWER(tag) = ?`, lower)
		if err != nil {
			return nil, fmt.Errorf("store: expand aliases (tag): %w", err)
		}
		for rows.Next() {
			var alias string
			if err := rows.Scan(&alias); err != nil {
				continue
			}
			seen[strings.ToLower(alias)] = true
		}
		rows.Close()

		// Find tags where this term is an alias.
		rows, err = s.db.QueryContext(ctx,
			`SELECT tag FROM tag_aliases WHERE LOWER(alias) = ?`, lower)
		if err != nil {
			return nil, fmt.Errorf("store: expand aliases (alias): %w", err)
		}
		for rows.Next() {
			var tag string
			if err := rows.Scan(&tag); err != nil {
				continue
			}
			seen[strings.ToLower(tag)] = true
		}
		rows.Close()
	}

	result := make([]string, 0, len(seen))
	for t := range seen {
		result = append(result, t)
	}
	return result, nil
}

// Levenshtein computes the Levenshtein distance between two strings.
// Operates on runes for correct Unicode handling.
func Levenshtein(a, b string) int {
	ra := []rune(a)
	rb := []rune(b)
	la := len(ra)
	lb := len(rb)

	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	// Single-row DP to minimize allocations.
	prev := make([]int, lb+1)
	for j := range prev {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr := make([]int, lb+1)
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			curr[j] = min(
				curr[j-1]+1,
				prev[j]+1,
				prev[j-1]+cost,
			)
		}
		prev = curr
	}
	return prev[lb]
}

// FuzzyMatch returns true if query is within acceptable edit distance of target.
// maxDist = min(2, runeCount(query)/3). Returns false for very short queries (<3 runes).
func FuzzyMatch(query, target string) bool {
	qLen := utf8.RuneCountInString(query)
	if qLen < 3 {
		return false
	}
	maxDist := min(2, qLen/3)
	if maxDist == 0 {
		maxDist = 1
	}
	dist := Levenshtein(strings.ToLower(query), strings.ToLower(target))
	return dist <= maxDist
}

// Conflict represents a pair of potentially contradictory memories.
type Conflict struct {
	DocA       DocRow
	DocB       DocRow
	Similarity float64
}

// DetectConflicts finds pairs of memory records with high cosine similarity
// that may represent contradictory decisions. Threshold 0.75 = high semantic overlap.
// Only checks source_type="memory" records that have embeddings.
func (s *Store) DetectConflicts(ctx context.Context, threshold float64) ([]Conflict, error) {
	if threshold <= 0 {
		threshold = 0.75
	}

	// Load all memory embeddings.
	rows, err := s.db.QueryContext(ctx,
		`SELECT e.source_id, e.vector FROM embeddings e
		 JOIN records r ON r.id = e.source_id
		 WHERE e.source = 'records' AND r.source_type = ?
		 LIMIT 1000`, SourceMemory)
	if err != nil {
		return nil, fmt.Errorf("store: detect conflicts query: %w", err)
	}
	defer rows.Close()

	type embeddedDoc struct {
		id  int64
		vec []float32
	}
	var docs []embeddedDoc
	for rows.Next() {
		var ed embeddedDoc
		var blob []byte
		if err := rows.Scan(&ed.id, &blob); err != nil {
			continue
		}
		ed.vec = deserializeFloat32(blob)
		docs = append(docs, ed)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: detect conflicts iteration: %w", err)
	}

	// Pairwise cosine similarity.
	var conflicts []Conflict
	for i := 0; i < len(docs); i++ {
		for j := i + 1; j < len(docs); j++ {
			if len(docs[i].vec) != len(docs[j].vec) {
				continue
			}
			sim := cosineSimilarity(docs[i].vec, docs[j].vec)
			if sim >= threshold {
				conflicts = append(conflicts, Conflict{
					DocA:       DocRow{ID: docs[i].id},
					DocB:       DocRow{ID: docs[j].id},
					Similarity: sim,
				})
			}
		}
	}

	// Hydrate conflict docs.
	if len(conflicts) > 0 {
		var allIDs []int64
		for _, c := range conflicts {
			allIDs = append(allIDs, c.DocA.ID, c.DocB.ID)
		}
		hydrated, err := s.GetDocsByIDs(ctx, allIDs)
		if err == nil {
			docMap := make(map[int64]DocRow, len(hydrated))
			for _, d := range hydrated {
				docMap[d.ID] = d
			}
			for i := range conflicts {
				if d, ok := docMap[conflicts[i].DocA.ID]; ok {
					conflicts[i].DocA = d
				}
				if d, ok := docMap[conflicts[i].DocB.ID]; ok {
					conflicts[i].DocB = d
				}
			}
		}
	}

	// Sort by similarity descending.
	sort.Slice(conflicts, func(i, j int) bool {
		return conflicts[i].Similarity > conflicts[j].Similarity
	})

	return conflicts, nil
}

// SearchMemoriesFTS searches memory records using FTS5 with tag alias expansion.
// Falls back to keyword LIKE search if FTS5 fails.
func (s *Store) SearchMemoriesFTS(ctx context.Context, query string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return s.SearchMemoriesKeyword(ctx, "", limit)
	}

	// Expand query terms with aliases.
	words := strings.Fields(query)
	expanded, err := s.ExpandAliases(ctx, words)
	if err != nil {
		// Non-fatal: proceed with original terms.
		expanded = words
	}

	// Build FTS5 OR query: any expanded term matches.
	var ftsTerms []string
	for _, w := range expanded {
		w = sanitizeFTSTerm(w)
		if w != "" {
			ftsTerms = append(ftsTerms, `"`+w+`"`)
		}
	}
	if len(ftsTerms) == 0 {
		return s.SearchMemoriesKeyword(ctx, query, limit)
	}
	ftsQuery := strings.Join(ftsTerms, " OR ")

	docs, err := s.searchFTSMemory(ctx, ftsQuery, limit)
	if err != nil {
		// FTS5 failure — fall back to keyword search.
		return s.SearchMemoriesKeyword(ctx, query, limit)
	}

	// If FTS returned too few results, supplement with fuzzy matching.
	if len(docs) < limit {
		fuzzyDocs := s.fuzzySearchMemories(ctx, words, limit-len(docs), docs)
		docs = append(docs, fuzzyDocs...)
	}

	return docs, nil
}

// searchFTSMemory runs FTS5 search filtered to memory source_type.
func (s *Store) searchFTSMemory(ctx context.Context, ftsQuery string, limit int) ([]DocRow, error) {
	sqlQuery := `SELECT r.id, r.url, r.section_path, r.content, r.content_hash,
		r.source_type, r.version, r.crawled_at, r.ttl_days,
		bm25(records_fts, 1.0, 3.0) AS rank
	FROM records_fts f
	JOIN records r ON r.rowid = f.rowid
	WHERE records_fts MATCH ? AND r.source_type = ?
	ORDER BY rank
	LIMIT ?`

	rows, err := s.db.QueryContext(ctx, sqlQuery, ftsQuery, SourceMemory, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		var rank float64
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &version, &d.CrawledAt, &d.TTLDays, &rank); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// fuzzySearchMemories scans memory records and returns those matching any query
// word within fuzzy distance. Excludes already-found docs.
func (s *Store) fuzzySearchMemories(ctx context.Context, queryWords []string, limit int, exclude []DocRow) []DocRow {
	if limit <= 0 {
		return nil
	}
	excludeIDs := make(map[int64]bool, len(exclude))
	for _, d := range exclude {
		excludeIDs[d.ID] = true
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days
		FROM records WHERE source_type = ? LIMIT 500`, SourceMemory)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &version, &d.CrawledAt, &d.TTLDays); err != nil {
			continue
		}
		d.Version = version.String

		if excludeIDs[d.ID] {
			continue
		}

		// Check if any query word fuzzy-matches words in section_path (not full content — too expensive).
		targetWords := strings.Fields(strings.ToLower(d.SectionPath))
		for _, qw := range queryWords {
			matched := false
			for _, tw := range targetWords {
				if FuzzyMatch(qw, tw) {
					matched = true
					break
				}
			}
			if matched {
				docs = append(docs, d)
				if len(docs) >= limit {
					return docs
				}
				break
			}
		}
	}
	return docs
}
