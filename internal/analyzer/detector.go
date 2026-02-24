package analyzer

import (
	"hash/fnv"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// PatternType represents an anti-pattern detected in a Claude Code session.
type PatternType int

const (
	PatternRetryLoop        PatternType = iota // same tool+input 3+ times consecutively
	PatternCompactAmnesia                      // re-reading same files after compact
	PatternExcessiveTools                      // 25+ tool calls without user turn
	PatternDestructiveCmd                      // rm -rf, git push --force, etc.
	PatternFileReadLoop                        // same file read 5+ times
	PatternContextThrashing                    // 2+ compacts in 15 minutes
	PatternTestFailCycle                       // test->edit->test fail 3+ cycles
	PatternApologizeRetry                      // apologize + same approach 3+ times
	PatternExploreLoop                         // 5+ min of Read/Grep only, no Write/Edit
	PatternRateLimitStuck                      // rate limit text + no progress for 5 min
)

// Alert represents a detected anti-pattern.
type Alert struct {
	Pattern     PatternType
	Level       FeedbackLevel
	Situation   string
	Observation string
	Suggestion  string
	Timestamp   time.Time
	EventCount  int
}

// EventFingerprint is a lightweight hash of a tool event.
type EventFingerprint struct {
	ToolName  string
	InputHash uint64
	FilePath  string
	Timestamp time.Time
	IsUser    bool
	IsCompact bool
	IsWrite   bool
}

// BurstTracker tracks events between user messages.
type BurstTracker struct {
	toolCount    int
	fileReads    map[string]int
	uniqueFiles  map[string]bool
	hasWrite     bool
	startTime    time.Time
	lastToolTime time.Time
}

// CompactionTracker is a state machine for compact amnesia detection.
type CompactionTracker struct {
	preCompactReads  map[string]bool
	postCompactReads map[string]bool
	inPostCompact    bool
	postCompactCount int
	compactTimes     []time.Time
}

// Detector detects anti-patterns in Claude Code sessions.
type Detector struct {
	window     []EventFingerprint
	windowSize int
	pos        int
	count      int

	burst      BurstTracker
	compaction CompactionTracker
	cooldowns  map[PatternType]time.Time
	alerts     []Alert

	// For apologize-retry detection
	recentApologies          int
	lastApologyTime          time.Time
	assistantTurnsSinceReset int

	// For test-fail cycle detection
	testCycleCount int
	lastTestFile   string
	lastEditSeen   bool
}

const windowCapacity = 50

// Cooldown durations per feedback level.
const (
	cooldownInfo    = 3 * time.Minute
	cooldownWarning = 5 * time.Minute
	cooldownAction  = 10 * time.Minute
)

// NewDetector creates a Detector with initialized state.
func NewDetector() *Detector {
	return &Detector{
		window:     make([]EventFingerprint, windowCapacity),
		windowSize: windowCapacity,
		cooldowns:  make(map[PatternType]time.Time),
		burst: BurstTracker{
			fileReads:   make(map[string]int),
			uniqueFiles: make(map[string]bool),
		},
		compaction: CompactionTracker{
			preCompactReads:  make(map[string]bool),
			postCompactReads: make(map[string]bool),
		},
	}
}

// Update processes a new event and returns any newly detected alerts.
func (d *Detector) Update(ev parser.SessionEvent) []Alert {
	fp := d.fingerprint(ev)
	d.addToWindow(fp)

	// Reset burst tracker on user message
	if fp.IsUser {
		d.resetBurst(fp.Timestamp)
	}

	// Track compaction state
	if fp.IsCompact {
		d.handleCompact(fp.Timestamp)
	}

	// Update burst tracker for tool events
	if ev.Type == parser.EventToolUse {
		d.burst.toolCount++
		d.burst.lastToolTime = fp.Timestamp
		if fp.FilePath != "" {
			d.burst.fileReads[fp.FilePath]++
			d.burst.uniqueFiles[fp.FilePath] = true
		}
		if fp.IsWrite {
			d.burst.hasWrite = true
			// Reset file read counter for written file
			delete(d.burst.fileReads, fp.FilePath)
		}
	}

	// Track post-compact reads
	if d.compaction.inPostCompact && ev.Type == parser.EventToolUse {
		d.compaction.postCompactCount++
		if fp.FilePath != "" && isReadTool(ev.ToolName) {
			d.compaction.postCompactReads[fp.FilePath] = true
		}
	}

	// Track pre-compact reads (always, until compact boundary resets)
	if !d.compaction.inPostCompact && ev.Type == parser.EventToolUse && fp.FilePath != "" && isReadTool(ev.ToolName) {
		d.compaction.preCompactReads[fp.FilePath] = true
	}

	// Run all detectors
	var newAlerts []Alert

	if a := d.detectRetryLoop(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectCompactAmnesia(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectExcessiveTools(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectDestructiveCmd(ev); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectFileReadLoop(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectContextThrashing(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectTestFailCycle(ev); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectApologizeRetry(ev); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectExploreLoop(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectRateLimitStuck(ev); a != nil {
		newAlerts = append(newAlerts, *a)
	}

	// Apply cooldown filtering (allow level escalation)
	var filtered []Alert
	now := ev.Timestamp
	if now.IsZero() {
		now = time.Now()
	}
	for _, a := range newAlerts {
		if d.isOnCooldown(a.Pattern, now) {
			// Allow escalation: if new alert is higher severity, bypass cooldown
			if a.Level <= d.lastAlertLevel(a.Pattern) {
				continue
			}
		}
		d.setCooldown(a.Pattern, a.Level, now)
		a.Timestamp = now
		filtered = append(filtered, a)
		d.alerts = append(d.alerts, a)
	}

	return filtered
}

// ActiveAlerts returns alerts filtered by cooldown.
func (d *Detector) ActiveAlerts() []Alert {
	now := time.Now()
	var active []Alert
	for _, a := range d.alerts {
		cd := cooldownForLevel(a.Level)
		if now.Sub(a.Timestamp) < cd {
			active = append(active, a)
		}
	}
	return active
}

// SessionHealth returns a score from 0.0 to 1.0 based on active alerts.
func (d *Detector) SessionHealth() float64 {
	active := d.ActiveAlerts()
	health := 1.0
	for _, a := range active {
		switch a.Level {
		case LevelWarning:
			health -= 0.1
		case LevelAction:
			health -= 0.2
		}
	}
	if health < 0 {
		health = 0
	}
	return health
}

// PatternName returns a human-readable name for a pattern type.
func PatternName(p PatternType) string {
	switch p {
	case PatternRetryLoop:
		return "retry-loop"
	case PatternCompactAmnesia:
		return "compact-amnesia"
	case PatternExcessiveTools:
		return "excessive-tools"
	case PatternDestructiveCmd:
		return "destructive-cmd"
	case PatternFileReadLoop:
		return "file-read-loop"
	case PatternContextThrashing:
		return "context-thrashing"
	case PatternTestFailCycle:
		return "test-fail-cycle"
	case PatternApologizeRetry:
		return "apologize-retry"
	case PatternExploreLoop:
		return "explore-loop"
	case PatternRateLimitStuck:
		return "rate-limit-stuck"
	default:
		return "unknown"
	}
}

// --- Internal methods ---

func (d *Detector) fingerprint(ev parser.SessionEvent) EventFingerprint {
	fp := EventFingerprint{
		Timestamp: ev.Timestamp,
	}

	switch ev.Type {
	case parser.EventUserMessage:
		fp.IsUser = true
	case parser.EventCompactBoundary:
		fp.IsCompact = true
	case parser.EventToolUse:
		fp.ToolName = ev.ToolName
		fp.InputHash = hashString(ev.ToolInput)
		fp.FilePath = extractFilePath(ev)
		fp.IsWrite = isWriteTool(ev.ToolName)
	}

	return fp
}

func (d *Detector) addToWindow(fp EventFingerprint) {
	d.window[d.pos] = fp
	d.pos = (d.pos + 1) % d.windowSize
	if d.count < d.windowSize {
		d.count++
	}
}

func (d *Detector) resetBurst(ts time.Time) {
	d.burst = BurstTracker{
		fileReads:   make(map[string]int),
		uniqueFiles: make(map[string]bool),
		startTime:   ts,
	}
	d.recentApologies = 0
	d.assistantTurnsSinceReset = 0
	d.lastEditSeen = false
	d.testCycleCount = 0
}

func (d *Detector) handleCompact(ts time.Time) {
	// Save pre-compact reads, start post-compact tracking
	d.compaction.inPostCompact = true
	d.compaction.postCompactReads = make(map[string]bool)
	d.compaction.postCompactCount = 0
	d.compaction.compactTimes = append(d.compaction.compactTimes, ts)

	// Keep only recent compact times (last 10)
	if len(d.compaction.compactTimes) > 10 {
		d.compaction.compactTimes = d.compaction.compactTimes[len(d.compaction.compactTimes)-10:]
	}
}

// getRecentFingerprints returns the last n fingerprints from the ring buffer (newest first).
func (d *Detector) getRecentFingerprints(n int) []EventFingerprint {
	if n > d.count {
		n = d.count
	}
	result := make([]EventFingerprint, n)
	for i := range n {
		idx := (d.pos - 1 - i + d.windowSize) % d.windowSize
		result[i] = d.window[idx]
	}
	return result
}

// --- Cooldown helpers ---

func (d *Detector) isOnCooldown(p PatternType, now time.Time) bool {
	expiry, ok := d.cooldowns[p]
	if !ok {
		return false
	}
	return now.Before(expiry)
}

// lastAlertLevel returns the level of the most recent alert for a pattern, or -1 if none.
func (d *Detector) lastAlertLevel(p PatternType) FeedbackLevel {
	for i := len(d.alerts) - 1; i >= 0; i-- {
		if d.alerts[i].Pattern == p {
			return d.alerts[i].Level
		}
	}
	return FeedbackLevel(-1)
}

func (d *Detector) setCooldown(p PatternType, level FeedbackLevel, now time.Time) {
	d.cooldowns[p] = now.Add(cooldownForLevel(level))
}

func cooldownForLevel(level FeedbackLevel) time.Duration {
	switch level {
	case LevelAction:
		return cooldownAction
	case LevelWarning:
		return cooldownWarning
	default:
		return cooldownInfo
	}
}

// --- Utility helpers ---

func hashString(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

func extractFilePath(ev parser.SessionEvent) string {
	switch ev.ToolName {
	case "Read", "Write", "Edit":
		return ev.ToolInput
	}
	return ""
}

func isReadTool(name string) bool {
	return name == "Read" || name == "Grep" || name == "Glob"
}

func isWriteTool(name string) bool {
	return name == "Write" || name == "Edit"
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
