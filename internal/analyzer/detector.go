package analyzer

import (
	"hash/fnv"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// FeedbackKind distinguishes proposals (early hints) from full alerts.
type FeedbackKind int

const (
	KindAlert    FeedbackKind = iota // standard alert (Warning/Action)
	KindProposal                     // early hint before pattern escalates
)

// AlertGroup groups related patterns for deduplication.
// Within a group, only the highest-priority alert is shown.
type AlertGroup int

const (
	GroupSafety      AlertGroup = iota // destructive-cmd
	GroupRecovery                      // compact-amnesia, rate-limit-stuck
	GroupExecution                     // retry-loop, test-fail-cycle, apologize-retry
	GroupExploration                   // excessive-tools, explore-loop, file-read-loop
	GroupContext                       // context-thrashing
)

// PatternType represents an anti-pattern detected in a Claude Code session.
type PatternType int

const (
	PatternRetryLoop        PatternType = iota // same tool+input 3+ times consecutively
	PatternCompactAmnesia                      // re-reading same files after compact
	PatternExcessiveTools                      // deprecated: no longer detected
	PatternDestructiveCmd                      // rm -rf, git push --force, etc.
	PatternFileReadLoop                        // deprecated: no longer detected
	PatternContextThrashing                    // 2+ compacts in 15 minutes
	PatternTestFailCycle                       // test->edit->test fail 3+ cycles
	PatternApologizeRetry                      // apologize + same approach 3+ times
	PatternExploreLoop                         // 10+ min of Read/Grep only, no Write/Edit
	PatternRateLimitStuck                      // rate limit text + no progress for 5 min
)

// Alert represents a detected anti-pattern.
type Alert struct {
	Pattern     PatternType
	Kind        FeedbackKind  // KindAlert (default) or KindProposal
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

// FeatureTracker tracks which Claude Code features have been used in the session.
type FeatureTracker struct {
	PlanModeUsed   bool
	PlanModeActive bool // currently in Plan Mode (toggled by Enter/ExitPlanMode)
	SubagentActive bool // subagent currently running (toggled by Task/user message)
	CLAUDEMDRead   bool
	SubagentUsed   bool
	SkillUsed      bool
	RulesRead      bool // .claude/rules/ referenced
	HooksUsed      bool // hooks-related events detected
}

// AlertOutcome records what happened after an alert was shown.
type AlertOutcome struct {
	Pattern     PatternType
	Level       FeedbackLevel
	FiredAt     time.Time
	ResolvedAt  time.Time
	Resolved    bool   // true if pattern did not recur
	Description string // human-readable outcome
}

// Detector detects anti-patterns in Claude Code sessions.
type Detector struct {
	window     []EventFingerprint
	windowSize int
	pos        int
	count      int

	features FeatureTracker

	burst      BurstTracker
	compaction CompactionTracker
	cooldowns  map[PatternType]time.Time
	alerts     []Alert
	outcomes   []AlertOutcome

	// Pending resolution: alerts waiting for outcome check
	pendingResolutions []pendingResolution
	newOutcomeIdx      int // index into outcomes for PopNewOutcomes

	// For apologize-retry detection
	recentApologies          int
	lastApologyTime          time.Time
	assistantTurnsSinceReset int

	// For test-fail cycle detection
	testCycleCount int
	lastEditSeen   bool
}

type pendingResolution struct {
	alert       Alert
	eventsAfter int // events counted since user intervention
}

const windowCapacity = 50

// Cooldown durations per feedback level.
const (
	cooldownProposal = 2 * time.Minute
	cooldownInfo     = 3 * time.Minute
	cooldownWarning  = 5 * time.Minute
	cooldownAction   = 10 * time.Minute
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
		d.checkResolutions(fp.Timestamp)
		d.resetBurst(fp.Timestamp)
	}

	// Track compaction state
	if fp.IsCompact {
		d.handleCompact(fp.Timestamp)
	}

	// Track Claude Code feature usage
	d.trackFeatures(ev)

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

	// Update pending resolution counters
	for i := range d.pendingResolutions {
		d.pendingResolutions[i].eventsAfter++
	}

	// Run all detectors
	var newAlerts []Alert

	if a := d.detectRetryLoop(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectCompactAmnesia(); a != nil {
		newAlerts = append(newAlerts, *a)
	}
	if a := d.detectDestructiveCmd(ev); a != nil {
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
			// Allow escalation: proposal→alert or higher severity bypasses cooldown
			lastKind, lastLevel := d.lastAlertKindLevel(a.Pattern)
			escalation := (a.Kind == KindAlert && lastKind == KindProposal) || a.Level > lastLevel
			if !escalation {
				continue
			}
		}
		d.setCooldown(a.Pattern, a.Level, now)
		a.Timestamp = now
		filtered = append(filtered, a)
		d.alerts = append(d.alerts, a)
		d.pendingResolutions = append(d.pendingResolutions, pendingResolution{alert: a})
	}

	// Trim alerts to prevent unbounded growth
	if len(d.alerts) > 50 {
		d.alerts = d.alerts[len(d.alerts)-50:]
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

// Features returns the tracked feature usage state.
func (d *Detector) Features() FeatureTracker {
	return d.features
}

// RecentOutcomes returns alert outcomes from the last 10 resolutions.
func (d *Detector) RecentOutcomes() []AlertOutcome {
	if len(d.outcomes) <= 10 {
		return d.outcomes
	}
	return d.outcomes[len(d.outcomes)-10:]
}

// PopNewOutcomes returns outcomes added since the last call and clears them.
func (d *Detector) PopNewOutcomes() []AlertOutcome {
	if d.newOutcomeIdx >= len(d.outcomes) {
		return nil
	}
	out := make([]AlertOutcome, len(d.outcomes)-d.newOutcomeIdx)
	copy(out, d.outcomes[d.newOutcomeIdx:])
	d.newOutcomeIdx = len(d.outcomes)
	return out
}


// trackFeatures detects Claude Code feature usage from events.
func (d *Detector) trackFeatures(ev parser.SessionEvent) {
	switch ev.Type {
	case parser.EventUserMessage:
		// User turn resets subagent active state.
		d.features.SubagentActive = false
	case parser.EventToolUse:
		switch ev.ToolName {
		case "EnterPlanMode":
			d.features.PlanModeUsed = true
			d.features.PlanModeActive = true
		case "ExitPlanMode":
			d.features.PlanModeActive = false
		case "Task":
			d.features.SubagentUsed = true
			d.features.SubagentActive = true
		case "Skill":
			d.features.SkillUsed = true
		case "Read":
			if strings.Contains(ev.ToolInput, "CLAUDE.md") {
				d.features.CLAUDEMDRead = true
			}
			if strings.Contains(ev.ToolInput, ".claude/rules/") {
				d.features.RulesRead = true
			}
			if strings.Contains(ev.ToolInput, ".claude/settings") {
				d.features.HooksUsed = true
			}
		}
	case parser.EventAgentSpawn:
		d.features.SubagentUsed = true
		d.features.SubagentActive = true
	case parser.EventPlanApproval:
		d.features.PlanModeUsed = true
		d.features.PlanModeActive = false
	}
}

// checkResolutions checks pending alerts for resolution when user intervenes.
func (d *Detector) checkResolutions(ts time.Time) {
	if len(d.pendingResolutions) == 0 {
		return
	}

	var remaining []pendingResolution
	for _, pr := range d.pendingResolutions {
		if pr.eventsAfter < 5 {
			remaining = append(remaining, pr) // keep for next check
			continue
		}

		// Check if the same pattern fired AFTER this alert (recurrence).
		recurred := false
		for _, a := range d.alerts {
			if a.Pattern == pr.alert.Pattern && a.Timestamp.After(pr.alert.Timestamp) {
				recurred = true
				break
			}
		}

		outcome := AlertOutcome{
			Pattern:    pr.alert.Pattern,
			Level:      pr.alert.Level,
			FiredAt:    pr.alert.Timestamp,
			ResolvedAt: ts,
		}

		if recurred {
			outcome.Resolved = false
			outcome.Description = PatternName(pr.alert.Pattern) + " persisted"
		} else {
			outcome.Resolved = true
			outcome.Description = PatternName(pr.alert.Pattern) + " resolved"
		}

		d.outcomes = append(d.outcomes, outcome)
	}

	// Keep only last 20 outcomes
	if len(d.outcomes) > 20 {
		d.outcomes = d.outcomes[len(d.outcomes)-20:]
	}

	d.pendingResolutions = remaining
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

// lastAlertKindLevel returns the kind and level of the most recent alert for a pattern.
func (d *Detector) lastAlertKindLevel(p PatternType) (FeedbackKind, FeedbackLevel) {
	for i := len(d.alerts) - 1; i >= 0; i-- {
		if d.alerts[i].Pattern == p {
			return d.alerts[i].Kind, d.alerts[i].Level
		}
	}
	return KindAlert, FeedbackLevel(-1)
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
	case LevelInfo:
		return cooldownProposal
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
