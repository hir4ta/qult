package install

import (
	"fmt"
	"os"
	"path/filepath"
)

type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var buddySkills = []skillDef{
	{
		Dir: "buddy-unstuck",
		Content: `---
name: buddy-unstuck
description: >
  Use proactively when experiencing repeated failures (3+ consecutive errors
  on the same file or tool), when stuck in a retry loop, or when the same
  approach keeps failing. Analyzes root cause and suggests alternative
  approaches based on past session knowledge.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_recall, mcp__claude-buddy__buddy_alerts
---

You are a debugging advisor. The user (Claude Code) is stuck in a failure loop.

## Steps

1. Call buddy_alerts to see active anti-patterns and session health
2. Call buddy_patterns with a query describing the current error to find past solutions
3. If the pattern involves a specific file, call buddy_recall to find what worked before

## Output

Provide exactly ONE alternative approach:
- What's likely causing the repeated failure (one sentence)
- A specific different approach to try (one sentence)
- If a past solution exists, reference it

Keep it under 5 lines. Be direct and actionable.
`,
	},
	{
		Dir: "buddy-checkpoint",
		Content: `---
name: buddy-checkpoint
description: >
  Use proactively every 15-20 tool calls or before committing changes to
  check session health, verify no anti-patterns are active, and get a quick
  status on progress. Especially important before git commits or when
  working on complex multi-file changes.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_current_state, mcp__claude-buddy__buddy_alerts
---

Quick session health check.

## Steps

1. Call buddy_current_state to get session snapshot
2. Call buddy_alerts if health score < 0.7

## Output

- If health >= 0.7 and no alerts: respond "Session healthy" and continue
- If health < 0.7: state the top issue in one sentence
- If active alerts: mention the most severe one with its suggestion
- Never output more than 3 lines
`,
	},
	{
		Dir: "buddy-before-commit",
		Content: `---
name: buddy-before-commit
description: >
  Use automatically before any git commit to verify code quality and test
  status. Checks for active anti-patterns, unrun tests, and ensures no
  obvious issues will be committed.
user-invocable: false
allowed-tools: mcp__claude-buddy__buddy_alerts, mcp__claude-buddy__buddy_current_state, Bash, Read
---

Pre-commit quality gate.

## Steps

1. Call buddy_alerts to check for active anti-patterns
2. Call buddy_current_state to check if tests were run
3. If tests were not run in this session and the project has tests, suggest running them

## Output

- If blocking issues found: list them (max 3) and suggest fixes
- If clean: respond "Pre-commit check passed" and proceed with the commit
- Never block the commit yourself — just advise
`,
	},
	{
		Dir: "buddy-impact",
		Content: `---
name: buddy-impact
description: >
  Analyze the blast radius of planned changes before editing. Shows importers,
  test coverage, and co-change history for a file.
user-invocable: true
allowed-tools: mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_decisions, Read, Grep, Glob, Bash
---

Analyze the impact of changing a specific file or module.

## Steps

1. Identify the target file from the user's request
2. Call buddy_patterns to find related past changes and issues
3. Call buddy_decisions to check for architectural constraints
4. Use Grep to find importers/references to this file
5. Use Glob to find related test files

## Output

- Blast radius: number of files that reference this module
- Test coverage: which test files exist for this code
- Past issues: any known problems from pattern DB
- Recommendations: suggested approach for the change

Keep output under 10 lines. Be specific about file paths.
`,
	},
	{
		Dir: "buddy-review",
		Content: `---
name: buddy-review
description: >
  Review recent changes against pattern DB knowledge. Checks for known
  anti-patterns, past failures with similar code, and architectural decisions.
user-invocable: true
allowed-tools: mcp__claude-buddy__buddy_patterns, mcp__claude-buddy__buddy_alerts, mcp__claude-buddy__buddy_decisions, Bash, Read
---

Review recent code changes using pattern database knowledge.

## Steps

1. Run 'git diff --stat' to see what files changed
2. Call buddy_patterns for each changed file to find related past issues
3. Call buddy_decisions to check if changes align with past architectural choices
4. Call buddy_alerts to check session health

## Output

- List specific issues found (max 5)
- Reference past patterns or decisions that are relevant
- Suggest concrete fixes if issues found
- If clean, say "No issues found" and summarize what was reviewed
`,
	},
	{
		Dir: "buddy-estimate",
		Content: `---
name: buddy-estimate
description: >
  Estimate task complexity based on historical workflow data. Shows expected
  tool count, success rate, and recommended workflow.
user-invocable: true
allowed-tools: mcp__claude-buddy__buddy_estimate, mcp__claude-buddy__buddy_patterns
---

Estimate the complexity of a task using historical data.

## Steps

1. Determine the task type from the user's description (bugfix, feature, refactor, research, review)
2. Call buddy_estimate with the task type
3. Call buddy_patterns to find similar past tasks if available

## Output

- Task type classification
- Expected tool count (median from past sessions)
- Success rate for this type of task
- Recommended workflow steps
- Any relevant patterns from past sessions

Keep it concise — 5-8 lines max.
`,
	},
}

// installSkills writes buddy skills to ~/.claude/skills/.
func installSkills() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}

	installed := 0
	for _, skill := range buddySkills {
		skillDir := filepath.Join(home, ".claude", "skills", skill.Dir)
		skillPath := filepath.Join(skillDir, "SKILL.md")

		if err := os.MkdirAll(skillDir, 0o755); err != nil {
			return fmt.Errorf("mkdir skill %s: %w", skill.Dir, err)
		}

		if err := os.WriteFile(skillPath, []byte(skill.Content), 0o644); err != nil {
			return fmt.Errorf("write skill %s: %w", skill.Dir, err)
		}
		installed++
	}

	if installed > 0 {
		fmt.Printf("✓ Installed %d skills in ~/.claude/skills/\n", installed)
	} else {
		fmt.Println("✓ Skills already installed")
	}
	return nil
}

// removeSkills removes buddy skills from ~/.claude/skills/.
func removeSkills() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	for _, skill := range buddySkills {
		skillDir := filepath.Join(home, ".claude", "skills", skill.Dir)
		_ = os.RemoveAll(skillDir)
	}
}
