package store

import "fmt"

// AverageRecoveryTools returns the average number of tools it took to complete
// sessions with the given task type that were eventually successful.
// This serves as a proxy for recovery time from health decline.
// Returns 0 if insufficient data (fewer than 2 successful sessions).
func (s *Store) AverageRecoveryTools(taskType string) int {
	var avg float64
	var count int
	err := s.db.QueryRow(
		`SELECT COALESCE(AVG(tool_count), 0), COUNT(*)
		 FROM workflow_sequences
		 WHERE task_type = ? AND success = 1 AND tool_count > 0`,
		taskType,
	).Scan(&avg, &count)
	if err != nil {
		fmt.Printf("[alfred] avg recovery tools query: %v\n", err)
		return 0
	}
	if count < 2 {
		return 0
	}
	return int(avg)
}
