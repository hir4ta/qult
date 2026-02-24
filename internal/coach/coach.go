package coach

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/parser"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// Report holds the data sent to claude -p for analysis.
type Report struct {
	SessionID    string         `json:"session_id"`
	Project      string         `json:"project"`
	TurnCount    int            `json:"turns"`
	ToolUseCount int            `json:"tool_uses"`
	ToolFreq     map[string]int `json:"tool_frequency"`
	DurationMin  int            `json:"duration_minutes"`
	SampleEvents []string       `json:"sample_events"`
}

// BuildReport creates an analysis report from a session.
func BuildReport(si watcher.SessionInfo) (*Report, error) {
	detail, err := watcher.LoadSessionDetail(si)
	if err != nil {
		return nil, err
	}

	stats := analyzer.NewStats()
	for _, ev := range detail.Events {
		stats.Update(ev)
	}

	// Collect sample events (last 30 user + tool events)
	var samples []string
	count := 0
	for i := len(detail.Events) - 1; i >= 0 && count < 30; i-- {
		ev := detail.Events[i]
		switch ev.Type {
		case parser.EventUserMessage:
			samples = append(samples, fmt.Sprintf("[user] %s", parser.Truncate(ev.UserText, 100)))
			count++
		case parser.EventToolUse:
			samples = append(samples, fmt.Sprintf("[tool] %s: %s", ev.ToolName, parser.Truncate(ev.ToolInput, 80)))
			count++
		}
	}
	// Reverse to chronological order
	for i, j := 0, len(samples)-1; i < j; i, j = i+1, j-1 {
		samples[i], samples[j] = samples[j], samples[i]
	}

	elapsed := time.Duration(0)
	if !detail.Stats.FirstTime.IsZero() && !detail.Stats.LastTime.IsZero() {
		elapsed = detail.Stats.LastTime.Sub(detail.Stats.FirstTime)
	}

	return &Report{
		SessionID:    si.SessionID[:8],
		Project:      si.Project,
		TurnCount:    detail.Stats.TurnCount,
		ToolUseCount: detail.Stats.ToolUseCount,
		ToolFreq:     detail.Stats.ToolFreq,
		DurationMin:  int(elapsed.Minutes()),
		SampleEvents: samples,
	}, nil
}

// Analyze sends the report to claude -p and returns the AI analysis.
func Analyze(ctx context.Context, report *Report, lang locale.Lang) (string, error) {
	reportJSON, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal report: %w", err)
	}

	prompt := fmt.Sprintf(`You are a Claude Code usage coach. Analyze this session data and provide actionable feedback in %s.

Session Data:
%s

Please provide:
1. What's being done well (2-3 points)
2. Specific improvement suggestions (3-5 items)
3. Recommended configuration changes (CLAUDE.md, skills, agents suggestions if applicable)
4. Overall score (out of 5) with a brief comment

Keep it concise and practical.`, lang.Name, string(reportJSON))

	cmd := exec.CommandContext(ctx, "claude", "-p", prompt)
	cmd.Dir = os.TempDir() // Avoid creating session files in the watched project
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("claude -p failed: %w", err)
	}

	return strings.TrimSpace(string(out)), nil
}
