package store

import (
	"fmt"
	"sort"
)

// TaskTypeImprovement compares recent vs older sessions for a given task type.
// Returns the recent median tool count, old median tool count, and improvement percentage.
// Splits available workflow sequences into recent half and older half, requiring
// at least 4 data points (2 per group). Returns 0,0 if insufficient data.
func (s *Store) TaskTypeImprovement(taskType string) (recent, old int, err error) {
	rows, err := s.db.Query(
		`SELECT tool_count FROM workflow_sequences
		 WHERE task_type = ? AND tool_count > 0
		 ORDER BY timestamp DESC
		 LIMIT 10`, taskType,
	)
	if err != nil {
		return 0, 0, fmt.Errorf("store: task type improvement: %w", err)
	}
	defer rows.Close()

	var counts []int
	for rows.Next() {
		var tc int
		if err := rows.Scan(&tc); err != nil {
			continue
		}
		counts = append(counts, tc)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("store: task type improvement rows: %w", err)
	}

	// Need at least 4 sessions to split into meaningful recent vs old groups.
	if len(counts) < 4 {
		return 0, 0, nil
	}

	// counts is ordered newest-first from the query.
	// Split into recent half and older half.
	mid := len(counts) / 2
	recentCounts := make([]int, mid)
	copy(recentCounts, counts[:mid])
	oldCounts := make([]int, len(counts)-mid)
	copy(oldCounts, counts[mid:])

	recent = median(recentCounts)
	old = median(oldCounts)
	return recent, old, nil
}

// median returns the median value of a sorted slice. Sorts in place.
func median(vals []int) int {
	if len(vals) == 0 {
		return 0
	}
	sort.Ints(vals)
	n := len(vals)
	if n%2 == 0 {
		return (vals[n/2-1] + vals[n/2]) / 2
	}
	return vals[n/2]
}
