package store

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/parser"
	"github.com/hir4ta/claude-alfred/internal/watcher"
)

// SyncSession syncs a single JSONL file to the database.
// It reads from the previously synced offset and inserts new events.
func (s *Store) SyncSession(jsonlPath string) error {
	sess, err := s.FindSessionByJSONLPath(jsonlPath)
	if err != nil {
		return fmt.Errorf("store: sync find session: %w", err)
	}

	sessionID := extractSessionID(jsonlPath)
	projectPath, projectName := extractProjectInfo(jsonlPath)

	if sess == nil {
		sess = &SessionRow{
			ID:          sessionID,
			ProjectPath: projectPath,
			ProjectName: projectName,
			JSONLPath:   jsonlPath,
		}
		if err := s.UpsertSession(sess); err != nil {
			return err
		}
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		return fmt.Errorf("store: open jsonl: %w", err)
	}
	defer f.Close()

	if sess.SyncedOffset > 0 {
		if _, err := f.Seek(sess.SyncedOffset, io.SeekStart); err != nil {
			return fmt.Errorf("store: seek: %w", err)
		}
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	offset := sess.SyncedOffset
	compactSegment := sess.CompactCount
	turnCount := sess.TurnCount
	toolUseCount := sess.ToolUseCount
	var firstEventAt, lastEventAt string
	var firstPrompt string
	var lastUserText string

	if sess.FirstEventAt != "" {
		firstEventAt = sess.FirstEventAt
	}
	if sess.LastEventAt != "" {
		lastEventAt = sess.LastEventAt
	}
	if sess.FirstPrompt != "" {
		firstPrompt = sess.FirstPrompt
	}

	for scanner.Scan() {
		line := scanner.Text()
		lineLen := int64(len(line)) + 1 // +1 for newline

		pl := parser.ParseLineRaw(line)

		for _, ev := range pl.Events {
			ts := ev.Timestamp.UTC().Format(time.RFC3339)
			if !ev.Timestamp.IsZero() {
				if firstEventAt == "" || ts < firstEventAt {
					firstEventAt = ts
				}
				if ts > lastEventAt {
					lastEventAt = ts
				}
			}

			switch ev.Type {
			case parser.EventCompactBoundary:
				if err := s.InsertCompactEvent(&CompactEventRow{
					SessionID:    sess.ID,
					SegmentIndex: compactSegment,
					SummaryText:  ev.AssistantText,
					Timestamp:    ts,
					PreTurnCount: turnCount,
					PreToolCount: toolUseCount,
				}); err != nil {
					return err
				}
				compactSegment++

			case parser.EventUserMessage:
				turnCount++
				if ev.UserText != "" {
					lastUserText = ev.UserText
				}
				if firstPrompt == "" && ev.UserText != "" && !ev.IsAnswer {
					text := ev.UserText
					runes := []rune(text)
					if len(runes) > 80 {
						text = string(runes[:80])
					}
					firstPrompt = text
				}
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					UserText:       ev.UserText,
					RawJSON:        pl.RawJSON,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

			case parser.EventToolUse:
				toolUseCount++
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					ToolName:       ev.ToolName,
					ToolInput:      ev.ToolInput,
					RawJSON:        pl.RawJSON,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

			case parser.EventAssistantText:
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					AssistantText:  ev.AssistantText,
					RawJSON:        pl.RawJSON,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

				// Extract design decisions from assistant text.
				if ev.AssistantText != "" {
					decisions := ExtractDecisions(ev.AssistantText, lastUserText, ts)
					for i := range decisions {
						decisions[i].SessionID = sess.ID
						decisions[i].CompactSegment = compactSegment
						_ = s.InsertDecision(&decisions[i])
					}
				}

			case parser.EventTaskCreate, parser.EventTaskUpdate:
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					TaskID:         ev.TaskID,
					TaskSubject:    ev.TaskSubject,
					TaskStatus:     ev.TaskStatus,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

			case parser.EventAgentSpawn:
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					AgentName:      ev.AgentName,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

			case parser.EventPlanApproval:
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					PlanTitle:      ev.PlanTitle,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}

			default:
				if _, err := s.InsertEvent(&EventRow{
					SessionID:      sess.ID,
					EventType:      int(ev.Type),
					Timestamp:      ts,
					ByteOffset:     offset,
					CompactSegment: compactSegment,
				}); err != nil {
					return err
				}
			}
		}

		offset += lineLen
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("store: scan jsonl: %w", err)
	}

	// Update session stats
	sess.FirstEventAt = firstEventAt
	sess.LastEventAt = lastEventAt
	sess.FirstPrompt = firstPrompt
	sess.TurnCount = turnCount
	sess.ToolUseCount = toolUseCount
	sess.CompactCount = compactSegment
	sess.SyncedOffset = offset
	sess.SyncedAt = time.Now().UTC().Format(time.RFC3339)

	if err := s.UpsertSession(sess); err != nil {
		return err
	}

	return nil
}

// SyncAll discovers all sessions and syncs them, then estimates chains.
func (s *Store) SyncAll() error {
	return s.SyncAllWithProgress(time.Time{}, nil)
}

// SyncAllWithProgress is like SyncAll but calls progressFn after each session.
// If since is non-zero, only sessions modified after since are synced.
func (s *Store) SyncAllWithProgress(since time.Time, progressFn func(done, total int)) error {
	claudeHome := watcher.DefaultClaudeHome()
	sessions, err := watcher.ListSessions(claudeHome)
	if err != nil {
		return fmt.Errorf("store: list sessions: %w", err)
	}

	if !since.IsZero() {
		filtered := sessions[:0]
		for _, si := range sessions {
			if !si.ModTime.Before(since) {
				filtered = append(filtered, si)
			}
		}
		sessions = filtered
	}

	total := len(sessions)
	for i, si := range sessions {
		if err := s.SyncSession(si.Path); err != nil {
			fmt.Fprintf(os.Stderr, "store: sync %s: %v\n", si.Path, err)
			continue
		}
		if progressFn != nil {
			progressFn(i+1, total)
		}
	}

	return s.EstimateSessionChains()
}

// extractSessionID extracts the session UUID from the JSONL file path.
// e.g. "/path/to/abc-def-123.jsonl" → "abc-def-123"
func extractSessionID(jsonlPath string) string {
	base := filepath.Base(jsonlPath)
	return strings.TrimSuffix(base, ".jsonl")
}

// extractProjectInfo extracts the project path and name from the JSONL path.
// Path format: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
func extractProjectInfo(jsonlPath string) (projectPath, projectName string) {
	dir := filepath.Dir(jsonlPath)
	dirName := filepath.Base(dir)

	// Decode project path: "-Users-user-Projects-myapp" → "/Users/user/Projects/myapp"
	if strings.HasPrefix(dirName, "-") || strings.Contains(dirName, "-") {
		parts := strings.Split(dirName, "-")
		projectPath = "/" + strings.Join(parts[1:], "/")
		if len(parts) > 0 {
			projectName = parts[len(parts)-1]
		}
	}
	if projectName == "" {
		projectName = dirName
	}
	if projectPath == "" {
		projectPath = dir
	}
	return
}
