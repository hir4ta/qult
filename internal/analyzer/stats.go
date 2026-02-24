package analyzer

import (
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// Stats tracks live session statistics.
type Stats struct {
	TurnCount    int
	ToolUseCount int
	ToolFreq     map[string]int
	StartTime    time.Time
	LastActivity time.Time

	// Performance metrics
	AssistantMsgCount int           // number of assistant text messages
	LongestPause      time.Duration // longest gap between consecutive events
	lastEventTime     time.Time     // previous event timestamp (unexported)
}

// NewStats creates a Stats with initialized maps.
func NewStats() Stats {
	return Stats{
		ToolFreq: make(map[string]int),
	}
}

// Update processes a new event and updates the statistics.
func (s *Stats) Update(ev parser.SessionEvent) {
	if s.StartTime.IsZero() && !ev.Timestamp.IsZero() {
		s.StartTime = ev.Timestamp
	}
	if !ev.Timestamp.IsZero() {
		// Track longest pause between events
		if !s.lastEventTime.IsZero() {
			gap := ev.Timestamp.Sub(s.lastEventTime)
			if gap > s.LongestPause {
				s.LongestPause = gap
			}
		}
		s.lastEventTime = ev.Timestamp
		s.LastActivity = ev.Timestamp
	}

	switch ev.Type {
	case parser.EventUserMessage:
		s.TurnCount++
	case parser.EventToolUse:
		s.ToolUseCount++
		if ev.ToolName != "" {
			s.ToolFreq[ev.ToolName]++
		}
	case parser.EventAssistantText:
		s.AssistantMsgCount++
	}
}

// ToolsPerTurn returns the average number of tool uses per turn.
func (s *Stats) ToolsPerTurn() float64 {
	if s.TurnCount == 0 {
		return 0
	}
	return float64(s.ToolUseCount) / float64(s.TurnCount)
}

// Elapsed returns the duration since the session started.
func (s *Stats) Elapsed() time.Duration {
	if s.StartTime.IsZero() {
		return 0
	}
	if s.LastActivity.IsZero() {
		return time.Since(s.StartTime)
	}
	return s.LastActivity.Sub(s.StartTime)
}

// TopTools returns the top N most used tools sorted by frequency.
func (s *Stats) TopTools(n int) []ToolCount {
	if len(s.ToolFreq) == 0 {
		return nil
	}

	var counts []ToolCount
	for name, count := range s.ToolFreq {
		counts = append(counts, ToolCount{Name: name, Count: count})
	}

	// Simple sort (small N)
	for i := 0; i < len(counts); i++ {
		for j := i + 1; j < len(counts); j++ {
			if counts[j].Count > counts[i].Count {
				counts[i], counts[j] = counts[j], counts[i]
			}
		}
	}

	if n > len(counts) {
		n = len(counts)
	}
	return counts[:n]
}

// ToolCount is a tool name with its use count.
type ToolCount struct {
	Name  string
	Count int
}
