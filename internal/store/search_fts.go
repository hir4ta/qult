package store

import (
	"fmt"
	"strings"
)

// SearchPatternsByFTS performs full-text search using FTS5 with BM25 ranking.
// Returns patterns matching the query, ordered by relevance.
func (s *Store) SearchPatternsByFTS(query string, patternType string, limit int) ([]PatternRow, error) {
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	ftsQuery := buildFTSQuery(query)
	if ftsQuery == "" {
		return nil, nil
	}

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
		// Strip FTS5 special characters to prevent syntax errors.
		clean := strings.Map(func(r rune) rune {
			switch r {
			case '"', '*', '(', ')', '{', '}', ':', '^', '+', '-', '\\':
				return -1
			default:
				return r
			}
		}, w)
		clean = strings.TrimSpace(clean)
		if clean != "" {
			escaped = append(escaped, `"`+clean+`"`)
		}
	}

	if len(escaped) == 0 {
		return ""
	}

	return strings.Join(escaped, " OR ")
}
