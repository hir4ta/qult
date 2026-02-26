package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type userPromptInput struct {
	CommonInput
	Prompt string `json:"prompt"`
}

func handleUserPromptSubmit(input []byte) (*HookOutput, error) {
	var in userPromptInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] UserPromptSubmit: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// User turn boundary: reset burst counters and context.
	_ = sdb.ResetBurst()
	_ = sdb.SetContext("subagent_active", "")

	// Record user intent and classify task type for workflow guidance.
	if in.Prompt != "" {
		intent := in.Prompt
		if len([]rune(intent)) > 100 {
			intent = string([]rune(intent)[:100])
		}
		_ = sdb.SetContext("last_user_intent", intent)

		taskType := classifyIntentLLM(sdb, in.Prompt)
		if taskType != TaskUnknown {
			_ = sdb.SetContext("task_type", string(taskType))
		}
		_ = sdb.SetContext("has_test_run", "")

		// Update working set with current intent and task type.
		_ = sdb.SetWorkingSet("intent", intent)
		if taskType != TaskUnknown {
			_ = sdb.SetWorkingSet("task_type", string(taskType))
		}

		// Track decisions from user prompts.
		if containsDecisionKeyword(in.Prompt) {
			_ = sdb.AddWorkingSetDecision(intent)
		}
	}

	// Dequeue pending nudges (max 2).
	nudges, _ := sdb.DequeueNudges(2)

	// Record delivery for effectiveness tracking.
	recordNudgeDelivery(sdb, in.SessionID, nudges)

	entries := make([]nudgeEntry, 0, len(nudges)+2)

	// Generate task playbook if we have a task type.
	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr != "" {
		if playbook := generatePlaybook(sdb, TaskType(taskTypeStr), in.CWD); playbook != "" {
			entries = append(entries, nudgeEntry{
				Pattern:     "playbook",
				Level:       "info",
				Observation: "Task workflow recommendation",
				Suggestion:  playbook,
			})
		}
	}

	for _, n := range nudges {
		entries = append(entries, nudgeEntry{
			Pattern:     n.Pattern,
			Level:       n.Level,
			Observation: n.Observation,
			Suggestion:  n.Suggestion,
		})
	}

	// Search for relevant past knowledge based on user's prompt.
	if knowledge := matchRelevantKnowledge(sdb, in.Prompt); knowledge != "" {
		entries = append(entries, nudgeEntry{
			Pattern:     "knowledge",
			Level:       "info",
			Observation: "Relevant past knowledge found",
			Suggestion:  knowledge,
		})
	}

	// Inject session context summary for rich situational awareness.
	if summary := buildSessionContextSummary(sdb); summary != "" {
		entries = append([]nudgeEntry{{
			Pattern:     "session-context",
			Level:       "info",
			Observation: "Session context",
			Suggestion:  summary,
		}}, entries...)
	}

	if len(entries) == 0 {
		return nil, nil
	}
	return makeOutput("UserPromptSubmit", formatNudges(entries)), nil
}

// buildSessionContextSummary creates a compact session context string.
func buildSessionContextSummary(sdb *sessiondb.SessionDB) string {
	on, _ := sdb.IsOnCooldown("session_context_summary")
	if on {
		return ""
	}

	var parts []string

	// Working files.
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) > 0 {
		names := make([]string, 0, min(len(files), 3))
		for i, f := range files {
			if i >= 3 {
				break
			}
			names = append(names, filepath.Base(f))
		}
		suffix := ""
		if len(files) > 3 {
			suffix = fmt.Sprintf(" +%d more", len(files)-3)
		}
		parts = append(parts, "Files: "+strings.Join(names, ", ")+suffix)
	}

	// Task type + phase progress.
	if progress := GetPhaseProgress(sdb); progress != nil {
		phaseStr := fmt.Sprintf("Phase: %s (%d%%)", progress.CurrentPhase, progress.ProgressPct)
		if progress.ExpectedPhase != PhaseUnknown && progress.ExpectedPhase != progress.CurrentPhase {
			phaseStr += fmt.Sprintf(" → next: %s", progress.ExpectedPhase)
		}
		parts = append(parts, phaseStr)
	} else if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		parts = append(parts, "Task: "+taskType)
	}

	// Git branch.
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, "Branch: "+branch)
	}

	// Velocity health.
	vel := getFloat(sdb, "ewma_tool_velocity")
	errRate := getFloat(sdb, "ewma_error_rate")
	if vel > 0 || errRate > 0 {
		health := "healthy"
		if errRate > 0.3 {
			health = "high error rate"
		} else if vel < 2 && vel > 0 {
			health = "slow velocity"
		}
		parts = append(parts, "Health: "+health)
	}

	if len(parts) < 2 {
		return "" // not enough context to be useful
	}

	_ = sdb.SetCooldown("session_context_summary", 5*time.Minute)
	return strings.Join(parts, " | ")
}

// knowledgeType pairs a pattern type with its cooldown key.
type knowledgeType struct {
	name     string
	cooldown string
}

var knowledgeTypes = []knowledgeType{
	{"error_solution", "knowledge_error"},
	{"architecture", "knowledge_arch"},
	{"decision", "knowledge_decision"},
}

// matchRelevantKnowledge searches past patterns matching the user's prompt.
// Uses split cooldowns per knowledge type and falls back to file-path keywords
// when the prompt is short.
func matchRelevantKnowledge(sdb *sessiondb.SessionDB, prompt string) string {
	// Build search terms: keywords from prompt + recent file paths as fallback.
	keywords := extractKeywords(prompt, 3)
	if len(keywords) == 0 {
		keywords = recentFileKeywords(sdb)
	}
	if len(keywords) == 0 {
		return ""
	}

	// Prioritize knowledge types based on task type.
	taskTypeStr, _ := sdb.GetContext("task_type")
	ordered := prioritizeKnowledgeTypes(TaskType(taskTypeStr))

	// Check at least one knowledge type is off cooldown.
	var activeTypes []string
	for _, t := range ordered {
		on, _ := sdb.IsOnCooldown(t.cooldown)
		if !on {
			activeTypes = append(activeTypes, t.name)
		}
	}
	if len(activeTypes) == 0 {
		return ""
	}

	query := strings.Join(keywords, " ")
	vec := embedQuery(sdb, query, 1*time.Second)
	if vec == nil {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	var allResults []store.PatternRow
	for _, patType := range activeTypes {
		patterns, _ := st.SearchPatternsByVector(vec, patType, 2)
		allResults = append(allResults, patterns...)
	}
	if len(allResults) == 0 {
		return ""
	}

	// Set cooldowns for matched types.
	matchedTypes := make(map[string]bool)
	for _, p := range allResults {
		matchedTypes[p.PatternType] = true
	}
	for _, t := range knowledgeTypes {
		if matchedTypes[t.name] {
			_ = sdb.SetCooldown(t.cooldown, 3*time.Minute)
		}
	}

	var b strings.Builder
	b.WriteString("Relevant past knowledge:\n")
	limit := 3
	if len(allResults) < limit {
		limit = len(allResults)
	}
	for i := 0; i < limit; i++ {
		p := allResults[i]
		content := p.Content
		if len([]rune(content)) > 120 {
			content = string([]rune(content)[:120]) + "..."
		}
		fmt.Fprintf(&b, "  - [%s] %s\n", p.PatternType, content)
	}
	return b.String()
}

// prioritizeKnowledgeTypes reorders knowledge types based on task type.
// bugfix → error_solution first, feature → architecture first, refactor → decision first.
func prioritizeKnowledgeTypes(taskType TaskType) []knowledgeType {
	switch taskType {
	case TaskBugfix:
		return []knowledgeType{
			{"error_solution", "knowledge_error"},
			{"decision", "knowledge_decision"},
			{"architecture", "knowledge_arch"},
		}
	case TaskFeature:
		return []knowledgeType{
			{"architecture", "knowledge_arch"},
			{"decision", "knowledge_decision"},
			{"error_solution", "knowledge_error"},
		}
	case TaskRefactor:
		return []knowledgeType{
			{"decision", "knowledge_decision"},
			{"architecture", "knowledge_arch"},
			{"error_solution", "knowledge_error"},
		}
	default:
		return knowledgeTypes
	}
}

// recentFileKeywords extracts searchable keywords from recent file paths
// in the current burst, used as a fallback when the user prompt is short.
func recentFileKeywords(sdb *sessiondb.SessionDB) []string {
	_, _, fileReads, err := sdb.BurstState()
	if err != nil || len(fileReads) == 0 {
		return nil
	}

	var keywords []string
	seen := make(map[string]bool)
	for path := range fileReads {
		base := filepath.Base(path)
		name := strings.TrimSuffix(base, filepath.Ext(base))
		if len(name) >= 3 && !seen[name] {
			seen[name] = true
			keywords = append(keywords, name)
		}
		if len(keywords) >= 3 {
			break
		}
	}
	return keywords
}
