package watcher

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// RecentSession holds info about a session, sorted by modification time.
type RecentSession struct {
	Path        string
	SessionID   string
	Project     string
	ModTime     time.Time
	FirstPrompt string // first ~30 chars of the first user message
}

// FindRecentSessions returns the most recently modified sessions, sorted newest first.
// Returns at most maxResults sessions.
func FindRecentSessions(claudeHome string, maxResults int) ([]RecentSession, error) {
	projectsDir := filepath.Join(claudeHome, "projects")

	projectEntries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil, fmt.Errorf("read projects dir: %w", err)
	}

	var all []RecentSession

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
			all = append(all, RecentSession{
				Path:      filepath.Join(projDir, entry.Name()),
				SessionID: strings.TrimSuffix(entry.Name(), ".jsonl"),
				Project:   projName,
				ModTime:   info.ModTime(),
			})
		}
	}

	sort.Slice(all, func(i, j int) bool {
		return all[i].ModTime.After(all[j].ModTime)
	})

	if maxResults > 0 && len(all) > maxResults {
		all = all[:maxResults]
	}

	// Extract first user prompt for each session (lightweight: stop at first match)
	for i := range all {
		all[i].FirstPrompt = extractFirstPrompt(all[i].Path)
	}

	return all, nil
}

// extractFirstPrompt reads a JSONL file and returns the first user message text,
// truncated to ~30 runes. Reads only until the first user message is found.
func extractFirstPrompt(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, scanBufInitSize), scanBufMaxSize)
	for scanner.Scan() {
		events, err := parser.ParseLine(scanner.Bytes())
		if err != nil {
			continue
		}
		for _, ev := range events {
			if ev.Type == parser.EventUserMessage && ev.UserText != "" && !ev.IsAnswer {
				text := strings.ReplaceAll(ev.UserText, "\n", " ")
				runes := []rune(text)
				if len(runes) > 30 {
					return string(runes[:30]) + "..."
				}
				return text
			}
		}
	}
	return ""
}

// DefaultClaudeHome returns the default path for ~/.claude.
func DefaultClaudeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.Getenv("HOME"), ".claude")
	}
	return filepath.Join(home, ".claude")
}
