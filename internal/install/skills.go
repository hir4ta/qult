package install

import (
	"os"
	"path/filepath"
)

type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var buddySkills = []skillDef{
	{
		Dir: "init",
		Content: `---
name: init
description: >
  Re-sync sessions and regenerate embeddings. Binary updates are automatic —
  this skill is only needed for manual re-sync or after setting VOYAGE_API_KEY.
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

Re-sync claude-buddy data (sessions, patterns, embeddings).

Note: Binary updates happen automatically when the plugin is updated via /plugin.
This skill is useful for:
- Manual re-sync after setting VOYAGE_API_KEY
- Forcing a full session re-sync

## Steps

1. Find the plugin installation directory:
` + "   ```bash" + `
   find ~/.claude/plugins/cache -name "run.sh" -path "*/claude-buddy/*/bin/*" -type f 2>/dev/null | sort -V | tail -1
` + "   ```" + `

2. Count available sessions per sync range:
` + "   ```bash" + `
   sh <path-to-run.sh> count-sessions
` + "   ```" + `
   This returns JSON with session counts and estimated minutes per range.

3. Ask the user which sync range to use with AskUserQuestion:
   - Use the session counts and est_minutes from step 2 to build descriptions
   - Options (use actual counts from JSON):
     - "Past 1 week" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 2 weeks" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 1 month (Recommended)" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 3 months" — description: "{sessions} sessions, ~{est_minutes} min"
   - If has_voyage_key is true, append to the question text: "Embedding generation (vector search) runs after sync and is included in the time estimate."
   - Map the user's choice to a --since flag: 1 week=7d, 2 weeks=14d, 1 month=30d, 3 months=90d

4. Run setup with the chosen range (set timeout to 600000):
` + "   ```bash" + `
   sh <path-to-run.sh> setup --since=<chosen_flag>
` + "   ```" + `

5. Verify:
` + "   ```bash" + `
   sh <path-to-run.sh> version
` + "   ```" + `

## Output

- Sync status and version
- Tell the user to restart Claude Code if the binary was updated
`,
	},
	{
		Dir: "buddy-recover",
		Content: `---
name: buddy-recover
description: >
  Invoke on 2+ consecutive tool failures, Edit 'old_string not found', test
  FAIL after a fix attempt, or any compilation/import error. Do NOT retry —
  invoke this skill first for root cause analysis and past resolution diffs.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_skill_context, mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_recall, mcp__claude-buddy__buddy_alerts
---

Failure recovery advisor. Covers stuck loops, error recovery, and test failure debugging.

## Steps

1. Call buddy_skill_context with skill_name="buddy-recover" to get session health, recent failures, past solutions, and test correlations
2. If a past resolution diff exists, present the exact fix
3. If more detail needed, call buddy_patterns with the error message or failing test name
4. If the failure involves a specific file, call buddy_recall to find what worked before

## Output

- Root cause hypothesis (one sentence)
- ONE specific alternative approach or past fix to try
- If past resolution diff exists, show the exact change

Keep it under 5 lines. Be direct and actionable.
`,
	},
	{
		Dir: "buddy-gate",
		Content: `---
name: buddy-gate
description: >
  Invoke every 15 tool calls, before git commits, and when switching files
  or tasks. Quick health + quality gate that catches problems early and
  prevents bad commits. Do NOT skip before git operations.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_skill_context, mcp__claude-buddy__buddy_alerts, mcp__claude-buddy__buddy_current_state, Bash, Read
---

Session health check and pre-commit quality gate.

## Steps

1. Call buddy_skill_context with skill_name="buddy-gate" to get health score, test/build status, unresolved failures, and alerts
2. If this is a pre-commit check, verify tests have been run and no active alerts exist
3. Only call buddy_alerts separately if health < 0.7 and you need more detail

## Output

- If health >= 0.7, no alerts, tests passing: "Gate passed" and continue
- If blocking issues: list them (max 3) with suggested fixes
- Never block operations yourself — advise only
- Max 3 lines
`,
	},
	{
		Dir: "buddy-analyze",
		Content: `---
name: buddy-analyze
description: >
  Analyze blast radius of planned changes and review recent modifications.
  Shows importers, test coverage, co-change history, anti-patterns, and
  architectural alignment.
user-invocable: true
allowed-tools: mcp__claude-buddy__buddy_skill_context, mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_decisions, mcp__claude-buddy__buddy_alerts, Read, Grep, Glob, Bash
context: fork
agent: Explore
---

Impact analysis and change review.

## Steps

1. Identify target files from the user's request or recent git diff
2. Call buddy_skill_context with skill_name="buddy-analyze" for modified files, test status, and patterns
3. Use Grep to find importers/references, Glob for related test files
4. Call buddy_decisions to check architectural constraints
5. Call buddy_patterns for known issues with these files

## Output

- Blast radius: files referencing the target module
- Test coverage: existing test files for this code
- Past issues: known problems from pattern DB
- Alignment: whether changes match past architectural decisions
- Recommendations: suggested approach

Keep under 10 lines. Be specific about file paths.
`,
	},
	{
		Dir: "buddy-forecast",
		Content: `---
name: buddy-forecast
description: >
  Estimate task complexity from historical data and predict session trajectory.
  Shows expected tool count, success rate, workflow recommendation, health
  trend, and cascade risk.
user-invocable: true
allowed-tools: mcp__claude-buddy__buddy_estimate, mcp__claude-buddy__buddy_current_state, mcp__claude-buddy__buddy_skill_context, mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_alerts
context: fork
agent: Explore
---

Task estimation and session prediction dashboard.

## Steps

1. Determine task type from the user's description (bugfix, feature, refactor, research, review)
2. Call buddy_estimate with the task type for historical data
3. Call buddy_current_state for real-time session snapshot including predictions
4. Call buddy_skill_context with skill_name="buddy-forecast" for health and phase data
5. If health < 0.7, call buddy_alerts for anti-pattern details

## Output

- Task type + expected tool count (median) + success rate
- Health: [score] [trend] | Phase: [current] → [next]
- Cascade risk: [low/medium/high]
- Recommended workflow steps
- One-sentence forecast

Keep it concise — max 8 lines.
`,
	},
	{
		Dir: "buddy-context-recovery",
		Content: `---
name: buddy-context-recovery
description: >
  CRITICAL: Invoke immediately when you notice missing context, when you
  cannot recall recent decisions, or when conversation history seems
  truncated. Recovers the current task intent, working set files, recent
  decisions, and git branch state from session memory.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_skill_context, mcp__claude-buddy__buddy_recall, mcp__claude-buddy__buddy_decisions
---

Automatic context recovery after compaction.

## Steps

1. Call buddy_skill_context with skill_name="buddy-context-recovery" to get working set, decisions, and session state
2. If key details are missing, call buddy_recall with specific queries for:
   - Current task/goal
   - Files being actively edited
   - Recent decisions made
3. Call buddy_decisions to restore architectural context if working on a complex task

## Output

Provide a compact recovery summary:
- Current goal: [one sentence]
- Active files: [list of files being edited]
- Recent decisions: [key decisions, max 3]
- Branch: [git branch if available]

Keep it under 8 lines. Focus on what's needed to continue work immediately.
`,
	},
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	"buddy-unstuck",
	"buddy-checkpoint",
	"buddy-before-commit",
	"buddy-impact",
	"buddy-review",
	"buddy-estimate",
	"buddy-error-recovery",
	"buddy-test-guidance",
	"buddy-predict",
}

// removeSkills removes buddy skills from ~/.claude/skills/, including
// deprecated skill directories from previous versions.
func removeSkills() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	skillsBase := filepath.Join(home, ".claude", "skills")
	for _, skill := range buddySkills {
		_ = os.RemoveAll(filepath.Join(skillsBase, skill.Dir))
	}
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(skillsBase, dir))
	}
}
