package store

import (
	"fmt"
	"strings"
)

// SearchPatternsByFTS performs full-text search using FTS5 with BM25 ranking.
// For multi-word queries, tries phrase match first, then falls back to OR.
// Results are reordered to prioritize title matches.
func (s *Store) SearchPatternsByFTS(query string, patternType string, limit int) ([]PatternRow, error) {
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	words := strings.Fields(query)

	// Phase 1: Multi-word queries try phrase match first (higher precision).
	if len(words) > 1 {
		phraseQuery := buildFTSPhraseQuery(query)
		if phraseQuery != "" {
			results, err := s.executeFTSSearch(phraseQuery, patternType, limit)
			if err == nil && len(results) > 0 {
				return reorderByTitleMatch(results, query), nil
			}
		}
	}

	// Phase 2: Fall back to OR matching (broader recall).
	ftsQuery := buildFTSQuery(query)
	if ftsQuery == "" {
		return nil, nil
	}

	results, err := s.executeFTSSearch(ftsQuery, patternType, limit)
	if err != nil {
		return nil, err
	}
	return reorderByTitleMatch(results, query), nil
}

// executeFTSSearch runs an FTS5 MATCH query and returns matching patterns.
func (s *Store) executeFTSSearch(ftsQuery, patternType string, limit int) ([]PatternRow, error) {
	var sqlQuery string
	var args []any

	if patternType != "" {
		sqlQuery = `
			SELECT p.id, p.session_id, p.pattern_type, p.title, p.content, p.embed_text,
				COALESCE(p.language,''), p.scope, COALESCE(p.source_event_id,0), p.timestamp
			FROM patterns p
			JOIN patterns_fts pf ON p.id = pf.rowid
			WHERE patterns_fts MATCH ? AND p.pattern_type = ?
			ORDER BY pf.rank
			LIMIT ?`
		args = []any{ftsQuery, patternType, limit}
	} else {
		sqlQuery = `
			SELECT p.id, p.session_id, p.pattern_type, p.title, p.content, p.embed_text,
				COALESCE(p.language,''), p.scope, COALESCE(p.source_event_id,0), p.timestamp
			FROM patterns p
			JOIN patterns_fts pf ON p.id = pf.rowid
			WHERE patterns_fts MATCH ?
			ORDER BY pf.rank
			LIMIT ?`
		args = []any{ftsQuery, limit}
	}

	rows, err := s.db.Query(sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("store: fts search: %w", err)
	}
	defer rows.Close()

	var results []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title, &p.Content, &p.EmbedText,
			&p.Language, &p.Scope, &p.SourceEventID, &p.Timestamp); err != nil {
			continue
		}
		p.Tags = s.getPatternTags(p.ID)
		p.Files = s.getPatternFiles(p.ID)
		results = append(results, p)
	}
	if err := rows.Err(); err != nil {
		return results, fmt.Errorf("store: fts search iteration: %w", err)
	}

	return results, nil
}

// SearchPatternsByKeyword performs LIKE-based search as a last-resort fallback.
func (s *Store) SearchPatternsByKeyword(query string, patternType string, limit int) ([]PatternRow, error) {
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	keywords := strings.Fields(query)
	if len(keywords) == 0 {
		return nil, nil
	}

	// Build WHERE clause: all keywords must match in at least one column.
	var conditions []string
	var args []any
	for _, kw := range keywords {
		like := "%" + kw + "%"
		conditions = append(conditions, "(p.title LIKE ? OR p.content LIKE ? OR p.embed_text LIKE ?)")
		args = append(args, like, like, like)
	}

	where := strings.Join(conditions, " AND ")
	if patternType != "" {
		where += " AND p.pattern_type = ?"
		args = append(args, patternType)
	}
	args = append(args, limit)

	sqlQuery := fmt.Sprintf(`
		SELECT p.id, p.session_id, p.pattern_type, p.title, p.content, p.embed_text,
			COALESCE(p.language,''), p.scope, COALESCE(p.source_event_id,0), p.timestamp
		FROM patterns p
		WHERE %s
		ORDER BY p.timestamp DESC
		LIMIT ?`, where)

	rows, err := s.db.Query(sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("store: keyword search: %w", err)
	}
	defer rows.Close()

	var results []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title, &p.Content, &p.EmbedText,
			&p.Language, &p.Scope, &p.SourceEventID, &p.Timestamp); err != nil {
			continue
		}
		p.Tags = s.getPatternTags(p.ID)
		p.Files = s.getPatternFiles(p.ID)
		results = append(results, p)
	}
	if err := rows.Err(); err != nil {
		return results, fmt.Errorf("store: keyword search iteration: %w", err)
	}

	return results, nil
}

// buildFTSPhraseQuery builds a phrase-match FTS5 expression: "word1 word2".
// Returns empty string if the query has fewer than 2 words.
func buildFTSPhraseQuery(query string) string {
	words := strings.Fields(query)
	if len(words) < 2 {
		return ""
	}

	var cleaned []string
	for _, w := range words {
		clean := stripFTSSpecialChars(w)
		if clean != "" {
			cleaned = append(cleaned, clean)
		}
	}
	if len(cleaned) < 2 {
		return ""
	}
	return `"` + strings.Join(cleaned, " ") + `"`
}

// reorderByTitleMatch reorders results to prioritize those whose title contains
// the query keywords. BM25 ranks by overall relevance; this ensures title matches
// appear first since they're typically more relevant.
func reorderByTitleMatch(results []PatternRow, query string) []PatternRow {
	if len(results) <= 1 {
		return results
	}

	queryLower := strings.ToLower(query)
	titleMatches := make([]PatternRow, 0, len(results))
	others := make([]PatternRow, 0, len(results))

	for _, r := range results {
		if strings.Contains(strings.ToLower(r.Title), queryLower) {
			titleMatches = append(titleMatches, r)
		} else {
			others = append(others, r)
		}
	}

	return append(titleMatches, others...)
}

// stripFTSSpecialChars removes FTS5 syntax characters from a word.
func stripFTSSpecialChars(w string) string {
	clean := strings.Map(func(r rune) rune {
		switch r {
		case '"', '*', '(', ')', '{', '}', ':', '^', '+', '-', '\\':
			return -1
		default:
			return r
		}
	}, w)
	return strings.TrimSpace(clean)
}

// buildFTSQuery converts a user query into an FTS5 MATCH expression.
// Each word is joined with OR for broad matching.
// Special FTS5 characters are escaped.
func buildFTSQuery(query string) string {
	words := strings.Fields(query)
	if len(words) == 0 {
		return ""
	}

	var escaped []string
	for _, w := range words {
		clean := stripFTSSpecialChars(w)
		if clean != "" {
			escaped = append(escaped, `"`+clean+`"`)
		}
	}

	if len(escaped) == 0 {
		return ""
	}

	return strings.Join(escaped, " OR ")
}
