package store

import "fmt"

// RecordLivePhase writes a phase entry directly to alfred.db.
// Called from PostToolUse so phase data persists without SessionEnd.
func (s *Store) RecordLivePhase(sessionID, phase, toolName string) error {
	_, err := s.db.Exec(
		`INSERT INTO live_session_phases (session_id, phase, tool_name) VALUES (?, ?, ?)`,
		sessionID, phase, toolName,
	)
	if err != nil {
		return fmt.Errorf("store: record live phase: %w", err)
	}
	return nil
}

// RecordLiveFile records a file being edited in this session.
// Uses ON CONFLICT to update timestamp on duplicate (same session + file).
func (s *Store) RecordLiveFile(sessionID, filePath string) error {
	_, err := s.db.Exec(
		`INSERT INTO live_session_files (session_id, file_path)
		 VALUES (?, ?)
		 ON CONFLICT(session_id, file_path) DO UPDATE SET
		   updated_at = datetime('now')`,
		sessionID, filePath,
	)
	if err != nil {
		return fmt.Errorf("store: record live file: %w", err)
	}
	return nil
}

// LivePhaseSequence returns the ordered phase sequence for a session.
func (s *Store) LivePhaseSequence(sessionID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT phase FROM live_session_phases
		 WHERE session_id = ? ORDER BY rowid ASC`,
		sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: live phase sequence: %w", err)
	}
	defer rows.Close()

	var phases []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		phases = append(phases, p)
	}
	return phases, rows.Err()
}

// LiveSessionFiles returns files edited in a session.
func (s *Store) LiveSessionFiles(sessionID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT file_path FROM live_session_files
		 WHERE session_id = ? ORDER BY updated_at ASC`,
		sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: live session files: %w", err)
	}
	defer rows.Close()

	var files []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			continue
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// CleanupLiveSession deletes live_session_phases and live_session_files
// for a completed session.
func (s *Store) CleanupLiveSession(sessionID string) error {
	_, err := s.db.Exec(`DELETE FROM live_session_phases WHERE session_id = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("store: cleanup live phases: %w", err)
	}
	_, err = s.db.Exec(`DELETE FROM live_session_files WHERE session_id = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("store: cleanup live files: %w", err)
	}
	return nil
}

// IncrementToolSequence upserts a single bigram directly to the global table.
func (s *Store) IncrementToolSequence(fromTool, toTool string) error {
	_, err := s.db.Exec(
		`INSERT INTO global_tool_sequences (from_tool, to_tool, count, success_count)
		 VALUES (?, ?, 1, 1)
		 ON CONFLICT(from_tool, to_tool) DO UPDATE SET
		   count = count + 1,
		   success_count = success_count + 1`,
		fromTool, toTool,
	)
	if err != nil {
		return fmt.Errorf("store: increment tool sequence: %w", err)
	}
	return nil
}

// IncrementToolTrigram upserts a single trigram directly to the global table.
func (s *Store) IncrementToolTrigram(tool1, tool2, tool3 string) error {
	_, err := s.db.Exec(
		`INSERT INTO global_tool_trigrams (tool1, tool2, tool3, count, success_count)
		 VALUES (?, ?, ?, 1, 1)
		 ON CONFLICT(tool1, tool2, tool3) DO UPDATE SET
		   count = count + 1,
		   success_count = success_count + 1`,
		tool1, tool2, tool3,
	)
	if err != nil {
		return fmt.Errorf("store: increment tool trigram: %w", err)
	}
	return nil
}
