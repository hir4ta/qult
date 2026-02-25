package hookhandler

import (
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// HookDetector is a lightweight detector backed by session DB state.
type HookDetector struct {
	sdb *sessiondb.SessionDB
}

// Detect runs lightweight pattern detection and enqueues nudges.
func (d *HookDetector) Detect() {
	d.detectRetryLoop()
	d.detectExcessiveTools()
	d.detectFileReadLoop()
	d.detectExploreLoop()
}

// detectRetryLoop checks for 3+ consecutive identical tool calls.
func (d *HookDetector) detectRetryLoop() {
	events, err := d.sdb.RecentEvents(5)
	if err != nil || len(events) < 3 {
		return
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
		return
	}

	on, _ := d.sdb.IsOnCooldown("retry_loop")
	if on {
		return
	}

	_ = d.sdb.EnqueueNudge(
		"retry-loop", "warn",
		first.ToolName+" retried "+itoa(consecutive)+" times consecutively",
		"The same operation keeps failing — describe the error cause or try a different approach",
	)
	_ = d.sdb.SetCooldown("retry_loop", 3*time.Minute)
}

// detectExcessiveTools checks for 25+ tool calls without user input.
func (d *HookDetector) detectExcessiveTools() {
	tc, _, _, err := d.sdb.BurstState()
	if err != nil || tc < 25 {
		return
	}

	// Only fire at thresholds to avoid repeated nudges.
	if tc != 25 && tc != 40 {
		return
	}

	on, _ := d.sdb.IsOnCooldown("excessive_tools")
	if on {
		return
	}

	level := "warn"
	if tc >= 40 {
		level = "action"
	}

	_ = d.sdb.EnqueueNudge(
		"excessive-tools", level,
		itoa(tc)+" tool calls without user input",
		"Press Esc to check progress and provide direction",
	)
	_ = d.sdb.SetCooldown("excessive_tools", 5*time.Minute)
}

// detectFileReadLoop checks for the same file being read 5+ times.
func (d *HookDetector) detectFileReadLoop() {
	_, hasWrite, fileReads, err := d.sdb.BurstState()
	if err != nil || hasWrite {
		return
	}

	for path, count := range fileReads {
		if count < 5 {
			continue
		}

		key := "file_read_loop:" + path
		on, _ := d.sdb.IsOnCooldown(key)
		if on {
			continue
		}

		_ = d.sdb.EnqueueNudge(
			"file-read-loop", "warn",
			path+" read "+itoa(count)+" times (no edits)",
			"Tell Claude specifically what to change in this file",
		)
		_ = d.sdb.SetCooldown(key, 5*time.Minute)
		return // One nudge per detection cycle.
	}
}

// detectExploreLoop checks for prolonged read-only exploration.
func (d *HookDetector) detectExploreLoop() {
	tc, hasWrite, _, err := d.sdb.BurstState()
	if err != nil || hasWrite || tc < 10 {
		return
	}

	startTime, err := d.sdb.BurstStartTime()
	if err != nil || startTime.IsZero() {
		return
	}

	elapsed := time.Since(startTime)
	if elapsed < 5*time.Minute {
		return
	}

	on, _ := d.sdb.IsOnCooldown("explore_loop")
	if on {
		return
	}

	_ = d.sdb.EnqueueNudge(
		"explore-loop", "tip",
		itoa(int(elapsed.Minutes()))+"m exploring with no writes",
		"Give a concrete action — specify target files and what to change",
	)
	_ = d.sdb.SetCooldown("explore_loop", 5*time.Minute)
}

func itoa(n int) string {
	if n < 0 {
		return "-" + itoa(-n)
	}
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
