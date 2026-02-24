package store

import (
	"database/sql"
	"fmt"
	"time"
)

// SessionRow represents a row in the sessions table.
type SessionRow struct {
	ID              string
	ProjectPath     string
	ProjectName     string
	JSONLPath       string
	FirstEventAt    string
	LastEventAt     string
	FirstPrompt     string
	Summary         string
	TurnCount       int
	ToolUseCount    int
	CompactCount    int
	ParentSessionID string
	SyncedOffset    int64
	SyncedAt        string
}

// UpsertSession creates or updates a session record.
func (s *Store) UpsertSession(sess *SessionRow) error {
	_, err := s.db.Exec(`
		INSERT INTO sessions (
			id, project_path, project_name, jsonl_path,
			first_event_at, last_event_at, first_prompt, summary,
			turn_count, tool_use_count, compact_count,
			parent_session_id, synced_offset, synced_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			project_path=excluded.project_path,
			project_name=excluded.project_name,
			jsonl_path=excluded.jsonl_path,
			first_event_at=excluded.first_event_at,
			last_event_at=excluded.last_event_at,
			first_prompt=excluded.first_prompt,
			summary=excluded.summary,
			turn_count=excluded.turn_count,
			tool_use_count=excluded.tool_use_count,
			compact_count=excluded.compact_count,
			parent_session_id=excluded.parent_session_id,
			synced_offset=excluded.synced_offset,
			synced_at=excluded.synced_at`,
		sess.ID, sess.ProjectPath, sess.ProjectName, sess.JSONLPath,
		sess.FirstEventAt, sess.LastEventAt, sess.FirstPrompt, sess.Summary,
		sess.TurnCount, sess.ToolUseCount, sess.CompactCount,
		nullIfEmpty(sess.ParentSessionID), sess.SyncedOffset, sess.SyncedAt,
	)
	if err != nil {
		return fmt.Errorf("store: upsert session: %w", err)
	}
	return nil
}

// GetSession returns a session by ID.
func (s *Store) GetSession(id string) (*SessionRow, error) {
	row := s.db.QueryRow(`
		SELECT id, project_path, project_name, jsonl_path,
			COALESCE(first_event_at,''), COALESCE(last_event_at,''),
			COALESCE(first_prompt,''), COALESCE(summary,''),
			turn_count, tool_use_count, compact_count,
			COALESCE(parent_session_id,''), synced_offset, COALESCE(synced_at,'')
		FROM sessions WHERE id = ?`, id)
	return scanSessionRow(row)
}

// GetLatestSession returns the most recent session, optionally filtered by project.
func (s *Store) GetLatestSession(project string) (*SessionRow, error) {
	var row *sql.Row
	if project != "" {
		row = s.db.QueryRow(`
			SELECT id, project_path, project_name, jsonl_path,
				COALESCE(first_event_at,''), COALESCE(last_event_at,''),
				COALESCE(first_prompt,''), COALESCE(summary,''),
				turn_count, tool_use_count, compact_count,
				COALESCE(parent_session_id,''), synced_offset, COALESCE(synced_at,'')
			FROM sessions
			WHERE project_name = ? OR project_path = ?
			ORDER BY last_event_at DESC
			LIMIT 1`, project, project)
	} else {
		row = s.db.QueryRow(`
			SELECT id, project_path, project_name, jsonl_path,
				COALESCE(first_event_at,''), COALESCE(last_event_at,''),
				COALESCE(first_prompt,''), COALESCE(summary,''),
				turn_count, tool_use_count, compact_count,
				COALESCE(parent_session_id,''), synced_offset, COALESCE(synced_at,'')
			FROM sessions
			ORDER BY last_event_at DESC
			LIMIT 1`)
	}
	return scanSessionRow(row)
}

// GetSessionChain returns the chain of sessions via parent_session_id (oldest first).
func (s *Store) GetSessionChain(sessionID string) ([]SessionRow, error) {
	rows, err := s.db.Query(`
		WITH RECURSIVE chain(id) AS (
			SELECT id FROM sessions WHERE id = ?
			UNION ALL
			SELECT s.parent_session_id FROM sessions s
			JOIN chain c ON s.id = c.id
			WHERE s.parent_session_id IS NOT NULL AND s.parent_session_id != ''
		)
		SELECT s.id, s.project_path, s.project_name, s.jsonl_path,
			COALESCE(s.first_event_at,''), COALESCE(s.last_event_at,''),
			COALESCE(s.first_prompt,''), COALESCE(s.summary,''),
			s.turn_count, s.tool_use_count, s.compact_count,
			COALESCE(s.parent_session_id,''), s.synced_offset, COALESCE(s.synced_at,'')
		FROM sessions s
		JOIN chain c ON s.id = c.id
		ORDER BY s.first_event_at ASC`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("store: get session chain: %w", err)
	}
	defer rows.Close()

	var result []SessionRow
	for rows.Next() {
		var sr SessionRow
		if err := rows.Scan(
			&sr.ID, &sr.ProjectPath, &sr.ProjectName, &sr.JSONLPath,
			&sr.FirstEventAt, &sr.LastEventAt,
			&sr.FirstPrompt, &sr.Summary,
			&sr.TurnCount, &sr.ToolUseCount, &sr.CompactCount,
			&sr.ParentSessionID, &sr.SyncedOffset, &sr.SyncedAt,
		); err != nil {
			continue
		}
		result = append(result, sr)
	}
	return result, nil
}

// UpdateSyncOffset updates the synced_offset and synced_at timestamp.
func (s *Store) UpdateSyncOffset(sessionID string, offset int64) error {
	_, err := s.db.Exec(`
		UPDATE sessions SET synced_offset = ?, synced_at = ? WHERE id = ?`,
		offset, time.Now().UTC().Format(time.RFC3339), sessionID)
	if err != nil {
		return fmt.Errorf("store: update sync offset: %w", err)
	}
	return nil
}

// FindSessionByJSONLPath finds a session by its JSONL file path.
func (s *Store) FindSessionByJSONLPath(jsonlPath string) (*SessionRow, error) {
	row := s.db.QueryRow(`
		SELECT id, project_path, project_name, jsonl_path,
			COALESCE(first_event_at,''), COALESCE(last_event_at,''),
			COALESCE(first_prompt,''), COALESCE(summary,''),
			turn_count, tool_use_count, compact_count,
			COALESCE(parent_session_id,''), synced_offset, COALESCE(synced_at,'')
		FROM sessions WHERE jsonl_path = ?`, jsonlPath)
	sr, err := scanSessionRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return sr, err
}

// EstimateSessionChains links sessions in the same project by time order.
func (s *Store) EstimateSessionChains() error {
	_, err := s.db.Exec(`
		UPDATE sessions SET parent_session_id = (
			SELECT s2.id FROM sessions s2
			WHERE s2.project_path = sessions.project_path
			  AND s2.last_event_at < sessions.first_event_at
			  AND s2.id != sessions.id
			ORDER BY s2.last_event_at DESC
			LIMIT 1
		)
		WHERE parent_session_id IS NULL OR parent_session_id = ''`)
	if err != nil {
		return fmt.Errorf("store: estimate chains: %w", err)
	}
	return nil
}

func scanSessionRow(row *sql.Row) (*SessionRow, error) {
	var sr SessionRow
	err := row.Scan(
		&sr.ID, &sr.ProjectPath, &sr.ProjectName, &sr.JSONLPath,
		&sr.FirstEventAt, &sr.LastEventAt,
		&sr.FirstPrompt, &sr.Summary,
		&sr.TurnCount, &sr.ToolUseCount, &sr.CompactCount,
		&sr.ParentSessionID, &sr.SyncedOffset, &sr.SyncedAt,
	)
	if err != nil {
		return nil, err
	}
	return &sr, nil
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
