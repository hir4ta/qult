package hookhandler

import (
	"fmt"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// detectLearnedEpisodes checks recent events against dynamically learned
// anti-pattern episodes from past sessions. Returns a warning message if
// the current tool sequence matches a learned episode at >= 60% confidence.
func (d *HookDetector) detectLearnedEpisodes() string {
	events, err := d.sdb.RecentEvents(10)
	if err != nil || len(events) < 3 {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	// Only check episodes seen 2+ times (validated patterns).
	episodes, err := st.GetLearnedEpisodes(2)
	if err != nil || len(episodes) == 0 {
		return ""
	}

	// Build current tool sequence from recent events.
	currentSeq := make([]string, 0, len(events))
	for _, ev := range events {
		currentSeq = append(currentSeq, ev.ToolName)
	}

	for _, ep := range episodes {
		if ep.TotalSteps == 0 {
			continue
		}
		matched := matchSubsequence(currentSeq, ep.ToolSequence)
		confidence := float64(matched) / float64(ep.TotalSteps)

		if confidence >= 0.6 {
			set, _ := d.sdb.TrySetCooldown("learned_episode:"+ep.Name, 15*time.Minute)
			if !set {
				continue
			}
			return fmt.Sprintf(
				"[buddy] learned-pattern (%s): Current tool sequence matches a failure pattern seen %d times before (%.0f%% match). Consider a different approach.",
				ep.Name, ep.Occurrences, confidence*100,
			) + SkillHintForEpisode("learned_episode")
		}

		// Fuzzy match: catch variant episodes via Levenshtein distance.
		similarity := sequenceSimilarity(currentSeq, ep.ToolSequence)
		if similarity >= 0.65 {
			set, _ := d.sdb.TrySetCooldown("learned_episode:"+ep.Name, 15*time.Minute)
			if !set {
				continue
			}
			return fmt.Sprintf(
				"[buddy] variant-pattern (%s): Current tool sequence is %.0f%% similar to a known failure pattern (seen %d times). Consider a different approach.",
				ep.Name, similarity*100, ep.Occurrences,
			) + SkillHintForEpisode("learned_episode")
		}
	}
	return ""
}

// detectTrajectoryMatch checks if the current session's phase sequence
// resembles a past failed session. Uses Jaccard similarity on phase bigrams.
func (d *HookDetector) detectTrajectoryMatch() string {
	taskType, _ := d.sdb.GetContext("task_type")
	if taskType == "" {
		return ""
	}

	set, _ := d.sdb.TrySetCooldown("trajectory_match", 20*time.Minute)
	if !set {
		return ""
	}

	// Get current phase history from session.
	phases := getPhaseHistory(d.sdb)
	if len(phases) < 3 {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	sessionID, similarity, err := st.MatchesWorkflowTrajectory(taskType, phases)
	if err != nil || similarity < 0.7 {
		return ""
	}

	return fmt.Sprintf(
		"[buddy] trajectory-warning: Your session pattern (%.0f%% similar to past failed session %s) suggests you may be heading toward a known failure mode. Consider pausing to reassess your approach.",
		similarity*100, sessionID[:8],
	) + SkillHintForEpisode("trajectory_match")
}

// updateWorkflowAlignment computes alignment between the current session's phase
// sequence and the best successful workflow for this task type. Stores the score
// in sessiondb and returns a divergence warning if alignment drops significantly.
func updateWorkflowAlignment(sdb *sessiondb.SessionDB) string {
	taskType, _ := sdb.GetContext("task_type")
	if taskType == "" {
		return ""
	}

	// Build current phase history.
	phases := getPhaseHistory(sdb)
	if len(phases) < 3 {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	cwd, _ := sdb.GetContext("cwd")
	bestWorkflow, count, _ := st.MostCommonWorkflow(cwd, taskType, 2)
	if len(bestWorkflow) == 0 || count < 2 {
		return ""
	}

	// Compute Jaccard similarity on phase bigrams.
	currentBigrams := workflowPhaseBigrams(phases)
	bestBigrams := workflowPhaseBigrams(bestWorkflow)
	alignment := workflowJaccard(currentBigrams, bestBigrams)

	// Store current alignment score.
	_ = sdb.SetContext("workflow_alignment", fmt.Sprintf("%.2f", alignment))

	// Check for significant drop from previous alignment.
	prevStr, _ := sdb.GetContext("prev_workflow_alignment")
	_ = sdb.SetContext("prev_workflow_alignment", fmt.Sprintf("%.2f", alignment))

	if prevStr == "" {
		return ""
	}
	var prev float64
	fmt.Sscanf(prevStr, "%f", &prev)

	// Detect divergence: alignment dropped by 20%+ and is now below 0.5.
	if prev > 0.5 && alignment < 0.5 && (prev-alignment) > 0.2 {
		set, _ := sdb.TrySetCooldown("workflow_divergence", 15*time.Minute)
		if !set {
			return ""
		}
		// Find the divergence point.
		divergePhase := ""
		for i, p := range phases {
			if i < len(bestWorkflow) && p != bestWorkflow[i] {
				divergePhase = fmt.Sprintf("at phase %d: you did %q, successful sessions did %q", i+1, p, bestWorkflow[i])
				break
			}
		}
		if divergePhase == "" && len(phases) > len(bestWorkflow) {
			divergePhase = fmt.Sprintf("after phase %d (successful sessions had %d phases)", len(bestWorkflow), len(bestWorkflow))
		}

		msg := fmt.Sprintf("[buddy] workflow-divergence: Alignment with successful %s sessions dropped to %.0f%% (was %.0f%%).", taskType, alignment*100, prev*100)
		if divergePhase != "" {
			msg += " Diverged " + divergePhase + "."
		}
		msg += fmt.Sprintf(" Successful pattern (%d sessions): %s.", count, strings.Join(bestWorkflow, " → "))
		return msg
	}
	return ""
}

// workflowPhaseBigrams returns the set of consecutive phase pairs from a phase list.
func workflowPhaseBigrams(phases []string) map[string]bool {
	bigrams := make(map[string]bool)
	for i := 0; i < len(phases)-1; i++ {
		bigrams[phases[i]+"→"+phases[i+1]] = true
	}
	return bigrams
}

// workflowJaccard computes |A∩B| / |A∪B| for two sets.
func workflowJaccard(a, b map[string]bool) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 0
	}
	intersection := 0
	for k := range a {
		if b[k] {
			intersection++
		}
	}
	union := len(a) + len(b) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

// matchSubsequence counts how many elements of target appear in sequence
// within source (order-preserving but not necessarily contiguous).
func matchSubsequence(source, target []string) int {
	matched := 0
	si := 0
	for _, t := range target {
		for si < len(source) {
			if strings.EqualFold(source[si], t) {
				matched++
				si++
				break
			}
			si++
		}
		if si >= len(source) {
			break
		}
	}
	return matched
}

// getPhaseHistory extracts the phase sequence from recent events.
func getPhaseHistory(sdb *sessiondb.SessionDB) []string {
	events, err := sdb.RecentEvents(30)
	if err != nil || len(events) == 0 {
		return nil
	}

	var phases []string
	var lastPhase string
	for _, ev := range events {
		phase := toolToPhase(ev.ToolName)
		if phase != "" && phase != lastPhase {
			phases = append(phases, phase)
			lastPhase = phase
		}
	}
	return phases
}

// toolToPhase maps tool names to workflow phases.
func toolToPhase(toolName string) string {
	switch toolName {
	case "Read", "Glob", "Grep", "WebFetch", "WebSearch":
		return "read"
	case "Edit", "Write", "NotebookEdit":
		return "write"
	case "Bash":
		return "test" // simplified; could be compile/test/other
	case "EnterPlanMode", "ExitPlanMode":
		return "plan"
	case "Task":
		return "delegate"
	}
	return ""
}

// RecordLearnedEpisode extracts novel failure patterns from a session's
// event history and stores them for future detection. Called at SessionEnd.
func RecordLearnedEpisode(sdb *sessiondb.SessionDB, sessionID string) {
	events, err := sdb.RecentEvents(30)
	if err != nil || len(events) < 5 {
		return
	}

	// Look for repeated failure subsequences that don't match the 5 built-in templates.
	failSeq := extractFailureSequence(events)
	if len(failSeq) < 3 {
		return
	}

	// Generate a fingerprint name from the sequence.
	name := "learned:" + strings.Join(failSeq[:min(len(failSeq), 4)], "_")

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	_ = st.InsertLearnedEpisode(sessionID, name, failSeq, "failure")
}

// extractFailureSequence identifies tool sequences around recent failures.
// Uses failures from sessiondb and correlates with the event timeline.
func extractFailureSequence(events []sessiondb.HookEvent) []string {
	if len(events) < 3 {
		return nil
	}

	// Look for repeated tool patterns in recent events.
	// A failure sequence is a run of tools where the same tool appears 2+ times
	// (indicating retries), plus the tools immediately before.
	seen := make(map[string]int)
	for _, ev := range events {
		seen[ev.ToolName]++
	}

	// Find the most-repeated tool (likely a retry target).
	var maxTool string
	var maxCount int
	for tool, count := range seen {
		if count > maxCount {
			maxTool = tool
			maxCount = count
		}
	}
	if maxCount < 2 {
		return nil
	}

	// Extract the subsequence of distinct tools up to and including retries.
	var seq []string
	var lastTool string
	for _, ev := range events {
		if ev.ToolName != lastTool {
			seq = append(seq, ev.ToolName)
			lastTool = ev.ToolName
		}
		if ev.ToolName == maxTool && len(seq) >= 3 {
			break
		}
	}

	if len(seq) < 3 {
		return nil
	}
	if len(seq) > 6 {
		seq = seq[:6]
	}
	return seq
}

// levenshteinDistance computes the edit distance between two string slices.
// Uses two-row optimization for O(min(la,lb)) space.
func levenshteinDistance(a, b []string) int {
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	prev := make([]int, lb+1)
	curr := make([]int, lb+1)
	for j := range prev {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if strings.EqualFold(a[i-1], b[j-1]) {
				cost = 0
			}
			curr[j] = min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost)
		}
		prev, curr = curr, prev
	}
	return prev[lb]
}

// sequenceSimilarity returns the normalized similarity (0-1) between two tool sequences.
func sequenceSimilarity(a, b []string) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 1.0
	}
	maxLen := max(len(a), len(b))
	dist := levenshteinDistance(a, b)
	return 1.0 - float64(dist)/float64(maxLen)
}
