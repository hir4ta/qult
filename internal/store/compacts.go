package store

import "fmt"

// CompactEventRow represents a row in the compact_events table.
type CompactEventRow struct {
	ID           int64
	SessionID    string
	SegmentIndex int
	SummaryText  string
	Timestamp    string
	PreTurnCount int
	PreToolCount int
}

// InsertCompactEvent records a compact boundary event.
func (s *Store) InsertCompactEvent(ce *CompactEventRow) error {
	_, err := s.db.Exec(`
		INSERT INTO compact_events (
			session_id, segment_index, summary_text, timestamp,
			pre_turn_count, pre_tool_count
		) VALUES (?,?,?,?,?,?)`,
		ce.SessionID, ce.SegmentIndex, ce.SummaryText, ce.Timestamp,
		ce.PreTurnCount, ce.PreToolCount,
	)
	if err != nil {
		return fmt.Errorf("store: insert compact event: %w", err)
	}
	return nil
}

// GetCompactEvents returns all compact events for a session, ordered by segment index.
func (s *Store) GetCompactEvents(sessionID string) ([]CompactEventRow, error) {
	rows, err := s.db.Query(`
		SELECT id, session_id, segment_index,
			COALESCE(summary_text,''), COALESCE(timestamp,''),
			pre_turn_count, pre_tool_count
		FROM compact_events
		WHERE session_id = ?
		ORDER BY segment_index ASC`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("store: get compact events: %w", err)
	}
	defer rows.Close()

	var result []CompactEventRow
	for rows.Next() {
		var ce CompactEventRow
		if err := rows.Scan(
			&ce.ID, &ce.SessionID, &ce.SegmentIndex,
			&ce.SummaryText, &ce.Timestamp,
			&ce.PreTurnCount, &ce.PreToolCount,
		); err != nil {
			continue
		}
		result = append(result, ce)
	}
	return result, nil
}
