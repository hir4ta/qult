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

var alfredSkills = []skillDef{
	{
		Dir: "inspect",
		Content: `---
name: inspect
description: >
  Full Claude Code utilization report for your project. Analyzes CLAUDE.md,
  skills, rules, hooks, MCP servers, and session history. Returns improvement
  suggestions backed by best practices. Includes quick audit and migration checks.
user-invocable: true
argument-hint: "[--quick]"
allowed-tools: Read, Glob, mcp__alfred__review, mcp__alfred__knowledge, mcp__alfred__preferences
context: fork
agent: general-purpose
---

The butler's rounds — inspect the estate and report what needs attention.

## Steps

1. **[HOW]** Load context:
   - Call ` + "`preferences`" + ` with action="get" to understand the user's style
   - Call ` + "`review`" + ` with project_path=$CWD for current setup analysis

2. **[WHAT]** If $ARGUMENTS contains "--quick":
   - Output a checklist only: ` + "`[x] CLAUDE.md (N lines)`" + `, ` + "`[ ] Hooks (not configured)`" + `, etc.
   - One-line suggestion for each missing item
   - STOP here

3. **[HOW]** Deep analysis:
   - Call ` + "`knowledge`" + ` with query about latest best practices and setup checklist
   - Compare current setup against best practices:
     - CLAUDE.md: presence, length (<200 lines), required sections (Stack, Commands, Rules)
     - Skills: constraint tags (HOW/WHAT), guardrails section, tool least-privilege
     - Rules: valid glob patterns, actionable instructions, concise (<20 lines)
     - Hooks: timeout appropriateness, matcher specificity
     - Agents: model explicit, tools minimal, description explains WHEN to delegate
     - MCP: no hardcoded API keys, valid commands

4. **[WHAT]** Migration check:
   - Identify outdated patterns (missing constraint tags, deprecated fields, new event types)
   - Flag features available in current CC version but not yet adopted

5. **[Template]** Output format:
   ` + "```" + `
   ## Setup Score: N/10

   ### In Use
   - ...

   ### Needs Attention (ordered by impact)
   1. **[HIGH]** What — Why — How to fix
   2. **[MEDIUM]** ...

   ### Migration Opportunities
   - ...
   ` + "```" + `

## Guardrails

- Do NOT suggest changes that conflict with user preferences
- Do NOT report LOW severity or PASS items — only actionable findings
- Do NOT read file contents unless checking specific patterns; rely on review MCP tool
- Keep report under 30 lines unless user asks for detail
`,
	},
	{
		Dir: "prepare",
		Content: `---
name: prepare
description: >
  Generate a new Claude Code configuration file (skill, rule, hook, agent,
  MCP server, CLAUDE.md, or memory) following latest best practices and
  the user's preferences.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences
context: current
---

The butler prepares what the master needs — tailored to their preferences.

## Steps

1. **[HOW]** Load user preferences:
   - Call ` + "`preferences`" + ` with action="get" to understand coding style and workflow

2. **[WHAT]** Determine target type:
   - Parse $ARGUMENTS for type: ` + "`skill`" + `, ` + "`rule`" + `, ` + "`hook`" + `, ` + "`agent`" + `, ` + "`mcp`" + `, ` + "`claude-md`" + `, ` + "`memory`" + `
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

3. **[HOW]** Check for collisions:
   - Glob for existing files at the target path
   - If exists, warn and ask whether to overwrite or use ` + "`/polish`" + ` instead

4. **[HOW]** Gather requirements (type-specific):
   - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
   - **rule**: enforcement concept, glob patterns (e.g., ` + "`**/*.go`" + `)
   - **hook**: event type, handler purpose, blocking behavior
   - **agent**: specialization, required tools, memory type (user/project/local)
   - **mcp**: server name/npm package, server type (stdio/sse)
   - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
   - **memory**: check auto memory path, topic organization

5. **[HOW]** Search best practices:
   - Call ` + "`knowledge`" + ` with query about the specific type's best practices

6. **[Template]** Generate from type-specific template:
   - **skill**: frontmatter (name, description, allowed-tools, context, agent) + constraint tags (HOW/WHAT/Template/Guardrails)
   - **rule**: frontmatter with paths + actionable instructions (<20 lines)
   - **hook**: hooks.json entry (timeout, matcher, command) + handler script
   - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
   - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
   - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
   - **memory**: MEMORY.md template organized by topic

7. **[HOW]** Validate (type-specific):
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

8. **[HOW]** Write file to target path

9. **[HOW]** Independent review:
   - Spawn Explore agent to validate the generated file against knowledge base
   - Fix any issues found

## Target Paths

| Type | Path |
|------|------|
| skill | ` + "`.claude/skills/<name>/SKILL.md`" + ` |
| rule | ` + "`.claude/rules/<name>.md`" + ` |
| hook | ` + "`.claude/hooks.json`" + ` (or settings.json hooks section) |
| agent | ` + "`.claude/agents/<name>.md`" + ` |
| mcp | ` + "`.mcp.json`" + ` |
| claude-md | ` + "`CLAUDE.md`" + ` (project root) |
| memory | Auto memory path ` + "`MEMORY.md`" + ` |

## Guardrails

- Do NOT generate without checking user preferences first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
`,
	},
	{
		Dir: "polish",
		Content: `---
name: polish
description: >
  Update an existing Claude Code configuration file (skill, rule, hook,
  agent, CLAUDE.md, memory, MCP) against latest best practices. Reads the
  current file, compares with knowledge base, proposes improvements.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences
context: current
---

The butler polishes what already exists — making it shine against current standards.

## Steps

1. **[WHAT]** Determine target:
   - Parse $ARGUMENTS for type and name: ` + "`skill foo`" + `, ` + "`rule go-errors`" + `, ` + "`claude-md`" + `, etc.
   - If not provided, ask with AskUserQuestion
   - Locate file using target paths (same as ` + "`/prepare`" + `)

2. **[HOW]** Read current file:
   - Read the target file content in full
   - If file not found, suggest using ` + "`/prepare`" + ` instead

3. **[HOW]** Load context:
   - Call ` + "`preferences`" + ` with action="get"
   - Call ` + "`knowledge`" + ` with query about latest best practices for this type

4. **[WHAT]** Compare and identify gaps (type-specific):
   - **skill**: constraint tags present (HOW/WHAT/Template/Guardrails), tool least-privilege, argument-hint, context choice
   - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
   - **hook**: timeout values appropriate, matchers specific, handler robust
   - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
   - **mcp**: env vars for secrets, valid command
   - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
   - **memory**: <200 lines, topic-organized, no session-specific content

5. **[Template]** Present proposed changes:
   ` + "```" + `
   ## Proposed Changes

   ### 1. [What changed] — Why
   - Before: ...
   - After: ...

   ### 2. ...

   Apply these changes? (y/n)
   ` + "```" + `

6. **[HOW]** Apply changes:
   - Use Edit tool to apply approved changes (preserve unchanged sections)
   - Do NOT rewrite the entire file

7. **[HOW]** Independent review:
   - Spawn Explore agent to validate the updated file
   - Fix any issues found

## Guardrails

- Do NOT rewrite sections the user didn't ask to change
- Do NOT apply changes without showing the diff and getting approval
- Do NOT remove user customizations that don't conflict with best practices
- Do NOT suggest changes that conflict with user preferences
- Preserve the user's voice and style in the file
`,
	},
	{
		Dir: "greetings",
		Content: `---
name: greetings
description: >
  Interactive wizard to set up Claude Code best practices for your project.
  Creates CLAUDE.md, hooks, skills, rules, and MCP configuration step by step.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences, mcp__alfred__review
context: current
---

Welcome to the estate — the butler prepares everything for a new master.

## Steps

1. **[HOW]** Assess current setup:
   - Call ` + "`review`" + ` with project_path=$CWD to see what already exists
   - Call ` + "`preferences`" + ` with action="get" to load user style

2. **[WHAT]** Show setup status and ask what to configure:
   - Present current state: ` + "`[x] CLAUDE.md`" + `, ` + "`[ ] Hooks`" + `, etc.
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

3. **[HOW]** For each selected item, run the creation flow:
   - Follow the same generation logic as ` + "`/prepare`" + ` for each type
   - But streamlined — use sensible defaults based on detected project stack
   - Ask fewer questions than standalone ` + "`/prepare`" + ` (wizard mode)

4. **[HOW]** Detect project stack automatically:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

5. **[HOW]** Verify setup:
   - Call ` + "`review`" + ` again to check improvement
   - Report before/after score

6. **[Template]** Final output:
   ` + "```" + `
   ## Setup Complete

   Created:
   - CLAUDE.md (N lines)
   - .claude/hooks.json (N hooks)
   - ...

   Setup Score: N/10 (was M/10)

   Next: Try asking Claude Code about your project — alfred's knowledge
   base will help provide better answers.
   ` + "```" + `

## Guardrails

- Do NOT overwrite existing files without asking
- Do NOT create configurations that conflict with each other
- Do NOT ask more than 2 questions per item (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
`,
	},
	{
		Dir: "brief",
		Content: `---
name: brief
description: >
  Explain any Claude Code feature with concrete examples. Covers hooks,
  skills, rules, agents, MCP, memory, worktrees, teams, and more.
user-invocable: true
argument-hint: "<feature>"
allowed-tools: AskUserQuestion, mcp__alfred__knowledge
context: current
---

The butler's morning briefing — concise, clear, actionable.

## Steps

1. **[WHAT]** Determine feature to explain:
   - If $ARGUMENTS provided, use as feature name
   - Otherwise, ask with AskUserQuestion: "Which feature would you like explained?"
     - Options: hooks, skills, rules, agents, MCP, memory, worktrees, teams

2. **[HOW]** Search knowledge base:
   - Call ` + "`knowledge`" + ` with query about the selected feature
   - If multiple results, synthesize the most relevant

3. **[Template]** Output format:
   ` + "```" + `
   ## <Feature Name>

   **What**: One sentence explanation.

   **When to use**:
   - Scenario 1
   - Scenario 2

   **Setup** (copy-pasteable):
   ` + "```" + `
   <minimal working example>
   ` + "```" + `

   **Tips**:
   - Practical tip 1
   - Practical tip 2
   ` + "```" + `

## Guardrails

- Do NOT output more than 20 lines unless the user asks for detail
- Do NOT fabricate features — only explain what's in the knowledge base
- Do NOT include boilerplate or generic advice — be specific and practical
- Do NOT explain multiple features at once — focus on the one requested
`,
	},
	{
		Dir: "memorize",
		Content: `---
name: memorize
description: >
  Tell alfred about your Claude Code preferences and working style, or view
  what alfred already remembers. Preferences persist across all projects
  and sessions.
user-invocable: true
argument-hint: "[preference to remember]"
allowed-tools: AskUserQuestion, mcp__alfred__preferences
context: current
---

The butler memorizes the master's preferences — every detail matters.

## Steps

1. **[WHAT]** Determine intent:
   - If $ARGUMENTS provided: treat as a preference to remember → go to Step 3
   - If no arguments: show current preferences first

2. **[HOW]** Show current preferences:
   - Call ` + "`preferences`" + ` with action="get" (no filters)
   - Group by category and display:
     ` + "```" + `
     ## Your Preferences

     ### Coding Style
     - language: Go
     - ...

     ### Workflow
     - ...
     ` + "```" + `
   - If empty: "No preferences recorded yet. Tell me what you'd like me to remember."

3. **[HOW]** Record new preference:
   - Parse the preference from $ARGUMENTS or ask with AskUserQuestion:
     - Category: coding_style, workflow, communication, tools
     - Key: descriptive, reusable identifier
     - Value: concrete, actionable preference
   - Call ` + "`preferences`" + ` with action="set", source="explicit"

4. **[Template]** Confirm:
   ` + "```" + `
   Remembered: [category] / [key] = [value]
   ` + "```" + `

## Guardrails

- Do NOT infer preferences without explicit user confirmation
- Do NOT store vague or ambiguous values — ask for clarification
- Do NOT overwrite existing preferences without showing the current value first
- Keep keys short and descriptive (e.g., "commit_style", "test_framework")
`,
	},
	{
		Dir: "harvest",
		Content: `---
name: harvest
description: >
  Manually refresh the alfred knowledge base. Normally auto-harvest keeps
  docs fresh automatically — use this for forced full crawl or targeted
  page updates.
user-invocable: true
argument-hint: "[--force | page-topic]"
allowed-tools: WebFetch, WebSearch, mcp__alfred__ingest, mcp__alfred__knowledge
context: fork
agent: general-purpose
---

The butler's procurement run — gathering the finest ingredients for the knowledge base.

## Steps

1. **[HOW]** Check current KB freshness:
   - Call ` + "`knowledge`" + ` with query="Claude Code changelog latest version" (limit=1)
   - Note the ` + "`version`" + ` and ` + "`freshness_days`" + ` from the result
   - If no results, treat as empty KB → go to Step 4 (full crawl)

2. **[HOW]** Fetch latest changelog:
   - WebFetch url="https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md" with prompt="Extract the latest 5 version entries. For each entry return: version number, release date, and a list of changes. Focus on changes to: hooks, skills, plugins, MCP, agents, rules, settings. Return as JSON array."

3. **[WHAT]** Determine action:
   - If $ARGUMENTS contains "--force": skip freshness check, go to Step 4 (full crawl)
   - If $ARGUMENTS contains a page topic (e.g., "hooks"): go to Step 5 (targeted)
   - If KB version matches latest AND freshness < 7 days:
     → Report "Knowledge base is up to date (vX.Y.Z, N days old)" and STOP
   - Otherwise: identify affected doc pages from changelog diff

4. **[HOW]** Full crawl (empty KB, --force, or major version jump):
   - WebFetch url="https://code.claude.com/docs/llms.txt" to get full docs index
   - Fetch each page and split into sections by h2/h3 headings
   - For each page: WebFetch with prompt="Split content into sections by h2/h3 headings. Return as JSON array of {path, content} objects where path is 'Page Title > Section Heading'. Omit navigation and boilerplate."
   - Call ` + "`ingest`" + ` with url, sections, source_type="docs"
   - Go to Step 6

5. **[HOW]** Targeted update (specific page or changelog-diff):
   - Map topics to doc URLs:
     - hooks → https://code.claude.com/docs/en/hooks
     - skills → https://code.claude.com/docs/en/skills
     - plugins → https://code.claude.com/docs/en/plugins-reference
     - mcp → https://code.claude.com/docs/en/mcp
     - settings → https://code.claude.com/docs/en/settings
     - agents → https://code.claude.com/docs/en/agents
     - rules → https://code.claude.com/docs/en/rules
     - memory → https://code.claude.com/docs/en/memory
   - Fetch only affected pages, split into sections, ingest

6. **[HOW]** Ingest changelog entries:
   - Split new changelog versions into sections
   - Call ` + "`ingest`" + ` with source_type="changelog", version=<version number>

7. **[WHAT]** Verify:
   - Call ` + "`knowledge`" + ` with a test query related to the updated content
   - Report summary: "Updated N pages, ingested changelog vX.Y.Z"

## Guardrails

- Do NOT crawl all pages unless KB is empty or --force is specified
- Do NOT ingest sections > 2000 chars (split further)
- Do NOT stop on individual page failures — skip and continue
- Do NOT ingest navigation, footer, or boilerplate content
- Do NOT make WebFetch calls if Step 3 determines KB is up to date
`,
	},
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	// v0.1-v0.19 era
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
	// v0.20-v0.22 era
	"alfred-recover",
	"alfred-gate",
	"alfred-analyze",
	"alfred-forecast",
	"alfred-context-recovery",
	"alfred-crawl",
	// v0.23 era (alfred- prefix removed in v0.24)
	"alfred-create-skill",
	"alfred-create-rule",
	"alfred-create-hook",
	"alfred-create-agent",
	"alfred-create-mcp",
	"alfred-create-claude-md",
	"alfred-create-memory",
	"alfred-review",
	"alfred-audit",
	"alfred-learn",
	"alfred-preferences",
	"alfred-update-docs",
	"alfred-update",
	"alfred-setup",
	"alfred-migrate",
	"alfred-explain",
	// v0.24-v0.26 era (renamed to butler-style in v0.27)
	"create-skill",
	"create-rule",
	"create-hook",
	"create-agent",
	"create-mcp",
	"create-claude-md",
	"create-memory",
	"review",
	"audit",
	"learn",
	"preferences",
	"update-docs",
	"update",
	"setup",
	"migrate",
	"explain",
}

// installSkills writes alfred skills to ~/.claude/skills/ and cleans up
// deprecated skill directories from previous versions.
func installSkills() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	skillsBase := filepath.Join(home, ".claude", "skills")

	var installed int
	for _, skill := range alfredSkills {
		dir := filepath.Join(skillsBase, skill.Dir)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: skill dir %s: %v\n", skill.Dir, err)
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: skill %s: %v\n", skill.Dir, err)
			continue
		}
		installed++
	}

	// Clean up deprecated directories.
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(skillsBase, dir))
	}

	fmt.Printf("✓ %d skills installed\n", installed)
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
