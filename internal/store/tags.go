package store

import "fmt"

// GetOrCreateTag returns the tag ID for the given name, creating it if necessary.
func (s *Store) GetOrCreateTag(name string) (int64, error) {
	var id int64
	err := s.db.QueryRow(`SELECT id FROM tags WHERE name = ?`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	res, err := s.db.Exec(`INSERT INTO tags (name) VALUES (?)`, name)
	if err != nil {
		return 0, fmt.Errorf("store: insert tag: %w", err)
	}
	return res.LastInsertId()
}

