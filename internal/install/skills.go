package install
type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var alfredSkills = []skillDef{
	{
		Dir: "configure",
		Content: `---
name: configure
description: >
  Create or polish a single Claude Code configuration file (skill, rule, hook,
  agent, MCP server, CLAUDE.md, or memory) with independent review.
  For project-wide setup, use /alfred:setup instead.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__alfred__knowledge
context: current
---

The butler tends to the estate's configuration — whether building new or polishing existing.

## Steps

1. **[WHAT]** Determine target type from $ARGUMENTS:
   - Parse for type: ` + "`skill`" + `, ` + "`rule`" + `, ` + "`hook`" + `, ` + "`agent`" + `, ` + "`mcp`" + `, ` + "`claude-md`" + `, ` + "`memory`" + `
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

2. **[HOW]** Check if target file exists:
   - Glob for existing files at the target path (see Target Paths below)

3. **[HOW]** If file EXISTS (polish flow):
   - Read the current file content in full
   - Call ` + "`knowledge`" + ` with query about latest best practices for this type
   - Compare against best practices and identify gaps (type-specific):
     - **skill**: constraint tags (HOW/WHAT/Template/Guardrails), tool least-privilege, argument-hint, context choice
     - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
     - **hook**: timeout values appropriate, matchers specific, handler robust
     - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
     - **mcp**: env vars for secrets, valid command
     - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
     - **memory**: <200 lines, topic-organized, no session-specific content
   - Present proposed changes with before/after diff and ask for approval
   - Use Edit tool to apply approved changes (preserve unchanged sections)

4. **[HOW]** If file is NEW (prepare flow):
   - Gather requirements (type-specific):
     - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
     - **rule**: enforcement concept, glob patterns (e.g., ` + "`**/*.go`" + `)
     - **hook**: event type, handler purpose, blocking behavior
     - **agent**: specialization, required tools, memory type (user/project/local)
     - **mcp**: server name/npm package, server type (stdio/sse)
     - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
     - **memory**: check auto memory path, topic organization
   - Call ` + "`knowledge`" + ` with query about the specific type's best practices
   - Generate from type-specific template:
     - **skill**: frontmatter (name, description, allowed-tools, context, agent) + constraint tags (HOW/WHAT/Template/Guardrails)
     - **rule**: frontmatter with paths + actionable instructions (<20 lines)
     - **hook**: hooks.json entry (timeout, matcher, command) + handler script
     - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
     - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
     - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
     - **memory**: MEMORY.md template organized by topic

5. **[HOW]** Validate type-specific constraints:
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

6. **[HOW]** Write/Edit file to target path

7. **[HOW]** Independent review:
   - Spawn Explore agent to validate the generated/updated file against knowledge base
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

- Do NOT overwrite existing files without asking for approval first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
- Preserve the user's voice and style when updating existing files
`,
	},
	{
		Dir: "setup",
		Content: `---
name: setup
description: >
  Project-wide Claude Code setup wizard, or explain any Claude Code feature
  with examples. Scans the whole project and guides multi-file configuration.
  For single-file work, use /alfred:configure instead.
user-invocable: true
argument-hint: "[feature | --wizard]"
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__review
context: current
---

The butler welcomes the master and briefs them on the estate.

## Steps

1. **[WHAT]** Determine mode from $ARGUMENTS:
   - If arguments contain a feature name (hooks, skills, rules, agents, MCP, memory, worktrees, teams) → go to Step 2 (brief flow)
   - If arguments contain "--wizard" or no arguments → go to Step 3 (wizard flow)

2. **[HOW]** Brief flow — explain a feature:
   - Call ` + "`knowledge`" + ` with query about the selected feature
   - If multiple results, synthesize the most relevant
   - Output in template format:
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
   - STOP here

3. **[HOW]** Wizard flow — interactive setup:
   - Call ` + "`review`" + ` with project_path=$CWD to assess current setup
   - Present current state as a status checklist: ` + "`[x] CLAUDE.md`" + `, ` + "`[ ] Hooks`" + `, etc.

4. **[WHAT]** Ask what to configure:
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

5. **[HOW]** Auto-detect project stack:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

6. **[HOW]** Generate selected items:
   - For each selected item, follow generation logic with sensible defaults based on detected stack
   - Use streamlined wizard mode — ask fewer questions, prefer smart defaults

7. **[HOW]** Verify setup:
   - Call ` + "`review`" + ` again to check improvement
   - Report before/after score

8. **[Template]** Final output:
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
- Do NOT ask more than 2 questions per item in wizard mode (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
- Do NOT output more than 20 lines in brief mode unless the user asks for detail
- Do NOT fabricate features in brief mode — only explain what's in the knowledge base
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
	// v0.27-v0.28 era (consolidated into configure/setup/harvest)
	"inspect",
	"prepare",
	"polish",
	"greetings",
	"brief",
	"memorize",
}

