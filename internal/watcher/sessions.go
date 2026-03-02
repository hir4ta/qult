package watcher

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SessionInfo holds metadata about a session file.
type SessionInfo struct {
	Path      string
	SessionID string
	Project   string
	ModTime   time.Time
	Size      int64
}

// ListSessions returns all session JSONL files sorted by modification time (newest first).
func ListSessions(claudeHome string) ([]SessionInfo, error) {
	projectsDir := filepath.Join(claudeHome, "projects")

	projectEntries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil, err
	}

	var sessions []SessionInfo

	for _, projEntry := range projectEntries {
		if !projEntry.IsDir() {
			continue
		}
		projName := decodeProjectName(projEntry.Name())
		projDir := filepath.Join(projectsDir, projEntry.Name())

		entries, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			sessions = append(sessions, SessionInfo{
				Path:      filepath.Join(projDir, entry.Name()),
				SessionID: strings.TrimSuffix(entry.Name(), ".jsonl"),
				Project:   projName,
				ModTime:   info.ModTime(),
				Size:      info.Size(),
			})
		}
	}

	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].ModTime.After(sessions[j].ModTime)
	})

	return sessions, nil
}

// decodeProjectName converts directory name back to readable path.
// e.g. "-Users-user-Projects-myapp" → "myapp"
func decodeProjectName(dirName string) string {
	parts := strings.Split(dirName, "-")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return dirName
}

// DefaultClaudeHome returns the default path for ~/.claude.
func DefaultClaudeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.Getenv("HOME"), ".claude")
	}
	return filepath.Join(home, ".claude")
}
