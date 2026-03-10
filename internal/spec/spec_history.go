package spec

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// validTimestamp matches the history timestamp format "YYYYMMDD-HHMMSS".
var validTimestamp = regexp.MustCompile(`^\d{8}-\d{6}$`)

const (
	historyDir        = ".history"
	maxHistoryPerFile = 20
	historyTimeFmt    = "20060102-150405"
)

// HistoryEntry represents a saved version of a spec file.
type HistoryEntry struct {
	File      SpecFile
	Timestamp string // "20060102-150405"
	Size      int64
	Path      string // full filesystem path
}

// saveHistory copies the current spec file to .history/ before overwrite.
// Fail-open: errors are logged but do not prevent the write.
func (s *SpecDir) saveHistory(f SpecFile) error {
	src := s.FilePath(f)
	data, err := os.ReadFile(src)
	if err != nil {
		return nil // file doesn't exist yet — nothing to save
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil // empty file
	}

	histDir := filepath.Join(s.Dir(), historyDir)
	if err := os.MkdirAll(histDir, 0o755); err != nil {
		return fmt.Errorf("create history dir: %w", err)
	}

	ts := time.Now().Format(historyTimeFmt)
	dst := filepath.Join(histDir, string(f)+"."+ts)
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return fmt.Errorf("write history: %w", err)
	}

	// Prune old versions.
	_ = s.pruneHistory(f)
	return nil
}

// History returns version history for a spec file, newest first.
func (s *SpecDir) History(f SpecFile) ([]HistoryEntry, error) {
	histDir := filepath.Join(s.Dir(), historyDir)
	prefix := string(f) + "."

	entries, err := os.ReadDir(histDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read history dir: %w", err)
	}

	var results []HistoryEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		ts := strings.TrimPrefix(e.Name(), prefix)
		info, err := e.Info()
		if err != nil {
			continue
		}
		results = append(results, HistoryEntry{
			File:      f,
			Timestamp: ts,
			Size:      info.Size(),
			Path:      filepath.Join(histDir, e.Name()),
		})
	}

	// Sort newest first.
	sort.Slice(results, func(i, j int) bool {
		return results[i].Timestamp > results[j].Timestamp
	})

	return results, nil
}

// Rollback restores a historical version as the current file.
// Saves the current version to history first (so rollback is itself undoable).
func (s *SpecDir) Rollback(f SpecFile, timestamp string) error {
	if !validTimestamp.MatchString(timestamp) {
		return fmt.Errorf("invalid version format %q: expected YYYYMMDD-HHMMSS", timestamp)
	}
	histPath := filepath.Join(s.Dir(), historyDir, string(f)+"."+timestamp)
	data, err := os.ReadFile(histPath)
	if err != nil {
		return fmt.Errorf("read history %s: %w", timestamp, err)
	}

	// Acquire lock first, then save history + write atomically to avoid
	// a TOCTOU where a concurrent WriteFile could slip between saveHistory
	// and the actual write.
	lf, err := s.lockSpecDir()
	if err == nil {
		defer unlockSpecDir(lf)
	}
	// Save current version before restoring (makes rollback undoable).
	_ = s.saveHistory(f)
	return s.writeFileRaw(f, string(data))
}

// pruneHistory keeps only the last maxHistoryPerFile versions per file.
func (s *SpecDir) pruneHistory(f SpecFile) error {
	entries, err := s.History(f)
	if err != nil || len(entries) <= maxHistoryPerFile {
		return nil
	}

	// Remove oldest entries beyond the limit.
	for _, e := range entries[maxHistoryPerFile:] {
		os.Remove(e.Path)
	}
	return nil
}
