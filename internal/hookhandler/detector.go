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
	if sig := d.detectFileHotspot(); sig != "" {
		return sig
	}
	if sig := d.detectPlanModeOpportunity(); sig != "" {
		return sig
	}
	if sig := d.detectCompactionRisk(); sig != "" {
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

// detectFileHotspot warns when the same file has been modified 3+ times in the current burst.
func (d *HookDetector) detectFileHotspot() string {
	events, err := d.sdb.RecentEvents(20)
	if err != nil || len(events) < 3 {
		return ""
	}

	_, _, fileReads, err := d.sdb.BurstState()
	if err != nil {
		return ""
	}

	// Check recent write events for repeated modification of same input hash.
	fileWrites := make(map[uint64]int)
	var hotHash uint64
	maxWrites := 0
	hotTool := ""
	for _, ev := range events {
		if !ev.IsWrite {
			continue
		}
		fileWrites[ev.InputHash]++
		if fileWrites[ev.InputHash] > maxWrites {
			maxWrites = fileWrites[ev.InputHash]
			hotHash = ev.InputHash
			hotTool = ev.ToolName
		}
	}
	_ = hotHash

	if maxWrites < 3 {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("file_hotspot", 5*time.Minute)
	if !set {
		return ""
	}

	// Find the most-read file as likely hotspot context.
	topFile := ""
	topCount := 0
	for f, c := range fileReads {
		if c > topCount {
			topFile = f
			topCount = c
		}
	}

	msg := fmt.Sprintf("[buddy] Signal: Same target modified %d times via %s in this burst.", maxWrites, hotTool)
	if topFile != "" {
		msg += fmt.Sprintf(" Hotspot file: %s (read %dx). Consider running tests to validate changes before further edits.", filepath.Base(topFile), topCount)
	}
	return msg
}

// detectPlanModeOpportunity suggests Plan Mode when 3+ distinct files are modified without it.
func (d *HookDetector) detectPlanModeOpportunity() string {
	if d.inPlanMode() || d.subagentActive() {
		return ""
	}

	events, err := d.sdb.RecentEvents(30)
	if err != nil {
		return ""
	}

	distinctFiles := make(map[uint64]bool)
	for _, ev := range events {
		if ev.IsWrite {
			distinctFiles[ev.InputHash] = true
		}
	}

	if len(distinctFiles) < 3 {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("plan_mode_opportunity", 10*time.Minute)
	if !set {
		return ""
	}

	return fmt.Sprintf(
		"[buddy] Signal: %d distinct files modified in this burst without Plan Mode. Consider using EnterPlanMode to outline approach before continuing multi-file changes.",
		len(distinctFiles),
	)
}

// detectCompactionRisk warns when the session shows signs of approaching context limits.
func (d *HookDetector) detectCompactionRisk() string {
	compacts, err := d.sdb.CompactsInWindow(60)
	if err != nil || compacts == 0 {
		return ""
	}

	tc, _, _, err := d.sdb.BurstState()
	if err != nil {
		return ""
	}

	// High risk: multiple compacts and large current burst.
	if compacts < 2 || tc < 15 {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("compaction_risk", 15*time.Minute)
	if !set {
		return ""
	}

	return fmt.Sprintf(
		"[buddy] Signal: %d compactions in the last hour with %d tools in current burst. Context pressure is high. Consider summarizing key decisions and splitting the session if the task has natural breakpoints.",
		compacts, tc,
	)
}
