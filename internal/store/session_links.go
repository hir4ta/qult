package store

import (
	"context"
	"fmt"
	"time"
)

// SessionLink tracks continuity across auto-compaction boundaries.
type SessionLink struct {
	ClaudeSessionID string
	MasterSessionID string
	ProjectRemote   string
	ProjectPath     string
	TaskSlug        string
	Branch          string
	LinkedAt        string
}

// LinkSession creates a session link from a new Claude session ID to a master session.
func (s *Store) LinkSession(ctx context.Context, link *SessionLink) error {
	if link.LinkedAt == "" {
		link.LinkedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO session_links
		 (claude_session_id, master_session_id, project_remote, project_path, task_slug, branch, linked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		link.ClaudeSessionID, link.MasterSessionID,
		link.ProjectRemote, link.ProjectPath, link.TaskSlug, link.Branch, link.LinkedAt,
	)
	if err != nil {
		return fmt.Errorf("store: link session: %w", err)
	}
	return nil
}

// ResolveMasterSession follows the session-link chain to find the root master session ID.
func (s *Store) ResolveMasterSession(ctx context.Context, claudeSessionID string) string {
	id := claudeSessionID
	seen := make(map[string]bool)
	for {
		if seen[id] {
			return id
		}
		seen[id] = true
		var master string
		err := s.db.QueryRowContext(ctx,
			`SELECT master_session_id FROM session_links WHERE claude_session_id = ?`, id,
		).Scan(&master)
		if err != nil || master == "" || master == id {
			return id
		}
		id = master
	}
}

// SessionContinuity returns session continuity info for a given master session.
type SessionContinuity struct {
	MasterSessionID string   `json:"master_session_id"`
	LinkedSessions  []string `json:"linked_sessions"`
	CompactCount    int      `json:"compact_count"`
}

// GetSessionContinuity retrieves all sessions linked to a master session.
func (s *Store) GetSessionContinuity(ctx context.Context, masterSessionID string) (*SessionContinuity, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT claude_session_id FROM session_links WHERE master_session_id = ? ORDER BY linked_at`,
		masterSessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get session continuity: %w", err)
	}
	defer rows.Close()

	sc := &SessionContinuity{MasterSessionID: masterSessionID}
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			continue
		}
		sc.LinkedSessions = append(sc.LinkedSessions, sid)
	}
	sc.CompactCount = len(sc.LinkedSessions)
	return sc, rows.Err()
}
