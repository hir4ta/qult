package store

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// PatternRow represents a row in the patterns table.
type PatternRow struct {
	ID            int64
	SessionID     string
	PatternType   string // "error_solution", "architecture", "tool_usage", "decision"
	Title         string
	Content       string // display text
	EmbedText     string // embedding text
	Language      string
	Scope         string // "project" | "global"
	SourceEventID int64
	Timestamp     string
	Tags          []string // populated by queries, not stored directly
	Files         []string // populated by queries, not stored directly
}

// Error-solution keywords (EN + JA).
var errorKeywords = []string{
	"fixed by", "resolved by", "the fix was", "the error was", "the issue was",
	"workaround:", "root cause",
	"エラー", "解決", "修正", "原因",
}

// Architecture keywords (extends decision keywords).
var architectureKeywords = []string{
	"architecture", "pattern", "approach", "design",
	"trade-off", "tradeoff",
	"アーキテクチャ", "設計",
}

// ExtractPatterns extracts knowledge patterns from events.
// It builds on ExtractDecisions logic but produces richer pattern types.
func ExtractPatterns(events []EventRow, sessionID string, lang string) []PatternRow {
	var patterns []PatternRow
	seen := make(map[string]bool)

	// Gather last user message for context.
	var lastUserText string
	for _, ev := range events {
		if ev.EventType == 0 && ev.UserText != "" { // EventUserMessage
			lastUserText = ev.UserText
		}
		if ev.EventType != 2 || ev.AssistantText == "" { // EventAssistantText
			continue
		}

		sentences := splitSentences(ev.AssistantText)
		filePaths := extractFilePaths(ev.AssistantText)

		for _, sentence := range sentences {
			trimmed := strings.TrimSpace(sentence)
			if trimmed == "" || len([]rune(trimmed)) < 20 {
				continue
			}
			if seen[trimmed] {
				continue
			}

			lower := strings.ToLower(trimmed)

			// Detect pattern type.
			patternType := classifySentence(lower)
			if patternType == "" {
				continue
			}
			seen[trimmed] = true

			topic := lastUserText
			if len([]rune(topic)) > 100 {
				topic = string([]rune(topic)[:100])
			}

			p := PatternRow{
				SessionID:     sessionID,
				PatternType:   patternType,
				Title:         topic,
				Content:       trimmed,
				EmbedText:     topic + " " + trimmed,
				Language:      lang,
				Scope:         "project",
				SourceEventID: ev.ID,
				Timestamp:     ev.Timestamp,
				Files:         filePaths,
			}

			// Auto-tag based on type.
			p.Tags = autoTags(patternType, filePaths)

			patterns = append(patterns, p)
		}
	}

	return patterns
}

// classifySentence returns the pattern type for a sentence, or "" if not a pattern.
func classifySentence(lower string) string {
	for _, kw := range errorKeywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			return "error_solution"
		}
	}
	for _, kw := range architectureKeywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			return "architecture"
		}
	}
	for _, kw := range allKeywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			return "decision"
		}
	}
	return ""
}

// autoTags generates tags based on pattern type and file paths.
func autoTags(patternType string, filePaths []string) []string {
	tags := []string{patternType}
	for _, fp := range filePaths {
		ext := fileExtension(fp)
		if ext != "" {
			tags = append(tags, ext)
		}
	}
	return uniqueStrings(tags)
}

// fileExtension extracts file extension without dot (e.g. "go", "ts").
func fileExtension(path string) string {
	idx := strings.LastIndex(path, ".")
	if idx < 0 || idx == len(path)-1 {
		return ""
	}
	ext := path[idx+1:]
	// Filter to common code extensions.
	switch ext {
	case "go", "py", "ts", "tsx", "js", "jsx", "rs", "java", "rb", "sql", "yaml", "yml", "toml", "json":
		return ext
	}
	return ""
}

func uniqueStrings(ss []string) []string {
	seen := make(map[string]bool, len(ss))
	var result []string
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			result = append(result, s)
		}
	}
	return result
}

// InsertPattern inserts a pattern and links its tags and files.
func (s *Store) InsertPattern(p *PatternRow) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO patterns (session_id, pattern_type, title, content, embed_text, language, scope, source_event_id, timestamp)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.SessionID, p.PatternType, p.Title, p.Content, p.EmbedText, p.Language, p.Scope, p.SourceEventID, p.Timestamp,
	)
	if err != nil {
		return 0, fmt.Errorf("store: insert pattern: %w", err)
	}
	id, _ := res.LastInsertId()
	p.ID = id

	// Link tags.
	for _, tag := range p.Tags {
		tagID, err := s.GetOrCreateTag(tag)
		if err != nil {
			continue
		}
		s.LinkPatternTag(id, tagID)
	}

	// Link files.
	for _, fp := range p.Files {
		s.LinkPatternFile(id, fp, "related")
	}

	return id, nil
}

// SearchPatternsByProject returns recent patterns for a given project path.
func (s *Store) SearchPatternsByProject(projectPath string, limit int) ([]PatternRow, error) {
	if limit <= 0 {
		limit = 10
	}

	rows, err := s.db.Query(`
		SELECT p.id, p.session_id, p.pattern_type, p.title, p.content, p.embed_text,
			COALESCE(p.language,''), p.scope, COALESCE(p.source_event_id,0), p.timestamp
		FROM patterns p
		JOIN sessions s ON p.session_id = s.id
		WHERE s.project_path = ? OR s.project_name = ?
		ORDER BY p.timestamp DESC
		LIMIT ?`, projectPath, filepath.Base(projectPath), limit)
	if err != nil {
		return nil, fmt.Errorf("store: search patterns by project: %w", err)
	}
	defer rows.Close()

	var result []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title, &p.Content, &p.EmbedText,
			&p.Language, &p.Scope, &p.SourceEventID, &p.Timestamp); err != nil {
			continue
		}
		p.Tags = s.getPatternTags(p.ID)
		p.Files = s.getPatternFiles(p.ID)
		result = append(result, p)
	}
	return result, rows.Err()
}

// SearchPatternsByTag returns patterns that have a specific tag.
func (s *Store) SearchPatternsByTag(tag string, limit int) ([]PatternRow, error) {
	if limit <= 0 {
		limit = 10
	}

	rows, err := s.db.Query(`
		SELECT p.id, p.session_id, p.pattern_type, p.title, p.content, p.embed_text,
			COALESCE(p.language,''), p.scope, COALESCE(p.source_event_id,0), p.timestamp
		FROM patterns p
		JOIN pattern_tags pt ON p.id = pt.pattern_id
		JOIN tags t ON pt.tag_id = t.id
		WHERE t.name = ?
		ORDER BY p.timestamp DESC
		LIMIT ?`, tag, limit)
	if err != nil {
		return nil, fmt.Errorf("store: search patterns by tag: %w", err)
	}
	defer rows.Close()

	var result []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title, &p.Content, &p.EmbedText,
			&p.Language, &p.Scope, &p.SourceEventID, &p.Timestamp); err != nil {
			continue
		}
		p.Tags = s.getPatternTags(p.ID)
		p.Files = s.getPatternFiles(p.ID)
		result = append(result, p)
	}
	return result, rows.Err()
}

// CountPatterns returns the total number of patterns in the store.
func (s *Store) CountPatterns() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT count(*) FROM patterns`).Scan(&count)
	return count, err
}

// getPatternTags returns tag names for a pattern.
func (s *Store) getPatternTags(patternID int64) []string {
	rows, err := s.db.Query(`
		SELECT t.name FROM tags t
		JOIN pattern_tags pt ON t.id = pt.tag_id
		WHERE pt.pattern_id = ?`, patternID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var tags []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			tags = append(tags, name)
		}
	}
	return tags
}

// getPatternFiles returns file paths for a pattern.
func (s *Store) getPatternFiles(patternID int64) []string {
	rows, err := s.db.Query(`
		SELECT file_path FROM pattern_files
		WHERE pattern_id = ?`, patternID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var files []string
	for rows.Next() {
		var fp string
		if rows.Scan(&fp) == nil {
			files = append(files, fp)
		}
	}
	return files
}

// PatternJSON converts a PatternRow to a JSON-friendly map.
func PatternJSON(p PatternRow) map[string]any {
	m := map[string]any{
		"id":           p.ID,
		"session_id":   p.SessionID,
		"pattern_type": p.PatternType,
		"title":        p.Title,
		"content":      p.Content,
		"scope":        p.Scope,
		"timestamp":    p.Timestamp,
	}
	if p.Language != "" {
		m["language"] = p.Language
	}
	if len(p.Tags) > 0 {
		m["tags"] = p.Tags
	}
	if len(p.Files) > 0 {
		m["files"] = p.Files
	}
	return m
}

// DeletePatternsBySession deletes all patterns (and their tag/file links) for a given session ID.
func (s *Store) DeletePatternsBySession(sessionID string) error {
	if _, err := s.db.Exec(
		`DELETE FROM pattern_tags WHERE pattern_id IN (SELECT id FROM patterns WHERE session_id = ?)`,
		sessionID,
	); err != nil {
		return fmt.Errorf("store: delete pattern tags for session %q: %w", sessionID, err)
	}
	if _, err := s.db.Exec(
		`DELETE FROM pattern_files WHERE pattern_id IN (SELECT id FROM patterns WHERE session_id = ?)`,
		sessionID,
	); err != nil {
		return fmt.Errorf("store: delete pattern files for session %q: %w", sessionID, err)
	}
	if _, err := s.db.Exec(
		`DELETE FROM patterns WHERE session_id = ?`,
		sessionID,
	); err != nil {
		return fmt.Errorf("store: delete patterns for session %q: %w", sessionID, err)
	}
	return nil
}

// PatternJSONList converts a slice of PatternRow to JSON bytes.
func PatternJSONList(patterns []PatternRow) ([]byte, error) {
	list := make([]map[string]any, 0, len(patterns))
	for _, p := range patterns {
		list = append(list, PatternJSON(p))
	}
	return json.MarshalIndent(list, "", "  ")
}
