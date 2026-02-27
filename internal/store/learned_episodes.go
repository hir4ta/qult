package store

import (
	"encoding/json"
	"fmt"
)

// LearnedEpisode represents a dynamically learned anti-pattern from past sessions.
type LearnedEpisode struct {
	ID           int64
	SessionID    string
	Name         string
	ToolSequence []string
	TotalSteps   int
	Outcome      string // "failure"
	Occurrences  int
	Timestamp    string
}

// InsertLearnedEpisode records a newly observed anti-pattern episode.
// If an episode with the same name already exists, increments its occurrences.
func (s *Store) InsertLearnedEpisode(sessionID, name string, toolSeq []string, outcome string) error {
	data, err := json.Marshal(toolSeq)
	if err != nil {
		return fmt.Errorf("store: marshal tool sequence: %w", err)
	}

	// Upsert: increment occurrences if name already exists.
	_, err = s.db.Exec(`
		INSERT INTO learned_episodes (session_id, name, tool_sequence, total_steps, outcome)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			occurrences = occurrences + 1,
			session_id = excluded.session_id,
			timestamp = datetime('now')`,
		sessionID, name, string(data), len(toolSeq), outcome,
	)
	if err != nil {
		return fmt.Errorf("store: insert learned episode: %w", err)
	}
	return nil
}

// GetLearnedEpisodes returns learned episodes with at least minOccurrences.
func (s *Store) GetLearnedEpisodes(minOccurrences int) ([]LearnedEpisode, error) {
	if minOccurrences < 1 {
		minOccurrences = 2
	}
	rows, err := s.db.Query(`
		SELECT id, session_id, name, tool_sequence, total_steps, outcome, occurrences, timestamp
		FROM learned_episodes
		WHERE occurrences >= ?
		ORDER BY occurrences DESC
		LIMIT 20`, minOccurrences)
	if err != nil {
		return nil, fmt.Errorf("store: get learned episodes: %w", err)
	}
	defer rows.Close()

	var results []LearnedEpisode
	for rows.Next() {
		var le LearnedEpisode
		var seqJSON string
		if err := rows.Scan(&le.ID, &le.SessionID, &le.Name, &seqJSON,
			&le.TotalSteps, &le.Outcome, &le.Occurrences, &le.Timestamp); err != nil {
			continue
		}
		if err := json.Unmarshal([]byte(seqJSON), &le.ToolSequence); err != nil {
			continue
		}
		results = append(results, le)
	}
	return results, rows.Err()
}
