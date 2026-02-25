package store

import (
	"fmt"
	"time"
)

// StoreLintFinding stores a linter finding as a pattern with type "lint_finding".
// This enables RAG: recurring lint warnings are matched via vector search.
func (s *Store) StoreLintFinding(sessionID, file, rule, message, severity string, line int) (int64, error) {
	title := fmt.Sprintf("Lint: %s in %s", rule, file)
	content := message
	if line > 0 {
		content = fmt.Sprintf("%s:%d %s", file, line, message)
	}
	embedText := fmt.Sprintf("lint %s %s %s", severity, rule, message)

	return s.InsertPattern(&PatternRow{
		SessionID:   sessionID,
		PatternType: "lint_finding",
		Title:       title,
		Content:     content,
		EmbedText:   embedText,
		Scope:       "project",
		Timestamp:   time.Now().UTC().Format(time.DateTime),
		Files:       []string{file},
	})
}

// SearchLintFindings searches for past lint findings matching the given rule or message.
func (s *Store) SearchLintFindings(rule string, limit int) ([]PatternRow, error) {
	query := `SELECT id, session_id, pattern_type, title, content, embed_text, language, scope, timestamp
		FROM patterns
		WHERE pattern_type = 'lint_finding' AND (title LIKE ? OR content LIKE ?)
		ORDER BY created_at DESC
		LIMIT ?`

	like := "%" + rule + "%"
	rows, err := s.db.Query(query, like, like, limit)
	if err != nil {
		return nil, fmt.Errorf("store: search lint findings: %w", err)
	}
	defer rows.Close()

	var results []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title,
			&p.Content, &p.EmbedText, &p.Language, &p.Scope, &p.Timestamp); err != nil {
			continue
		}
		results = append(results, p)
	}
	return results, rows.Err()
}
