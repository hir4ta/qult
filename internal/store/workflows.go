package store

import (
	"encoding/json"
	"fmt"
)

// WorkflowSequence represents a recorded workflow pattern from a past session.
type WorkflowSequence struct {
	ID            int64
	SessionID     string
	TaskType      string
	PhaseSequence []string
	Success       bool
	ToolCount     int
	DurationSec   int
}

// InsertWorkflowSequence records a workflow sequence from a completed session.
func (s *Store) InsertWorkflowSequence(sessionID, taskType string, phases []string, success bool, toolCount, durationSec int) error {
	data, err := json.Marshal(phases)
	if err != nil {
		return fmt.Errorf("store: marshal phases: %w", err)
	}
	succ := 0
	if success {
		succ = 1
	}
	_, err = s.db.Exec(
		`INSERT INTO workflow_sequences (session_id, task_type, phase_sequence, success, tool_count, duration_sec)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, taskType, string(data), succ, toolCount, durationSec,
	)
	if err != nil {
		return fmt.Errorf("store: insert workflow sequence: %w", err)
	}
	return nil
}

// GetSuccessfulWorkflows returns successful workflow sequences for a task type.
// Filters by project path via session join when projectPath is non-empty.
// Returns up to limit results, newest first.
func (s *Store) GetSuccessfulWorkflows(projectPath, taskType string, limit int) ([]WorkflowSequence, error) {
	var query string
	var args []any
	if projectPath != "" {
		query = `SELECT ws.id, ws.session_id, ws.task_type, ws.phase_sequence, ws.tool_count, ws.duration_sec
			 FROM workflow_sequences ws
			 JOIN sessions s ON ws.session_id = s.id
			 WHERE s.project_path = ? AND ws.task_type = ? AND ws.success = 1
			 ORDER BY ws.timestamp DESC
			 LIMIT ?`
		args = []any{projectPath, taskType, limit}
	} else {
		query = `SELECT ws.id, ws.session_id, ws.task_type, ws.phase_sequence, ws.tool_count, ws.duration_sec
			 FROM workflow_sequences ws
			 WHERE ws.task_type = ? AND ws.success = 1
			 ORDER BY ws.timestamp DESC
			 LIMIT ?`
		args = []any{taskType, limit}
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get successful workflows: %w", err)
	}
	defer rows.Close()

	var results []WorkflowSequence
	for rows.Next() {
		var ws WorkflowSequence
		var phasesJSON string
		if err := rows.Scan(&ws.ID, &ws.SessionID, &ws.TaskType, &phasesJSON, &ws.ToolCount, &ws.DurationSec); err != nil {
			continue
		}
		ws.Success = true
		if err := json.Unmarshal([]byte(phasesJSON), &ws.PhaseSequence); err != nil {
			continue
		}
		results = append(results, ws)
	}
	return results, rows.Err()
}

// MostCommonWorkflow returns the most frequent phase ordering from successful workflows.
// Returns nil if fewer than minExamples successful sequences exist.
func (s *Store) MostCommonWorkflow(projectPath, taskType string, minExamples int) ([]string, int, error) {
	workflows, err := s.GetSuccessfulWorkflows(projectPath, taskType, 20)
	if err != nil {
		return nil, 0, err
	}
	if len(workflows) < minExamples {
		return nil, len(workflows), nil
	}

	// Count frequency of each phase sequence pattern.
	freq := make(map[string]int)
	for _, ws := range workflows {
		key, _ := json.Marshal(ws.PhaseSequence)
		freq[string(key)]++
	}

	// Find the most common pattern.
	var bestKey string
	var bestCount int
	for k, c := range freq {
		if c > bestCount {
			bestKey = k
			bestCount = c
		}
	}

	var phases []string
	if err := json.Unmarshal([]byte(bestKey), &phases); err != nil {
		return nil, len(workflows), nil
	}
	return phases, len(workflows), nil
}
