package store

import (
	"encoding/json"
	"fmt"
	"path/filepath"
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
	ContextBefore  string
	ContextAfter   string
	FilePaths      string // JSON array
	CompactSegment int
}

// Decision keywords indicating a design choice was made.
var decisionKeywords = []string{
	// English — selection
	"decided to",
	"chosen to",
	"going with",
	"opted for",
	"will use",
	"went with",
	"i'll use",
	"let's use",
	"let's go with",
	// English — approach
	"approach:",
	"strategy:",
	"the approach is",
	"the strategy is",
	"the plan is",
	// English — comparison
	"instead of",
	"rather than",
	"better suited",
	"more appropriate",
	// English — change
	"switched to",
	"switched from",
	"changed to",
	"replaced with",
	"moved to",
	"migrated to",
	"refactored to",
	"converted to",
	// English — recommendation
	"recommend using",

	// Japanese — selection
	"にしました",
	"にします",
	"を選択",
	"を採用",
	"を使うことに",
	"を使います",
	"を選びました",
	"で行きます",
	// Japanese — approach
	"方式で",
	"方針として",
	"アプローチで",
	// Japanese — change
	"に変更",
	"に切り替え",
	"に移行",
	"に置き換え",
	"をやめて",
	// Japanese — comparison
	"ではなく",
	"の代わりに",
}

// fencedCodeBlockRe matches markdown fenced code blocks (triple backticks).
var fencedCodeBlockRe = regexp.MustCompile("(?s)```.*?```")

// ExtractDecisions extracts design decisions from assistant text using
// keyword pattern matching. No LLM is used — fast and deterministic.
func ExtractDecisions(assistantText string, timestamp string) []DecisionRow {
	if assistantText == "" {
		return nil
	}

	// Strip markdown code blocks to avoid false positives from code comments.
	stripped := fencedCodeBlockRe.ReplaceAllString(assistantText, "")

	sentences := splitSentences(stripped)

	filePaths := ExtractFilePaths(assistantText)
	filePathsJSON, _ := json.Marshal(filePaths)
	if filePaths == nil {
		filePathsJSON = []byte("[]")
	}

	var decisions []DecisionRow
	seen := make(map[string]bool)

	for i, sentence := range sentences {
		trimmed := strings.TrimSpace(sentence)
		if trimmed == "" {
			continue
		}

		lower := strings.ToLower(trimmed)
		matched := false
		for _, kw := range decisionKeywords {
			if strings.Contains(lower, kw) || strings.Contains(trimmed, kw) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}

		if seen[trimmed] {
			continue
		}
		seen[trimmed] = true

		topic := trimmed
		if runes := []rune(topic); len(runes) > 80 {
			topic = string(runes[:80])
		}

		var ctxBefore, ctxAfter string
		if i > 0 {
			ctxBefore = strings.TrimSpace(sentences[i-1])
			if runes := []rune(ctxBefore); len(runes) > 200 {
				ctxBefore = string(runes[:200])
			}
		}
		if i < len(sentences)-1 {
			ctxAfter = strings.TrimSpace(sentences[i+1])
			if runes := []rune(ctxAfter); len(runes) > 200 {
				ctxAfter = string(runes[:200])
			}
		}

		decisions = append(decisions, DecisionRow{
			Timestamp:     timestamp,
			Topic:         topic,
			DecisionText:  trimmed,
			ContextBefore: ctxBefore,
			ContextAfter:  ctxAfter,
			FilePaths:     string(filePathsJSON),
		})
	}

	if len(decisions) > 5 {
		decisions = decisions[:5]
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
	if s := strings.TrimSpace(current.String()); s != "" {
		result = append(result, s)
	}
	return result
}

// Regex patterns for extracting file paths from text.
var (
	backtickPathRe = regexp.MustCompile("`([a-zA-Z0-9._\\-/]+)`")
	barePathRe     = regexp.MustCompile(`(?:^|[\s(,])([a-zA-Z0-9._\-]+(?:/[a-zA-Z0-9._\-]+)+)`)
)

// ExtractFilePaths extracts file paths from text using regex patterns.
func ExtractFilePaths(text string) []string {
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
// The FTS index is updated automatically via database trigger (decisions_fts).
func (s *Store) InsertDecision(d *DecisionRow) error {
	res, err := s.db.Exec(`
		INSERT INTO decisions (session_id, event_id, timestamp, topic, decision_text, reasoning, context_before, context_after, file_paths, compact_segment)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.SessionID, d.EventID, d.Timestamp, d.Topic, d.DecisionText, d.Reasoning, d.ContextBefore, d.ContextAfter, d.FilePaths, d.CompactSegment,
	)
	if err != nil {
		return err
	}
	d.ID, _ = res.LastInsertId()
	return nil
}

// SearchDecisionsFTS searches decisions using FTS5 full-text search with
// LIKE fallback. Returns results ranked by BM25 relevance.
func (s *Store) SearchDecisionsFTS(query string, sessionID string, limit int) ([]DecisionRow, error) {
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	sanitized := SanitizeFTS5Query(query)
	if sanitized != "" {
		results, err := s.matchDecisionsFTS(sanitized, sessionID, limit)
		if err == nil && len(results) > 0 {
			return results, nil
		}
	}
	// Fallback to LIKE.
	return s.searchDecisionsLIKE(query, sessionID, limit)
}

// matchDecisionsFTS executes a FTS5 MATCH query against decisions_fts.
func (s *Store) matchDecisionsFTS(ftsQuery string, sessionID string, limit int) ([]DecisionRow, error) {
	var sqlStr string
	var args []any

	if sessionID != "" {
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic,
			       d.decision_text, d.reasoning, COALESCE(d.context_before,''), COALESCE(d.context_after,''),
			       d.file_paths, d.compact_segment
			FROM decisions_fts f
			JOIN decisions d ON d.id = f.rowid
			WHERE decisions_fts MATCH ? AND d.session_id = ?
			ORDER BY rank
			LIMIT ?`
		args = []any{ftsQuery, sessionID, limit}
	} else {
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic,
			       d.decision_text, d.reasoning, COALESCE(d.context_before,''), COALESCE(d.context_after,''),
			       d.file_paths, d.compact_segment
			FROM decisions_fts f
			JOIN decisions d ON d.id = f.rowid
			WHERE decisions_fts MATCH ?
			ORDER BY rank
			LIMIT ?`
		args = []any{ftsQuery, limit}
	}

	return s.scanDecisionRows(sqlStr, args)
}

// searchDecisionsLIKE searches decisions using LIKE on text columns.
func (s *Store) searchDecisionsLIKE(query string, sessionID string, limit int) ([]DecisionRow, error) {
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
		SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning,
		       COALESCE(d.context_before,''), COALESCE(d.context_after,''), d.file_paths, d.compact_segment
		FROM decisions d
		WHERE %s
		ORDER BY d.timestamp DESC
		LIMIT ?`, whereClause)
	args = append(args, limit)

	return s.scanDecisionRows(sqlStr, args)
}

// SearchDecisions searches decisions using LIKE on text columns (legacy API).
// Prefer SearchDecisionsFTS for ranked results.
func (s *Store) SearchDecisions(query string, sessionID string, limit int) ([]DecisionRow, error) {
	if limit <= 0 {
		limit = 20
	}
	return s.searchDecisionsLIKE(query, sessionID, limit)
}

// scanDecisionRows executes a query and scans results into DecisionRow slices.
func (s *Store) scanDecisionRows(sqlStr string, args []any) ([]DecisionRow, error) {
	dbRows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer dbRows.Close()

	var rows []DecisionRow
	for dbRows.Next() {
		var r DecisionRow
		var filePaths, reasoning *string
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic, &r.DecisionText, &reasoning, &r.ContextBefore, &r.ContextAfter, &filePaths, &r.CompactSegment); err != nil {
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

// SearchDecisionsByFile returns decisions whose file_paths JSON contains the given file path.
func (s *Store) SearchDecisionsByFile(filePath string, limit int) ([]DecisionRow, error) {
	if limit <= 0 {
		limit = 5
	}
	base := filepath.Base(filePath)
	pat := "%" + base + "%"

	dbRows, err := s.db.Query(`
		SELECT d.id, d.session_id, COALESCE(d.event_id,0), d.timestamp, d.topic,
			   d.decision_text, COALESCE(d.reasoning,''), COALESCE(d.context_before,''), COALESCE(d.context_after,''),
			   COALESCE(d.file_paths,'[]'), d.compact_segment
		FROM decisions d
		WHERE d.file_paths LIKE ?
		ORDER BY d.timestamp DESC
		LIMIT ?`, pat, limit)
	if err != nil {
		return nil, fmt.Errorf("store: search decisions by file: %w", err)
	}
	defer dbRows.Close()

	var rows []DecisionRow
	for dbRows.Next() {
		var r DecisionRow
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic,
			&r.DecisionText, &r.Reasoning, &r.ContextBefore, &r.ContextAfter, &r.FilePaths, &r.CompactSegment); err != nil {
			continue
		}
		rows = append(rows, r)
	}
	return rows, dbRows.Err()
}

// SearchDecisionsByDirectory returns decisions whose file_paths JSON contains
// any file in the given directory.
func (s *Store) SearchDecisionsByDirectory(dirPath string, limit int) ([]DecisionRow, error) {
	if limit <= 0 {
		limit = 3
	}
	// Use full directory path in the LIKE pattern to avoid matching same-named dirs
	// in unrelated parts of the tree (e.g. "store" vs "some/other/store").
	// file_paths is a JSON array like ["internal/store/file.go"], so the leading %
	// skips past the opening bracket and path prefix.
	dirPrefix := strings.TrimRight(dirPath, "/") + "/"
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(dirPrefix)
	pat := "%" + escaped + "%"

	dbRows, err := s.db.Query(`
		SELECT d.id, d.session_id, COALESCE(d.event_id,0), d.timestamp, d.topic,
			   d.decision_text, COALESCE(d.reasoning,''), COALESCE(d.context_before,''), COALESCE(d.context_after,''),
			   COALESCE(d.file_paths,'[]'), d.compact_segment
		FROM decisions d
		WHERE d.file_paths LIKE ? ESCAPE '\'
		ORDER BY d.timestamp DESC
		LIMIT ?`, pat, limit)
	if err != nil {
		return nil, fmt.Errorf("store: search decisions by directory: %w", err)
	}
	defer dbRows.Close()

	var rows []DecisionRow
	for dbRows.Next() {
		var r DecisionRow
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic,
			&r.DecisionText, &r.Reasoning, &r.ContextBefore, &r.ContextAfter, &r.FilePaths, &r.CompactSegment); err != nil {
			continue
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
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning,
			       COALESCE(d.context_before,''), COALESCE(d.context_after,''), d.file_paths, d.compact_segment
			FROM decisions d
			JOIN sessions s ON d.session_id = s.id
			WHERE d.session_id = ? AND s.project_name = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{sessionID, project, limit}
	case sessionID != "":
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning,
			       COALESCE(d.context_before,''), COALESCE(d.context_after,''), d.file_paths, d.compact_segment
			FROM decisions d
			WHERE d.session_id = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{sessionID, limit}
	case project != "":
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning,
			       COALESCE(d.context_before,''), COALESCE(d.context_after,''), d.file_paths, d.compact_segment
			FROM decisions d
			JOIN sessions s ON d.session_id = s.id
			WHERE s.project_name = ?
			ORDER BY d.timestamp DESC
			LIMIT ?`
		args = []any{project, limit}
	default:
		sqlStr = `
			SELECT d.id, d.session_id, d.event_id, d.timestamp, d.topic, d.decision_text, d.reasoning,
			       COALESCE(d.context_before,''), COALESCE(d.context_after,''), d.file_paths, d.compact_segment
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
		if err := dbRows.Scan(&r.ID, &r.SessionID, &r.EventID, &r.Timestamp, &r.Topic, &r.DecisionText, &reasoning, &r.ContextBefore, &r.ContextAfter, &filePaths, &r.CompactSegment); err != nil {
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

func (s *Store) DeleteDecision(id int64) error {
	_, err := s.db.Exec("DELETE FROM decisions WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("store: delete decision: %w", err)
	}
	return nil
}
