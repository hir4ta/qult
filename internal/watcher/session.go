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

	// Deduplicate resumed sessions: within the same project, sessions sharing
	// the same FirstPrompt are likely resume chains. Keep only the most recent
	// (already sorted newest-first).
	all = deduplicateByPrompt(all)

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

// deduplicateByPrompt removes resumed session duplicates.
// When Claude Code resumes a session, it creates a new JSONL file with the same
// first user message. This function merges sessions that share the same
// (project, FirstPrompt) and have ModTimes within 30 minutes of each other.
// Input must be sorted newest-first; the most recent entry per group is kept.
func deduplicateByPrompt(sessions []RecentSession) []RecentSession {
	// Resume creates a new JSONL within seconds of the previous one.
	// 5 minutes is generous enough for resume while avoiding false merges.
	const resumeWindow = 5 * time.Minute

	type key struct {
		project string
		prompt  string
	}
	// Track the last-seen ModTime per group to propagate resume chains.
	// Updated on every session (not just kept ones) so that A→B→C chains
	// where each hop is < 5min are fully collapsed even if A-to-C > 5min.
	lastSeen := make(map[key]time.Time)
	result := make([]RecentSession, 0, len(sessions))

	for _, s := range sessions {
		if s.FirstPrompt == "" {
			result = append(result, s)
			continue
		}
		k := key{project: s.Project, prompt: s.FirstPrompt}
		if prev, ok := lastSeen[k]; ok && prev.Sub(s.ModTime) < resumeWindow {
			// Close in time to a newer session with same prompt — resume duplicate.
			lastSeen[k] = s.ModTime // propagate chain
			continue
		}
		lastSeen[k] = s.ModTime
		result = append(result, s)
	}
	return result
}

// DefaultClaudeHome returns the default path for ~/.claude.
func DefaultClaudeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.Getenv("HOME"), ".claude")
	}
	return filepath.Join(home, ".claude")
}
