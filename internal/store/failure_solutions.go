package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// FailureSolution represents a recorded fix for a specific failure type.
type FailureSolution struct {
	ID             int
	SessionID      string
	FailureType    string
	ErrorSignature string
	FilePath       string
	SolutionText   string
	TimesSurfaced  int
	TimesEffective int
	Timestamp      time.Time
}

// InsertFailureSolution records a failure→fix resolution.
func (s *Store) InsertFailureSolution(sessionID, failureType, errorSig, filePath, solutionText string) error {
	_, err := s.db.Exec(
		`INSERT INTO failure_solutions (session_id, failure_type, error_signature, file_path, solution_text)
		 VALUES (?, ?, ?, ?, ?)`,
		sessionID, failureType, errorSig, filePath, solutionText,
	)
	if err != nil {
		return fmt.Errorf("store: insert failure solution: %w", err)
	}
	return nil
}

// SearchFailureSolutions finds solutions matching a failure type and error signature.
// Results are ordered by effectiveness (times_effective/times_surfaced ratio).
func (s *Store) SearchFailureSolutions(failureType, errorSig string, limit int) ([]FailureSolution, error) {
	// Escape LIKE wildcards in user-provided error signature.
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(errorSig)
	query := `SELECT id, session_id, failure_type, error_signature, file_path, solution_text,
		        times_surfaced, times_effective, timestamp
		 FROM failure_solutions
		 WHERE error_signature LIKE '%' || ? || '%' ESCAPE '\'`
	args := []any{escaped}

	if failureType != "" {
		query += ` AND failure_type = ?`
		args = append(args, failureType)
	}

	query += ` ORDER BY
		   CASE WHEN times_surfaced > 0 THEN CAST(times_effective AS REAL) / times_surfaced ELSE 0.5 END DESC,
		   timestamp DESC
		 LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: search failure solutions: %w", err)
	}
	defer rows.Close()

	var results []FailureSolution
	for rows.Next() {
		var fs FailureSolution
		var ts string
		if err := rows.Scan(&fs.ID, &fs.SessionID, &fs.FailureType, &fs.ErrorSignature,
			&fs.FilePath, &fs.SolutionText, &fs.TimesSurfaced, &fs.TimesEffective, &ts); err != nil {
			continue
		}
		fs.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		results = append(results, fs)
	}
	return results, rows.Err()
}

// SearchFailureSolutionsByFile finds solutions for a specific file path.
// Returns effective solutions first, newest second.
func (s *Store) SearchFailureSolutionsByFile(filePath string, limit int) ([]FailureSolution, error) {
	rows, err := s.db.Query(
		`SELECT id, session_id, failure_type, error_signature, file_path, solution_text,
		        times_surfaced, times_effective, timestamp
		 FROM failure_solutions
		 WHERE file_path = ?
		 ORDER BY times_effective DESC, timestamp DESC
		 LIMIT ?`,
		filePath, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: search failure solutions by file: %w", err)
	}
	defer rows.Close()

	var results []FailureSolution
	for rows.Next() {
		var fs FailureSolution
		var ts string
		if err := rows.Scan(&fs.ID, &fs.SessionID, &fs.FailureType, &fs.ErrorSignature,
			&fs.FilePath, &fs.SolutionText, &fs.TimesSurfaced, &fs.TimesEffective, &ts); err != nil {
			continue
		}
		fs.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		results = append(results, fs)
	}
	return results, rows.Err()
}

// IncrementTimesSurfaced increments the surfaced counter for a solution.
func (s *Store) IncrementTimesSurfaced(solutionID int) error {
	_, err := s.db.Exec(
		`UPDATE failure_solutions SET times_surfaced = times_surfaced + 1 WHERE id = ?`,
		solutionID,
	)
	return err
}

// IncrementTimesEffective increments the effective counter for a solution.
func (s *Store) IncrementTimesEffective(solutionID int) error {
	_, err := s.db.Exec(
		`UPDATE failure_solutions SET times_effective = times_effective + 1 WHERE id = ?`,
		solutionID,
	)
	return err
}

// FrequentFailures returns the most common failure types for a project path, aggregated across sessions.
func (s *Store) FrequentFailures(projectPath string, limit int) ([]FailureSummary, error) {
	rows, err := s.db.Query(
		`SELECT fs.failure_type, fs.error_signature, fs.file_path, COUNT(*) as cnt
		 FROM failure_solutions fs
		 JOIN sessions s ON fs.session_id = s.id
		 WHERE s.project_path = ?
		 GROUP BY fs.failure_type, fs.error_signature, fs.file_path
		 ORDER BY cnt DESC
		 LIMIT ?`,
		projectPath, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: frequent failures: %w", err)
	}
	defer rows.Close()

	var results []FailureSummary
	for rows.Next() {
		var fs FailureSummary
		if err := rows.Scan(&fs.FailureType, &fs.ErrorSignature, &fs.FilePath, &fs.Count); err != nil {
			continue
		}
		results = append(results, fs)
	}
	return results, rows.Err()
}

// UnresolvedFromSession returns failures from a specific session that have no corresponding solution.
func (s *Store) UnresolvedFromSession(sessionID string) ([]FailureSummary, error) {
	// Use a LEFT JOIN to find failure_solutions entries where no "success" follow-up exists.
	// For simplicity, we look for failure types recorded in this session.
	var failureType, errSig, filePath string
	err := s.db.QueryRow(
		`SELECT failure_type, error_signature, file_path
		 FROM failure_solutions
		 WHERE session_id = ? AND times_effective = 0
		 ORDER BY timestamp DESC LIMIT 1`,
		sessionID,
	).Scan(&failureType, &errSig, &filePath)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: unresolved from session: %w", err)
	}
	return []FailureSummary{{
		FailureType:    failureType,
		ErrorSignature: errSig,
		FilePath:       filePath,
		Count:          1,
	}}, nil
}

// FailureSummary is an aggregated view of failures.
type FailureSummary struct {
	FailureType    string
	ErrorSignature string
	FilePath       string
	Count          int
}

// FailureHistoryForFile returns cross-session failure statistics for a file.
// Unlike session-local FailureProbability, this queries the persistent store.
func (s *Store) FailureHistoryForFile(filePath string, limit int) ([]FailureSolution, int, error) {
	if limit <= 0 {
		limit = 3
	}

	var total int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM failure_solutions WHERE file_path = ?`, filePath,
	).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("store: failure history count: %w", err)
	}
	if total == 0 {
		return nil, 0, nil
	}

	rows, err := s.db.Query(
		`SELECT id, session_id, failure_type, error_signature, file_path, solution_text,
		        times_surfaced, times_effective, timestamp
		 FROM failure_solutions
		 WHERE file_path = ?
		 ORDER BY times_effective DESC, timestamp DESC
		 LIMIT ?`,
		filePath, limit,
	)
	if err != nil {
		return nil, total, fmt.Errorf("store: failure history for file: %w", err)
	}
	defer rows.Close()

	var results []FailureSolution
	for rows.Next() {
		var fs FailureSolution
		var ts string
		if err := rows.Scan(&fs.ID, &fs.SessionID, &fs.FailureType, &fs.ErrorSignature,
			&fs.FilePath, &fs.SolutionText, &fs.TimesSurfaced, &fs.TimesEffective, &ts); err != nil {
			continue
		}
		fs.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		results = append(results, fs)
	}
	return results, total, rows.Err()
}

// FailureHistoryForDirectory returns frequent failures in files within a directory.
func (s *Store) FailureHistoryForDirectory(dirPath string, limit int) ([]FailureSummary, error) {
	if limit <= 0 {
		limit = 3
	}
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(dirPath)
	rows, err := s.db.Query(
		`SELECT failure_type, error_signature, file_path, COUNT(*) as cnt
		 FROM failure_solutions
		 WHERE file_path LIKE ? || '%' ESCAPE '\'
		 GROUP BY failure_type, error_signature, file_path
		 ORDER BY cnt DESC
		 LIMIT ?`,
		escaped, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: failure history for directory: %w", err)
	}
	defer rows.Close()

	var results []FailureSummary
	for rows.Next() {
		var fs FailureSummary
		if err := rows.Scan(&fs.FailureType, &fs.ErrorSignature, &fs.FilePath, &fs.Count); err != nil {
			continue
		}
		results = append(results, fs)
	}
	return results, rows.Err()
}
