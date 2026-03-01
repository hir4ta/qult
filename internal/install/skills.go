package install

import (
	"os"
	"path/filepath"
)

type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var alfredSkills = []skillDef{
	{
		Dir: "alfred-recover",
		Content: `---
name: alfred-recover
description: >
  Invoke on 2+ consecutive tool failures, Edit 'old_string not found', test
  FAIL after a fix attempt, or any compilation/import error. Do NOT retry —
  invoke this skill first for root cause analysis and past resolution diffs.
user-invocable: false
allowed-tools: mcp__claude-alfred__state, mcp__claude-alfred__knowledge, mcp__claude-alfred__guidance, mcp__claude-alfred__diagnose
---

Failure recovery advisor. Covers stuck loops, error recovery, and test failure debugging.

## Steps

1. Call state with detail="skill", skill_name="alfred-recover" to get session health, recent failures, past solutions, and test correlations
2. If a past resolution diff exists, present the exact fix
3. If more detail needed, call knowledge with the error message or failing test name
4. If the failure involves a specific file, call knowledge with scope="recall" to find what worked before

## Output

- Root cause hypothesis (one sentence)
- ONE specific alternative approach or past fix to try
- If past resolution diff exists, show the exact change

Keep it under 5 lines. Be direct and actionable.
`,
	},
	{
		Dir: "alfred-gate",
		Content: `---
name: alfred-gate
description: >
  Invoke every 15 tool calls, before git commits, and when switching files
  or tasks. Quick health + quality gate that catches problems early and
  prevents bad commits. Do NOT skip before git operations.
user-invocable: false
allowed-tools: mcp__claude-alfred__state, mcp__claude-alfred__guidance, Bash, Read
---

Session health check and pre-commit quality gate.

## Steps

1. Call state with detail="skill", skill_name="alfred-gate" to get health score, test/build status, unresolved failures, and alerts
2. If this is a pre-commit check, verify tests have been run and no active alerts exist
3. Only call guidance with focus="alerts" separately if health < 0.7 and you need more detail

## Output

- If health >= 0.7, no alerts, tests passing: "Gate passed" and continue
- If blocking issues: list them (max 3) with suggested fixes
- Never block operations yourself — advise only
- Max 3 lines
`,
	},
	{
		Dir: "alfred-analyze",
		Content: `---
name: alfred-analyze
description: >
  Analyze blast radius of planned changes and review recent modifications.
  Shows importers, test coverage, co-change history, anti-patterns, and
  architectural alignment.
user-invocable: true
allowed-tools: mcp__claude-alfred__state, mcp__claude-alfred__knowledge, mcp__claude-alfred__guidance, Read, Grep, Glob, Bash
context: fork
agent: Explore
---

Impact analysis and change review.

## Steps

1. Identify target files from the user's request or recent git diff
2. Call state with detail="skill", skill_name="alfred-analyze" for modified files, test status, and patterns
3. Use Grep to find importers/references, Glob for related test files
4. Call knowledge with type="decision" to check architectural constraints
5. Call knowledge for known issues with these files

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
		Dir: "alfred-forecast",
		Content: `---
name: alfred-forecast
description: >
  Estimate task complexity from historical data and predict session trajectory.
  Shows expected tool count, success rate, workflow recommendation, health
  trend, and cascade risk.
user-invocable: true
allowed-tools: mcp__claude-alfred__plan, mcp__claude-alfred__state, mcp__claude-alfred__knowledge, mcp__claude-alfred__guidance
context: fork
agent: Explore
---

Task estimation and session prediction dashboard.

## Steps

1. Determine task type from the user's description (bugfix, feature, refactor, research, review)
2. Call plan with mode="estimate" and the task type for historical data
3. Call state for real-time session snapshot including predictions
4. Call state with detail="skill", skill_name="alfred-forecast" for health and phase data
5. If health < 0.7, call guidance with focus="alerts" for anti-pattern details

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
		Dir: "alfred-context-recovery",
		Content: `---
name: alfred-context-recovery
description: >
  CRITICAL: Invoke immediately when you notice missing context, when you
  cannot recall recent decisions, or when conversation history seems
  truncated. Recovers the current task intent, working set files, recent
  decisions, and git branch state from session memory.
user-invocable: false
allowed-tools: mcp__claude-alfred__state, mcp__claude-alfred__knowledge
---

Automatic context recovery after compaction.

## Steps

1. Call state with detail="skill", skill_name="alfred-context-recovery" to get working set, decisions, and session state
2. If key details are missing, call knowledge with scope="recall" for:
   - Current task/goal
   - Files being actively edited
   - Recent decisions made
3. Call knowledge with type="decision" to restore architectural context if working on a complex task

## Output

Provide a compact recovery summary:
- Current goal: [one sentence]
- Active files: [list of files being edited]
- Recent decisions: [key decisions, max 3]
- Branch: [git branch if available]

Keep it under 8 lines. Focus on what's needed to continue work immediately.
`,
	},
	{
		Dir: "alfred-crawl",
		Content: `---
name: alfred-crawl
description: >
  Fetch Claude Code documentation and ingest into the alfred knowledge base.
  Crawls code.claude.com/docs, splits pages into sections, and stores them
  via the ingest MCP tool for semantic search.
user-invocable: true
allowed-tools: WebFetch, WebSearch, mcp__claude-alfred__ingest, mcp__claude-alfred__state
context: fork
agent: general-purpose
---

Documentation crawler for the alfred knowledge base.

## Steps

1. Fetch the docs index page:
   - WebFetch url="https://docs.claude.com/en/docs" with prompt="Extract all documentation page URLs from the sidebar navigation. Return as a JSON array of {url, title} objects."

2. For each documentation page:
   - WebFetch the page URL with prompt="Split the page content into sections by h2/h3 headings. Return as a JSON array of {path, content} objects where path is 'Page Title > Section Heading > Subsection' and content is the section text (including code blocks). Omit navigation, footer, and boilerplate."
   - Call ingest with:
     - url: the page URL
     - sections: the array from WebFetch
     - source_type: "docs"

3. Fetch the changelog:
   - WebSearch query="Claude Code changelog site:docs.claude.com"
   - WebFetch the changelog URL with prompt="Split the changelog into version entries. Return as a JSON array of {path, content} objects where path is the version number (e.g. 'v1.0.30') and content is the changes for that version."
   - Call ingest with source_type="changelog"

4. Report summary:
   - Call state with detail="brief" to verify ingested doc count
   - Report: pages crawled, sections ingested, embeddings generated

## Important Notes

- If a page fails to fetch, skip it and continue with the next
- Sections should be self-contained (include relevant context, not just fragments)
- Keep section content under ~2000 chars for effective embedding
- If content hasn't changed (same hash), ingest will skip it automatically
- Re-running this skill updates existing docs and adds new ones
`,
	},
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	"init",
	"alfred-unstuck",
	"alfred-checkpoint",
	"alfred-before-commit",
	"alfred-impact",
	"alfred-review",
	"alfred-estimate",
	"alfred-error-recovery",
	"alfred-test-guidance",
	"alfred-predict",
}

// removeSkills removes alfred skills from ~/.claude/skills/, including
// deprecated skill directories from previous versions.
func removeSkills() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	skillsBase := filepath.Join(home, ".claude", "skills")
	for _, skill := range alfredSkills {
		_ = os.RemoveAll(filepath.Join(skillsBase, skill.Dir))
	}
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(skillsBase, dir))
	}
}
