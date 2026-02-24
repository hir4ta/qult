package store

import (
	"database/sql"
	"fmt"
	"strings"
)

// EventRow represents a row in the events table.
type EventRow struct {
	ID             int64
	SessionID      string
	EventType      int
	Timestamp      string
	UserText       string
	AssistantText  string
	ToolName       string
	ToolInput      string
	TaskID         string
	TaskSubject    string
	TaskStatus     string
	AgentName      string
	PlanTitle      string
	RawJSON        string
	ByteOffset     int64
	CompactSegment int
}

// InsertEvent inserts a single event row. FTS is updated via trigger.
func (s *Store) InsertEvent(e *EventRow) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO events (
			session_id, event_type, timestamp,
			user_text, assistant_text, tool_name, tool_input,
			task_id, task_subject, task_status,
			agent_name, plan_title, raw_json,
			byte_offset, compact_segment
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.SessionID, e.EventType, e.Timestamp,
		e.UserText, e.AssistantText, e.ToolName, e.ToolInput,
		e.TaskID, e.TaskSubject, e.TaskStatus,
		e.AgentName, e.PlanTitle, e.RawJSON,
		e.ByteOffset, e.CompactSegment,
	)
	if err != nil {
		return 0, fmt.Errorf("store: insert event: %w", err)
	}
	return res.LastInsertId()
}

// SearchEvents uses FTS5 to search events.
// segment=0: pre-compact only, segment<0: all segments.
// Returns matching rows and total count.
func (s *Store) SearchEvents(query string, sessionID string, segment int, limit int) ([]EventRow, int, error) {
	if limit <= 0 {
		limit = 50
	}

	var where []string
	var args []interface{}

	where = append(where, "events_fts MATCH ?")
	args = append(args, query)

	if sessionID != "" {
		where = append(where, "e.session_id = ?")
		args = append(args, sessionID)
	}
	if segment >= 0 {
		where = append(where, "e.compact_segment = ?")
		args = append(args, segment)
	}

	whereClause := strings.Join(where, " AND ")

	// Count
	countSQL := fmt.Sprintf(`
		SELECT count(*) FROM events e
		JOIN events_fts ON events_fts.rowid = e.id
		WHERE %s`, whereClause)
	var total int
	if err := s.db.QueryRow(countSQL, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("store: search count: %w", err)
	}

	// Fetch
	fetchSQL := fmt.Sprintf(`
		SELECT e.id, e.session_id, e.event_type, e.timestamp,
			COALESCE(e.user_text,''), COALESCE(e.assistant_text,''),
			COALESCE(e.tool_name,''), COALESCE(e.tool_input,''),
			COALESCE(e.task_id,''), COALESCE(e.task_subject,''), COALESCE(e.task_status,''),
			COALESCE(e.agent_name,''), COALESCE(e.plan_title,''),
			COALESCE(e.raw_json,''), COALESCE(e.byte_offset,0), e.compact_segment
		FROM events e
		JOIN events_fts ON events_fts.rowid = e.id
		WHERE %s
		ORDER BY e.id DESC
		LIMIT ?`, whereClause)
	args = append(args, limit)

	rows, err := s.db.Query(fetchSQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("store: search events: %w", err)
	}
	defer rows.Close()

	return scanEventRows(rows), total, nil
}

// GetRecentEvents returns the most recent events for a session.
func (s *Store) GetRecentEvents(sessionID string, limit int) ([]EventRow, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, session_id, event_type, timestamp,
			COALESCE(user_text,''), COALESCE(assistant_text,''),
			COALESCE(tool_name,''), COALESCE(tool_input,''),
			COALESCE(task_id,''), COALESCE(task_subject,''), COALESCE(task_status,''),
			COALESCE(agent_name,''), COALESCE(plan_title,''),
			COALESCE(raw_json,''), COALESCE(byte_offset,0), compact_segment
		FROM events
		WHERE session_id = ?
		ORDER BY id DESC
		LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: get recent events: %w", err)
	}
	defer rows.Close()
	return scanEventRows(rows), nil
}

// GetFilesModified returns distinct file paths from tool events (Read, Write, Edit).
func (s *Store) GetFilesModified(sessionID string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`
		SELECT DISTINCT tool_input FROM events
		WHERE session_id = ?
		  AND tool_name IN ('Read','Write','Edit')
		  AND tool_input != ''
		ORDER BY id DESC
		LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: get files modified: %w", err)
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		paths = append(paths, p)
	}
	return paths, nil
}

func scanEventRows(rows *sql.Rows) []EventRow {
	var result []EventRow
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(
			&e.ID, &e.SessionID, &e.EventType, &e.Timestamp,
			&e.UserText, &e.AssistantText,
			&e.ToolName, &e.ToolInput,
			&e.TaskID, &e.TaskSubject, &e.TaskStatus,
			&e.AgentName, &e.PlanTitle,
			&e.RawJSON, &e.ByteOffset, &e.CompactSegment,
		); err != nil {
			continue
		}
		result = append(result, e)
	}
	return result
}
