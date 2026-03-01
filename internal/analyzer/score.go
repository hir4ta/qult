package analyzer

import (
	"strings"

	"github.com/hir4ta/claude-alfred/internal/parser"
)

// UsageScore holds the live usage quality score and its breakdown.
type UsageScore struct {
	Total      int
	Label      string
	Components ScoreBreakdown
}

// ScoreBreakdown details each component of the usage score.
type ScoreBreakdown struct {
	AlertPenalty    int
	ToolEfficiency  int
	PlanMode        int
	CLAUDEMD        int
	Subagent        int
	ContextMgmt     int
	InstructionQual int
}

// ScoreCalculator computes a live usage quality score from session events.
type ScoreCalculator struct {
	alertPenalty   int
	toolsThisBurst int
	filesModified  map[string]bool
	planModeUsed   bool
	claudeMDRead   bool
	subagentUsed   bool
	compactCount   int
	userMsgCount   int
	longMsgCount   int // user messages > 50 runes
}

// NewScoreCalculator creates a ScoreCalculator ready for use.
func NewScoreCalculator() *ScoreCalculator {
	return &ScoreCalculator{
		filesModified: make(map[string]bool),
	}
}

const alertPenaltyCap = 50

// Update processes a new event and any alerts it triggered.
func (sc *ScoreCalculator) Update(ev parser.SessionEvent, newAlerts []Alert) {
	for _, a := range newAlerts {
		switch a.Level {
		case LevelWarning:
			sc.alertPenalty += 5
		case LevelAction:
			sc.alertPenalty += 15
		}
		if sc.alertPenalty > alertPenaltyCap {
			sc.alertPenalty = alertPenaltyCap
		}
	}

	switch ev.Type {
	case parser.EventUserMessage:
		sc.userMsgCount++
		if len([]rune(ev.UserText)) > 50 {
			sc.longMsgCount++
		}
		// Reset burst tracking on user turn
		sc.toolsThisBurst = 0
		sc.filesModified = make(map[string]bool)

	case parser.EventToolUse:
		sc.toolsThisBurst++
		switch ev.ToolName {
		case "Write", "Edit":
			sc.filesModified[ev.ToolInput] = true
		case "EnterPlanMode":
			sc.planModeUsed = true
		case "Read":
			if strings.Contains(ev.ToolInput, "CLAUDE.md") {
				sc.claudeMDRead = true
			}
		case "Task":
			sc.subagentUsed = true
		}

	case parser.EventCompactBoundary:
		sc.compactCount++
	}
}

// Score returns the current usage quality score.
func (sc *ScoreCalculator) Score() UsageScore {
	var bd ScoreBreakdown

	// Alert penalty
	bd.AlertPenalty = -sc.alertPenalty

	// Tool efficiency
	switch {
	case sc.toolsThisBurst > 25:
		bd.ToolEfficiency = -10
	case sc.toolsThisBurst > 15:
		bd.ToolEfficiency = -5
	}

	// Plan mode
	if sc.planModeUsed {
		bd.PlanMode = 5
	} else if len(sc.filesModified) >= 5 {
		bd.PlanMode = -10
	}

	// CLAUDE.md
	if sc.claudeMDRead {
		bd.CLAUDEMD = 3
	}

	// Subagent
	if sc.subagentUsed {
		bd.Subagent = 3
	}

	// Context management
	switch {
	case sc.compactCount >= 3:
		bd.ContextMgmt = -15
	case sc.compactCount >= 2:
		bd.ContextMgmt = -5
	}

	// Instruction quality
	if sc.userMsgCount > 3 {
		ratio := float64(sc.longMsgCount) / float64(sc.userMsgCount)
		if ratio > 0.7 {
			bd.InstructionQual = 5
		}
	}

	total := 100 + bd.AlertPenalty + bd.ToolEfficiency + bd.PlanMode +
		bd.CLAUDEMD + bd.Subagent + bd.ContextMgmt + bd.InstructionQual
	if total > 100 {
		total = 100
	}
	if total < 0 {
		total = 0
	}

	label := scoreLabel(total)
	return UsageScore{Total: total, Label: label, Components: bd}
}

func scoreLabel(score int) string {
	switch {
	case score >= 80:
		return "Good"
	case score >= 60:
		return "Fair"
	default:
		return "Needs Work"
	}
}
