package store

import "fmt"

// Preference represents a row in the preferences table.
type Preference struct {
	Category   string
	Key        string
	Value      string
	Source     string
	Confidence float64
	CreatedAt  string
	UpdatedAt  string
}

// SetPreference creates or updates a preference.
func (s *Store) SetPreference(category, key, value, source string, confidence float64) error {
	_, err := s.db.Exec(`
		INSERT INTO preferences (category, key, value, source, confidence, updated_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(category, key) DO UPDATE SET
			value = excluded.value,
			source = excluded.source,
			confidence = excluded.confidence,
			updated_at = datetime('now')`,
		category, key, value, source, confidence)
	if err != nil {
		return fmt.Errorf("store: set preference: %w", err)
	}
	return nil
}

// GetPreferences returns all preferences, optionally filtered by category.
func (s *Store) GetPreferences(category string) ([]Preference, error) {
	query := `SELECT category, key, value, source, confidence, created_at, updated_at FROM preferences`
	var args []any
	if category != "" {
		query += ` WHERE category = ?`
		args = append(args, category)
	}
	query += ` ORDER BY category, key`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get preferences: %w", err)
	}
	defer rows.Close()

	var prefs []Preference
	for rows.Next() {
		var p Preference
		if err := rows.Scan(&p.Category, &p.Key, &p.Value, &p.Source, &p.Confidence, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		prefs = append(prefs, p)
	}
	return prefs, nil
}

// DeletePreference removes a preference by category and key.
func (s *Store) DeletePreference(category, key string) error {
	_, err := s.db.Exec(`DELETE FROM preferences WHERE category = ? AND key = ?`, category, key)
	if err != nil {
		return fmt.Errorf("store: delete preference: %w", err)
	}
	return nil
}
