package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

type sessionStartInput struct {
	CommonInput
	Source    string `json:"source"`
	Model     string `json:"model"`
	AgentType string `json:"agent_type,omitempty"`
}

func handleSessionStart(input []byte) (*HookOutput, error) {
	var in sessionStartInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Create/open session DB.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		return nil, fmt.Errorf("open session db: %w", err)
	}
	defer sdb.Close()

	// Store CWD for later hooks (PostCompactResume, git context, etc.).
	_ = sdb.SetContext("cwd", in.CWD)

	// Agent sessions (spawned by Agent tool): minimal setup only.
	// Skip embedder probe, git context, coverage map, orphan recovery, and resume.
	// These short-lived sessions don't benefit from monitoring and would otherwise
	// cause CPU spikes when multiple agents run in parallel.
	if in.AgentType != "" {
		_ = sdb.SetContext("is_agent_session", "true")
		return nil, nil
	}

	// Capture git context (branch, dirty files) for later hooks.
	captureGitContext(sdb, in.CWD)

	// Detect Claude Code feature usage and cache for later hooks/MCP.
	CacheFeatureUsage(sdb, in.CWD)

	// Recover orphaned session DBs from previous sessions that didn't get
	// a clean SessionEnd. Extracts their knowledge before destroying them.
	if recovered := RecoverOrphanedSessions(in.SessionID, in.CWD); recovered > 0 {
		fmt.Fprintf(os.Stderr, "[alfred] Recovered %d orphaned session(s)\n", recovered)
	}

	// Background initialization: embedder probe.
	// Fire-and-forget — embedQuery() falls back to FTS5 when embedder_available != "true".
	go func() {
		if db, err := sessiondb.Open(in.SessionID); err == nil {
			cacheEmbedderStatus(db)
			db.Close()
		}
	}()

	switch in.Source {
	case "startup", "resume":
		return handleStartupResume(in, sdb)
	case "compact":
		_ = sdb.RecordCompact()
		return handlePostCompactResume(sdb)
	}
	return nil, nil
}

func handleStartupResume(in sessionStartInput, sdb *sessiondb.SessionDB) (*HookOutput, error) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		// No store available — skip resume.
		return nil, nil
	}

	data, err := BuildResumeData(st, "", in.CWD)
	if err != nil || data == nil {
		return nil, nil
	}

	ctx := FormatResumeContext(data)
	if ctx == "" {
		return nil, nil
	}

	// Proactive briefing: blast radius, playbook, LLM session summary.
	if briefing := generateStartupBriefing(sdb, data, in.CWD); briefing != "" {
		ctx += "\n" + briefing
	}

	return makeOutput("SessionStart", ctx), nil
}

// generateStartupBriefing assembles a proactive session briefing.
// Includes blast radius for recently modified files and a task playbook.
// Returns "" if no useful briefing can be assembled.
func generateStartupBriefing(sdb *sessiondb.SessionDB, data *ResumeData, cwd string) string {
	var parts []string

	// 1. Unresolved failures: count + first action.
	if data != nil {
		unresolvedCount := 0
		var firstUnresolved string
		for _, item := range data.Briefing {
			if item.Category == "unresolved" {
				unresolvedCount++
				if firstUnresolved == "" {
					firstUnresolved = item.Message
				}
			}
		}
		if unresolvedCount > 0 {
			msg := fmt.Sprintf("UNRESOLVED from previous session: %d issue(s)", unresolvedCount)
			if firstUnresolved != "" {
				msg += fmt.Sprintf(". Priority: %s", firstUnresolved)
			}
			parts = append(parts, msg)
		}
	}

	// 2. Blast radius for recently modified files.
	if data != nil && len(data.Files) > 0 {
		var impactLines []string
		limit := min(3, len(data.Files))
		for i := range limit {
			f := data.Files[i]
			impactKey := "impact:" + filepath.Base(f.Path)
			if on, _ := sdb.IsOnCooldown(impactKey); on {
				continue
			}
			info := analyzeImpact(sdb, f.Path, cwd)
			_ = sdb.SetCooldown(impactKey, 15*time.Minute)
			if info == nil || info.BlastScore < 25 {
				continue
			}
			impactLines = append(impactLines, fmt.Sprintf(
				"  - %s: blast %d/100 (%s), %d importers, tests: %v",
				filepath.Base(f.Path), info.BlastScore, info.Risk,
				len(info.Importers), info.TestFiles))
		}
		if len(impactLines) > 0 {
			parts = append(parts, "Impact overview:\n"+strings.Join(impactLines, "\n"))
		}
	}

	// 3. Task playbook from last session's task type.
	if data != nil && data.Session != nil {
		taskType := inferTaskType(data)
		if taskType != TaskUnknown {
			_ = sdb.SetContext("task_type", string(taskType))
		}
	}

	// 4. Concrete first action recommendation.
	if data != nil {
		if action := recommendFirstAction(data, cwd); action != "" {
			parts = append(parts, "START HERE: "+action)
		}
	}

	// 5. Learning progress: data availability by session count.
	if note := learningProgressNote(sdb); note != "" {
		parts = append(parts, note)
	}

	// 6. Cumulative impact.
	if note := impactSummaryNote(); note != "" {
		parts = append(parts, note)
	}

	// 7. Knowledge base freshness check.
	if note := checkDocsFreshness(); note != "" {
		parts = append(parts, note)
	}

	if len(parts) == 0 {
		return ""
	}
	return "[alfred] Proactive briefing:\n" + strings.Join(parts, "\n")
}

// learningProgressNote returns a message describing what data is available
// based on the number of project sessions. At >= 10 sessions the system is
// mature and the note is suppressed (silence = healthy).
func learningProgressNote(sdb *sessiondb.SessionDB) string {
	ps := personalContext(sdb)
	n := ps.SessionCount
	switch {
	case n < 3:
		return fmt.Sprintf("Learning (session %d/3): Unlocks at 3: baselines, workflow. At 5: Thompson Sampling, strategic insights. At 10: mature thresholds", n)
	case n < 5:
		return fmt.Sprintf("Growing (session %d): Active: baselines, workflow. Unlocks at 5: Thompson Sampling. At 10: mature thresholds", n)
	case n < 10:
		return fmt.Sprintf("Growing (session %d): Active: baselines, TS, strategic insights. Unlocks at 10: mature adaptive thresholds", n)
	default:
		return ""
	}
}

// impactSummaryNote returns a cumulative impact line for the startup briefing.
// Shows total suggestions delivered and acted on across all sessions.
// Returns "" if insufficient data (<10 total deliveries).
func impactSummaryNote() string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}
	delivered, resolved, err := st.AggregatePreferenceStats()
	if err != nil || delivered < 10 {
		return ""
	}
	pct := float64(resolved) / float64(delivered) * 100
	return fmt.Sprintf("alfred impact: %d suggestions delivered, %d acted on (%.0f%% effective)",
		delivered, resolved, pct)
}

// checkDocsFreshness returns a reminder when the knowledge base hasn't been
// refreshed recently, or when a newer seed is bundled with the current binary.
// Also runs DeleteExpiredDocs as secondary cleanup (primary is at SessionEnd).
func checkDocsFreshness() string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}
	total, bySource, lastCrawl, err := st.DocsStats()
	if err != nil || total == 0 || lastCrawl == "" {
		return ""
	}

	// Check if embedded seed is newer than DB docs (new version bundled).
	sf, _ := install.LoadEmbedded()
	if sf != nil && sf.CrawledAt != "" && lastCrawl != "" {
		if sf.CrawledAt > lastCrawl { // RFC3339 timestamps sort lexicographically
			return "Newer documentation bundled with this version. Run `claude-alfred install` to update."
		}
	}

	// Purge expired docs as secondary cleanup.
	_, _ = st.DeleteExpiredDocs()

	t, err := time.Parse(time.RFC3339, lastCrawl)
	if err != nil {
		t, err = time.Parse("2006-01-02 15:04:05", lastCrawl)
		if err != nil {
			return ""
		}
	}
	days := int(time.Since(t).Hours() / 24)
	if days < 7 {
		return ""
	}
	return fmt.Sprintf("Knowledge base last updated %dd ago (%d docs, %d changelog). Run /alfred-crawl to refresh.",
		days, total, bySource["changelog"])
}

// recommendFirstAction analyzes resume data and produces a concrete "do this first" recommendation.
func recommendFirstAction(data *ResumeData, cwd string) string {
	// Priority 1: Unresolved failures → fix them first.
	for _, item := range data.Briefing {
		if item.Category == "unresolved" {
			return "Fix unresolved failure before new work — " + item.Message
		}
	}

	// Priority 2: Frequent failures → run tests to verify baseline.
	for _, item := range data.Briefing {
		if item.Category == "frequent_failure" {
			return "Run tests first to establish baseline — previous frequent failure: " + item.Message
		}
	}

	// Priority 3: Files modified but no test mention → verify with tests.
	if len(data.Files) > 3 {
		return fmt.Sprintf("Previous session modified %d files. Run tests to verify current state before continuing.", len(data.Files))
	}

	// Priority 4: Continue from intent.
	if data.Intent != "" {
		return "Continue from: " + data.Intent
	}

	return ""
}

// inferTaskType attempts to classify the task type from resume data.
func inferTaskType(data *ResumeData) TaskType {
	if data.Intent != "" {
		return classifyIntent(data.Intent)
	}
	return TaskUnknown
}

// cacheEmbedderStatus probes the Voyage API once and stores the result in sessiondb.
// Later hooks read the cached status to skip repeated availability checks.
func cacheEmbedderStatus(sdb *sessiondb.SessionDB) {
	emb := embedder.NewEmbedder()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if emb.EnsureAvailable(ctx) {
		_ = sdb.SetContext("embedder_available", "true")
	} else {
		_ = sdb.SetContext("embedder_available", "false")
	}
}

func handlePostCompactResume(sdb *sessiondb.SessionDB) (*HookOutput, error) {
	var parts []string

	// 1. Dequeue nudges queued before compaction (includes compact_context from PreCompact).
	nudges, _ := sdb.DequeueNudges(5)
	for _, n := range nudges {
		if n.Pattern == "compact_context" {
			// The compact_context nudge contains the serialized working set.
			parts = append(parts, n.Suggestion)
		} else {
			parts = append(parts, fmt.Sprintf("[alfred] %s (%s): %s\n→ %s",
				n.Pattern, n.Level, n.Observation, n.Suggestion))
		}
	}

	// 2. Supplement with persistent store decisions if working set had none.
	if !hasCompactContext(parts) {
		if extra := supplementFromStore(sdb); extra != "" {
			parts = append(parts, extra)
		}
	}

	if len(parts) == 0 {
		return nil, nil
	}

	return makeOutput("SessionStart", strings.Join(parts, "\n")), nil
}

// hasCompactContext checks if any part contains the working context header.
func hasCompactContext(parts []string) bool {
	for _, p := range parts {
		if strings.Contains(p, "Working context preserved") {
			return true
		}
	}
	return false
}

// supplementFromStore fetches recent decisions from the persistent store
// as a fallback when no working set was serialized before compaction.
func supplementFromStore(sdb *sessiondb.SessionDB) string {
	cwd, _ := sdb.GetContext("cwd")
	if cwd == "" {
		return ""
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	data, err := BuildResumeData(st, "", cwd)
	if err != nil || data == nil {
		return ""
	}

	var b strings.Builder
	if len(data.Decisions) > 0 {
		b.WriteString("[alfred] Recent design decisions:\n")
		limit := min(3, len(data.Decisions))
		for i := range limit {
			text := data.Decisions[i].DecisionText
			if len([]rune(text)) > 100 {
				text = string([]rune(text)[:100]) + "..."
			}
			fmt.Fprintf(&b, "  - %s\n", text)
		}
	}

	if len(data.Files) > 0 {
		b.WriteString("Recently modified files:\n")
		limit := min(5, len(data.Files))
		for i := range limit {
			fmt.Fprintf(&b, "  - %s (%s)\n", data.Files[i].Path, data.Files[i].Action)
		}
	}

	return b.String()
}

// captureGitContext captures git state at session start and stores it in the working set.
// Gracefully no-ops if not in a git repo or git is unavailable.
func captureGitContext(sdb *sessiondb.SessionDB, cwd string) {
	if cwd == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	branch, err := execGit(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return // not a git repo or git not available
	}
	branch = strings.TrimSpace(branch)
	_ = sdb.SetWorkingSet("git_branch", branch)

	status, err := execGit(ctx, cwd, "status", "--porcelain")
	if err != nil {
		return
	}
	status = strings.TrimSpace(status)
	if status == "" {
		return // clean working tree
	}

	lines := strings.Split(status, "\n")
	_ = sdb.SetWorkingSet("git_uncommitted_count", strconv.Itoa(len(lines)))

	// Store dirty file names (basename only) for PreToolUse warnings.
	var dirtyFiles []string
	for _, line := range lines {
		if len(line) < 4 {
			continue
		}
		// porcelain format: "XY filename" or "XY old -> new"
		name := strings.TrimSpace(line[3:])
		if idx := strings.Index(name, " -> "); idx >= 0 {
			name = name[idx+4:]
		}
		dirtyFiles = append(dirtyFiles, name)
	}
	_ = sdb.SetWorkingSet("git_dirty_files", strings.Join(dirtyFiles, "\n"))
}

func execGit(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
