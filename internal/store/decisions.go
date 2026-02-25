package store

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// DecisionRow represents a design decision extracted from a conversation.
type DecisionRow struct {
	ID             int64
	SessionID      string
	EventID        int64
	Timestamp      string
	Topic          string
	DecisionText   string
	Reasoning      string
	FilePaths      string // JSON array
	CompactSegment int
}

// English keywords that indicate a design decision.
var enKeywords = []string{
	"decided to",
	"chosen to",
	"going with",
	"opted for",
	"instead of",
	"will use",
	"approach:",
	"strategy:",
}

// Japanese keywords that indicate a design decision.
var jaKeywords = []string{
	"に決定",
	"を採用",
	"方針",
	"ではなく",
	"にしました",
	"を選択",
}

var allKeywords = append(append([]string{}, enKeywords...), jaKeywords...)

// Regex patterns for extracting file paths from text.
var (
	backtickPathRe = regexp.MustCompile("`([a-zA-Z0-9._\\-/]+)`")
	barePathRe     = regexp.MustCompile(`(?:^|[\s(,])([a-zA-Z0-9._\-]+(?:/[a-zA-Z0-9._\-]+)+)`)
)

// ExtractDecisions extracts design decisions from assistant text using
// keyword pattern matching. No LLM is used — this is fast and deterministic.
func ExtractDecisions(assistantText string, userText string, timestamp string) []DecisionRow {
	if assistantText == "" {
		return nil
	}

	// Split into sentences on ".", "。", and "\n".
	sentences := splitSentences(assistantText)

	topic := userText
	if len([]rune(topic)) > 100 {
		topic = string([]rune(topic)[:100])
	}

	filePaths := extractFilePaths(assistantText)
	filePathsJSON, _ := json.Marshal(filePaths)

	var decisions []DecisionRow
	seen := make(map[string]bool)

	for _, sentence := range sentences {
		trimmed := strings.TrimSpace(sentence)
		if trimmed == "" {
			continue
		}

		lower := strings.ToLower(trimmed)
		matched := false
		for _, kw := range allKeywords {
			if strings.Contains(lower, strings.ToLower(kw)) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}

		// Deduplicate identical decision text.
		if seen[trimmed] {
			continue
		}
		seen[trimmed] = true

		decisions = append(decisions, DecisionRow{
			Timestamp:    timestamp,
			Topic:        topic,
			DecisionText: trimmed,
			Reasoning:    trimmed,
			FilePaths:    string(filePathsJSON),
		})
	}

	return decisions
}

// splitSentences splits text on ".", "。", and "\n".
func splitSentences(text string) []string {
	var result []string
	current := strings.Builder{}

	for _, r := range text {
		switch r {
		case '.', '。', '\n':
			s := strings.TrimSpace(current.String())
			if s != "" {
				result = append(result, s)
			}
			current.Reset()
		default:
			current.WriteRune(r)
		}
	}
	// Remaining text.
	if s := strings.TrimSpace(current.String()); s != "" {
		result = append(result, s)
	}
	return result
}

// extractFilePaths extracts file paths from text using regex patterns.
func extractFilePaths(text string) []string {
	seen := make(map[string]bool)
	var paths []string

	// Backtick-quoted paths containing at least one "/".
	for _, m := range backtickPathRe.FindAllStringSubmatch(text, -1) {
		p := m[1]
		if strings.Contains(p, "/") && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}

	// Bare paths (must contain at least one "/").
	for _, m := range barePathRe.FindAllStringSubmatch(text, -1) {
		p := strings.TrimRight(m[1], ".")
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}

	return paths
}

// InsertDecision inserts a decision row into the decisions table.
// The FTS index is updated automatically via the database trigger.
func (s *Store) InsertDecision(d *DecisionRow) error {
	res, err := s.db.Exec(`
		INSERT INTO decisions (session_id, event_id, timestamp, topic, decision_text, reasoning, file_paths, compact_segment)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		d.SessionID, d.EventID, d.Timestamp, d.Topic, d.DecisionText, d.Reasoning, d.FilePaths, d.CompactSegment,
	)
	if err != nil {
		return err
	}
	d.ID, _ = res.LastInsertId()
	return nil
}

// SearchDecisions searches decisions using LIKE on text columns.
// If sessionID is non-empty, results are filtered to that session.
func (s *Store) SearchDecisions(query string, sessionID string, limit int) ([]DecisionRow, error) {
	if limit <= 0 {
		limit = 20
	}

	var where []string
	var args []any

	pat := "%" + query + "%"
	where = append(where, "(d.topic LIKE ? OR d.decision_text LIKE ? OR COALESCE(d.reasoning,'') LIKE ?)")
	args = append(args, pat, pat, pat)

	if sessionID != "" {
		where = append(where, "d.session_id = ?")
		args = append(args, sessionID)
	}

	whereClause := strings.Join(where, " AND ")
	sqlStr := fmt.Sprintf(`
		SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning, d.file_paths, d.compact_segment
		FROM decisions d
		WHERE %s
		ORDER BY d.timestamp DESC
		LIMIT ?`, whereClause)
	args = append(args, limit)

	dbRows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer dbRows.Close()

	var rows []DecisionRow
	for dbRows.Next() {
		var r DecisionRow
		var filePaths, reasoning *string
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic, &r.DecisionText, &reasoning, &filePaths, &r.CompactSegment); err != nil {
			return nil, err
		}
		if reasoning != nil {
			r.Reasoning = *reasoning
		}
		if filePaths != nil {
			r.FilePaths = *filePaths
		}
		rows = append(rows, r)
	}
	return rows, dbRows.Err()
}

// GetDecisions returns decisions, optionally filtered by session ID or project name.
func (s *Store) GetDecisions(sessionID string, project string, limit int) ([]DecisionRow, error) {
	if limit <= 0 {
		limit = 50
	}

	var sqlStr string
	var args []any

	switch {
	case sessionID != "" && project != "":
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning, d.file_paths, d.compact_segment
			FROM decisions d
			JOIN sessions s ON d.session_id = s.id
			WHERE d.session_id = ? AND s.project_name = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{sessionID, project, limit}
	case sessionID != "":
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning, d.file_paths, d.compact_segment
			FROM decisions d
			WHERE d.session_id = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{sessionID, limit}
	case project != "":
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning, d.file_paths, d.compact_segment
			FROM decisions d
			JOIN sessions s ON d.session_id = s.id
			WHERE s.project_name = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{project, limit}
	default:
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning, d.file_paths, d.compact_segment
			FROM decisions d
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{limit}
	}

	dbRows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer dbRows.Close()

	var rows []DecisionRow
	for dbRows.Next() {
		var r DecisionRow
		var filePaths, reasoning *string
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic, &r.DecisionText, &reasoning, &filePaths, &r.CompactSegment); err != nil {
			return nil, err
		}
		if reasoning != nil {
			r.Reasoning = *reasoning
		}
		if filePaths != nil {
			r.FilePaths = *filePaths
		}
		rows = append(rows, r)
	}
	return rows, dbRows.Err()
}
