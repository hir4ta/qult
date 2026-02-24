package watcher

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// SessionInfo holds metadata about a session file.
type SessionInfo struct {
	Path      string
	SessionID string
	Project   string
	ModTime   time.Time
	Size      int64
}

// SessionDetail holds parsed session data for browse mode.
type SessionDetail struct {
	Info   SessionInfo
	Events []parser.SessionEvent
	Stats  SessionStats
}

// SessionStats is a summary of a session.
type SessionStats struct {
	TurnCount    int
	ToolUseCount int
	ToolFreq     map[string]int
	FirstTime    time.Time
	LastTime     time.Time
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

// LoadSessionDetail reads and parses a full session.
func LoadSessionDetail(si SessionInfo) (*SessionDetail, error) {
	events, _, err := readExisting(si.Path)
	if err != nil {
		return nil, err
	}

	stats := SessionStats{
		ToolFreq: make(map[string]int),
	}
	for _, ev := range events {
		if !ev.Timestamp.IsZero() {
			if stats.FirstTime.IsZero() || ev.Timestamp.Before(stats.FirstTime) {
				stats.FirstTime = ev.Timestamp
			}
			if ev.Timestamp.After(stats.LastTime) {
				stats.LastTime = ev.Timestamp
			}
		}
		switch ev.Type {
		case parser.EventUserMessage:
			stats.TurnCount++
		case parser.EventToolUse:
			stats.ToolUseCount++
			stats.ToolFreq[ev.ToolName]++
		}
	}

	return &SessionDetail{
		Info:   si,
		Events: events,
		Stats:  stats,
	}, nil
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
