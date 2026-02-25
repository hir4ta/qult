package hookhandler

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// HookDetector is a lightweight detector backed by session DB state.
type HookDetector struct {
	sdb *sessiondb.SessionDB
}

// Detect runs lightweight signal detection and returns a context string
// for Claude to evaluate. Returns "" if no signal detected.
func (d *HookDetector) Detect() string {
	if sig := d.detectRetryLoop(); sig != "" {
		return sig
	}
	if sig := d.detectNoProgress(); sig != "" {
		return sig
	}
	return ""
}

// inPlanMode returns true if the session is currently in Plan Mode.
func (d *HookDetector) inPlanMode() bool {
	v, _ := d.sdb.GetContext("plan_mode")
	return v == "active"
}

// subagentActive returns true if a subagent (Task) is currently running.
func (d *HookDetector) subagentActive() bool {
	v, _ := d.sdb.GetContext("subagent_active")
	return v == "true"
}

// detectRetryLoop checks for consecutive identical tool calls.
// Fires a signal at 3 retries, stronger signal at 5+.
func (d *HookDetector) detectRetryLoop() string {
	events, err := d.sdb.RecentEvents(6)
	if err != nil || len(events) < 3 {
		return ""
	}

	consecutive := 1
	first := events[0]
	for i := 1; i < len(events); i++ {
		if events[i].ToolName == first.ToolName && events[i].InputHash == first.InputHash {
			consecutive++
		} else {
			break
		}
	}

	if consecutive < 3 {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("retry_loop", 5*time.Minute)
	if !set {
		return ""
	}

	return fmt.Sprintf(
		"[buddy] Signal: %s has been called %d times with identical input. The last %d attempts produced the same result.",
		first.ToolName, consecutive, consecutive,
	)
}

// detectNoProgress checks for prolonged activity without file modifications.
// Suppressed during Plan Mode and subagent execution.
func (d *HookDetector) detectNoProgress() string {
	if d.inPlanMode() || d.subagentActive() {
		return ""
	}

	tc, hasWrite, fileReads, err := d.sdb.BurstState()
	if err != nil || hasWrite || tc < 5 {
		return ""
	}

	startTime, err := d.sdb.BurstStartTime()
	if err != nil || startTime.IsZero() {
		return ""
	}

	elapsed := time.Since(startTime)
	if elapsed < 8*time.Minute {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("no_progress", 5*time.Minute)
	if !set {
		return ""
	}

	minutes := int(elapsed.Minutes())
	topFile, topCount := "", 0
	for f, c := range fileReads {
		if c > topCount {
			topFile, topCount = f, c
		}
	}

	msg := fmt.Sprintf("[buddy] Signal: %d minutes elapsed with %d tool calls and no file modifications.", minutes, tc)
	if topFile != "" {
		msg += fmt.Sprintf(" Most-read file: %s (%dx).", filepath.Base(topFile), topCount)
	}
	return msg
}
