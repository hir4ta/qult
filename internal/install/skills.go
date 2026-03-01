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
	// ─── Create: 構築系 ─────────────────────────────────────────────────

	{
		Dir: "alfred-create-skill",
		Content: `---
name: alfred-create-skill
description: >
  Generate a new Claude Code skill file following latest best practices
  and the user's preferences.
user-invocable: true
argument-hint: "[skill-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code skill.

## Steps

1. **[HOW]** Call preferences with action="get" to load user's coding style and workflow preferences
2. **[HOW]** Ask the user with AskUserQuestion:
   - "What should this skill do?" (free text)
   - "Should it be user-invocable?" (yes/no)
   - "Should it run in a forked context?" (yes for heavy exploration, no for quick tasks)
3. **[HOW]** Check existing skills with Glob pattern=".claude/skills/*/SKILL.md" to avoid name collisions
4. **[Template]** Generate SKILL.md using the template below, filling in user's requirements
5. **[WHAT]** Validate the generated skill against these criteria:
   - name field: lowercase, hyphens only, max 64 chars
   - description field: present and specific (not vague like "does stuff")
   - Each step tagged with constraint type (HOW/WHAT/Template/Guardrails)
   - allowed-tools: only tools actually needed (principle of least privilege)
   - If context=fork, agent field must be set
6. **[HOW]** Apply user preferences (language, style) to the generated content
7. **[HOW]** Write the file to .claude/skills/<name>/SKILL.md
8. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/skills/<name>/SKILL.md and validate against Claude Code skill spec. Check: (1) frontmatter has required name+description, (2) all steps have constraint type tags [HOW/WHAT/Template/Guardrails], (3) allowed-tools follows least privilege, (4) guardrails section exists with concrete prohibitions, (5) call mcp__claude-alfred__knowledge with query='Claude Code skill best practices' to verify against latest docs. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```yaml" + `
---
name: <skill-name>
description: >
  <one-line description of when Claude should use this skill>
user-invocable: true
argument-hint: "[optional-args]"
allowed-tools: <comma-separated list>
# context: fork          # uncomment for heavy exploration
# agent: general-purpose # required when context=fork
---

<Brief description of what the skill does.>

## Steps

1. **[HOW/WHAT/Template/Guardrails]** <step description>
2. ...

## Output

<Expected output format>

## Guardrails

- <things the skill must NOT do>
` + "```" + `

## Guardrails

- Do NOT create skills with vague descriptions
- Do NOT allow tools the skill doesn't actually need
- Do NOT omit constraint type tags on steps
`,
	},
	{
		Dir: "alfred-create-rule",
		Content: `---
name: alfred-create-rule
description: >
  Generate a new Claude Code rule file following latest best practices
  and the user's preferences.
user-invocable: true
argument-hint: "[rule-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code rule.

## Steps

1. **[HOW]** Call preferences with action="get" to load user preferences
2. **[HOW]** Ask the user:
   - "What convention should this rule enforce?" (free text)
   - "Which files should it apply to?" (glob pattern, e.g. "**/*.go")
3. **[HOW]** Check existing rules with Glob pattern=".claude/rules/*.md"
4. **[Template]** Generate the rule using the template below
5. **[WHAT]** Validate:
   - paths field: valid glob patterns, specific enough to avoid over-matching
   - Instructions: actionable ("use X" not "consider using X")
   - Concise: rules inject into context on every match — keep short
6. **[HOW]** Write to .claude/rules/<name>.md
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/rules/<name>.md and validate against Claude Code rule spec. Check: (1) paths field has valid glob patterns, (2) instructions are actionable (no 'consider'/'try to'), (3) not duplicating CLAUDE.md content, (4) concise (under 20 lines), (5) call mcp__claude-alfred__knowledge with query='Claude Code rule best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```yaml" + `
---
paths:
  - "**/*.ext"
---

# <Rule Name>

- <actionable instruction 1>
- <actionable instruction 2>
` + "```" + `

## Guardrails

- Do NOT create rules without paths (unless user explicitly wants a global rule)
- Do NOT duplicate CLAUDE.md content in rules
- Do NOT write vague instructions ("consider" → "use", "try to" → "always")
`,
	},
	{
		Dir: "alfred-create-hook",
		Content: `---
name: alfred-create-hook
description: >
  Generate Claude Code hook configuration and handler script following
  latest best practices and the user's preferences.
user-invocable: true
argument-hint: "[event-name]"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code hook.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences
2. **[HOW]** Ask the user:
   - "Which event?" (PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop, etc.)
   - "What should the hook do?" (free text)
   - "Should it block on failure?" (yes for PreToolUse gates, no for async)
3. **[HOW]** Read existing .claude/hooks.json or settings.json hooks section if present
4. **[Template]** Generate hook configuration using the template below
5. **[WHAT]** Validate:
   - timeout: ≤ 5s for PreToolUse (blocks workflow), ≤ 30s for others
   - matcher: regex that matches only intended tools (not overly broad)
   - Handler type: command for scripts, prompt for AI-powered checks, http for webhooks
   - If PreToolUse: non-zero exit must have a clear, helpful error message
6. **[HOW]** Write/update hooks configuration and handler script
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated hook in a separate context:
   - Prompt: "Read the generated hook config and handler script. Check: (1) timeout appropriate for event type (≤5s for PreToolUse), (2) matcher not overly broad, (3) handler script is executable, (4) PreToolUse hooks have clear error messages on failure, (5) call mcp__claude-alfred__knowledge with query='Claude Code hook best practices timeout matcher' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template (hooks.json entry)

` + "```json" + `
{
  "EventName": [{
    "matcher": "ToolPattern",
    "hooks": [{
      "type": "command",
      "command": ".claude/scripts/hook-name.sh",
      "timeout": 5
    }]
  }]
}
` + "```" + `

## Available Hook Types

- command: Shell script (default, most common)
- prompt: AI-powered check using a model prompt
- agent: Full agent with tools for complex validation
- http: POST to external URL

## Guardrails

- Do NOT set timeout > 5s for PreToolUse hooks (blocks user workflow)
- Do NOT use overly broad matchers (e.g. ".*" catches everything)
- Do NOT forget to make handler scripts executable (chmod +x)
`,
	},
	{
		Dir: "alfred-create-agent",
		Content: `---
name: alfred-create-agent
description: >
  Generate a custom Claude Code agent definition following latest best
  practices and the user's preferences.
user-invocable: true
argument-hint: "[agent-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new custom agent.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences
2. **[HOW]** Ask the user:
   - "What should this agent specialize in?" (free text)
   - "Which tools should it have access to?" (suggest based on purpose)
   - "Should it have persistent memory?" (user/project/local)
3. **[HOW]** Check existing agents with Glob pattern=".claude/agents/*.md"
4. **[Template]** Generate agent markdown using the template below
5. **[WHAT]** Validate:
   - name: required, lowercase letters and hyphens
   - description: required, describes WHEN to delegate (not just what it does)
   - tools: minimal set needed (principle of least privilege)
   - model: explicit (sonnet for most, haiku for fast read-only, opus for complex)
6. **[HOW]** Write to .claude/agents/<name>.md
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/agents/<name>.md and validate against Claude Code agent spec. Check: (1) frontmatter has name+description+tools+model, (2) description explains WHEN to delegate (not just what it does), (3) tools follow least privilege, (4) model is explicit, (5) call mcp__claude-alfred__knowledge with query='Claude Code custom agent definition best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```yaml" + `
---
name: <agent-name>
description: >
  <When Claude should delegate to this agent. Be specific about triggers.>
tools: <comma-separated list>
model: sonnet
maxTurns: 30
# memory: user   # uncomment for persistent cross-session memory
---

<Agent instructions. Be direct about role and output format.>

## Decision Flow

1. <first action>
2. <second action>

## Output Format

- <expected output structure>
` + "```" + `

## Guardrails

- Do NOT give agents Write/Edit tools unless they need to modify files
- Do NOT omit model field (implicit inherit may pick wrong model)
- Do NOT write vague descriptions — agents need clear delegation triggers
`,
	},
	{
		Dir: "alfred-create-mcp",
		Content: `---
name: alfred-create-mcp
description: >
  Configure a new MCP server in the project's .mcp.json following
  latest best practices.
user-invocable: true
argument-hint: "[server-name]"
allowed-tools: Read, Write, Edit, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Configure a new MCP server.

## Steps

1. **[HOW]** Ask the user:
   - "What MCP server do you want to add?" (name or npm package)
   - "Is it a local command or remote SSE server?" (stdio/sse)
2. **[HOW]** Read existing .mcp.json if present
3. **[Template]** Add the server configuration using the template below
4. **[WHAT]** Validate:
   - command: points to an executable that exists or will be installed
   - env: API keys use environment variables, not hardcoded values
   - Tool namespace: will be mcp__<server-name>__<tool-name>
5. **[HOW]** Write/update .mcp.json
6. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated config in a separate context:
   - Prompt: "Read .mcp.json and validate the new MCP server entry. Check: (1) command path exists or is a known package, (2) no hardcoded API keys (must use env vars), (3) args array is valid, (4) call mcp__claude-alfred__knowledge with query='Claude Code MCP server configuration best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```json" + `
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
` + "```" + `

## Guardrails

- Do NOT hardcode API keys in .mcp.json — use environment variables
- Do NOT add servers without verifying the command exists
`,
	},
	{
		Dir: "alfred-create-claude-md",
		Content: `---
name: alfred-create-claude-md
description: >
  Create or improve a project's CLAUDE.md from project structure analysis,
  best practices, and the user's preferences.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create or improve CLAUDE.md.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences (language, style)
2. **[HOW]** Detect project stack:
   - Glob for go.mod, package.json, Cargo.toml, pyproject.toml, etc.
   - Read the detected config file to identify stack and dependencies
3. **[HOW]** Scan project structure with Glob and Bash (directory listing)
4. **[HOW]** Read existing CLAUDE.md if present
5. **[Template]** Generate or improve CLAUDE.md using the template below
6. **[WHAT]** Validate:
   - Under 200 lines (every line costs context window)
   - Has ## Stack, ## Commands, ## Structure, ## Rules sections
   - Commands are copy-pasteable (not relative or ambiguous)
   - Rules are actionable ("use X" not "consider using X")
   - No duplicate content from README
   - No environment-specific paths
7. **[HOW]** Write CLAUDE.md
8. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read CLAUDE.md and validate against Claude Code best practices. Check: (1) under 200 lines, (2) has Stack/Commands/Structure/Rules sections, (3) commands are copy-pasteable, (4) rules are actionable (no 'consider'/'try to'), (5) no README duplication, (6) call mcp__claude-alfred__knowledge with query='CLAUDE.md best practices structure' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```markdown" + `
# <project-name>

<one-line description>

## Stack

<language> / <framework> / <key deps>

## Commands

` + "```" + `bash
<build command>
<test command>
<lint command>
` + "```" + `

## Structure

| Package | Role |
|---------|------|
| <dir>   | <purpose> |

## Rules

- <actionable rule 1>
- <actionable rule 2>
` + "```" + `

## Guardrails

- Do NOT exceed 200 lines
- Do NOT duplicate README content
- Do NOT include environment-specific paths
- Do NOT write vague rules
`,
	},
	{
		Dir: "alfred-create-memory",
		Content: `---
name: alfred-create-memory
description: >
  Set up project memory directory and MEMORY.md template for persistent
  context across conversations.
user-invocable: true
allowed-tools: Read, Write, Glob, Agent, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Set up project memory.

## Steps

1. **[HOW]** Check if .claude/memory/ or MEMORY.md already exists
2. **[HOW]** Call preferences with action="get" for user preferences
3. **[Template]** Create MEMORY.md at the auto memory path using the template below
4. **[WHAT]** Validate:
   - Under 200 lines (first 200 lines auto-loaded per session)
   - Organized by topic, not chronologically
   - No session-specific or temporary context
   - No sensitive data (credentials, API keys)
5. **[HOW]** Optionally create topic files in .claude/memory/ for detailed notes
6. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read the generated MEMORY.md and validate. Check: (1) under 200 lines, (2) organized by topic not chronologically, (3) no session-specific context, (4) no sensitive data, (5) call mcp__claude-alfred__knowledge with query='Claude Code memory best practices auto memory' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

` + "```markdown" + `
# Project Memory

## Architecture Decisions

- <key decision 1>

## Patterns & Conventions

- <confirmed pattern 1>

## Workflow Preferences

- <preference 1>

## Known Issues

- <recurring issue and its solution>
` + "```" + `

## Guardrails

- Do NOT store session-specific context (current task, in-progress work)
- Do NOT store unverified conclusions
- Do NOT store sensitive data (credentials, API keys)
- Do NOT exceed 200 lines
`,
	},

	// ─── Analyze: 分析系 ────────────────────────────────────────────────

	{
		Dir: "alfred-review",
		Content: `---
name: alfred-review
description: >
  Full Claude Code utilization report for your project. Analyzes CLAUDE.md,
  skills, rules, hooks, MCP servers, and session history. Returns
  improvement suggestions backed by best practices.
user-invocable: true
allowed-tools: mcp__claude-alfred__review, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
context: fork
agent: general-purpose
---

Project utilization review.

## Steps

1. **[HOW]** Call review with project_path set to the current working directory
2. **[HOW]** Call knowledge with query="Claude Code best practices setup checklist"
3. **[HOW]** Call preferences with action="get" to understand user's context
4. **[WHAT]** Compare the review results against these criteria:
   - CLAUDE.md: exists, under 200 lines, has Commands/Rules/Structure sections
   - Skills: each has name, description, constraint-tagged steps, guardrails
   - Rules: each has paths field, actionable instructions
   - Hooks: timeout appropriate for event type, matcher not overly broad
   - Agent: has name, description, tools, model fields
5. **[Template]** Generate report in the format below

## Output

**Setup Score**: X/10 (based on features in use and quality)
**In Use**: [list of configured features]
**Missing**: [features not yet configured, with brief value explanation]
**Top 3 Improvements**: ordered by impact, each with:
  - What: specific change
  - Why: concrete benefit
  - How: one-line example or command

## Guardrails

- Do NOT suggest features the user has explicitly chosen not to use (check preferences)
- Do NOT give vague suggestions ("improve your hooks" → "add PreToolUse hook for lint: ...")
`,
	},
	{
		Dir: "alfred-audit",
		Content: `---
name: alfred-audit
description: >
  Quick setup check against Claude Code best practices. Lighter than
  a full review — just checks configuration exists and is well-formed.
user-invocable: true
allowed-tools: Read, Glob, mcp__claude-alfred__review
context: fork
agent: Explore
---

Quick setup audit.

## Steps

1. **[HOW]** Call review with project_path set to the current working directory
2. **[WHAT]** For each configuration item, check:
   - Exists and is non-empty
   - Follows official format (frontmatter present where required)
   - No obvious anti-patterns (e.g., CLAUDE.md > 200 lines, skills without descriptions)

## Output

` + "```" + `
[x] CLAUDE.md (N lines)
[x] Skills (N configured)
[ ] Hooks (not configured — add for automated checks)
...
` + "```" + `

One-line suggestion for each missing item. Keep under 10 lines.

## Guardrails

- Do NOT read file contents for audit — just check existence and basic structure
- Do NOT suggest installing alfred's own features as improvements
`,
	},

	// ─── Learn: 学習系 ──────────────────────────────────────────────────

	{
		Dir: "alfred-learn",
		Content: `---
name: alfred-learn
description: >
  Tell alfred about your Claude Code preferences and working style.
  Records preferences that persist across all projects and sessions.
user-invocable: true
allowed-tools: AskUserQuestion, mcp__claude-alfred__preferences
---

Record your preferences.

## Steps

1. **[HOW]** Call preferences with action="get" to show current preferences
2. **[HOW]** Ask the user with AskUserQuestion:

   "What would you like alfred to remember?"
   - "Coding style preference" (e.g., commit language, testing approach)
   - "Workflow preference" (e.g., always use plan mode, prefer TDD)
   - "Tool preference" (e.g., preferred test runner, linter)
   - Other (free text)

3. **[HOW]** Based on selection, ask for the specific preference value
4. **[WHAT]** Validate:
   - Category is one of: coding_style, workflow, communication, tools
   - Key is specific and reusable (e.g. "commit_language" not "my preference")
   - Value is concrete (e.g. "japanese" not "I prefer japanese sometimes")
5. **[HOW]** Call preferences with action="set", appropriate category/key/value, source="explicit"

## Output

Confirm: Category / Key = Value. "This will be applied in future create operations."

## Guardrails

- Do NOT infer preferences without explicit user confirmation
- Do NOT store vague or ambiguous values
`,
	},
	{
		Dir: "alfred-preferences",
		Content: `---
name: alfred-preferences
description: >
  View all preferences alfred remembers about you. Shows coding style,
  workflow, communication, and tool preferences.
user-invocable: true
allowed-tools: mcp__claude-alfred__preferences
---

View your recorded preferences.

## Steps

1. **[HOW]** Call preferences with action="get" (no category filter — get all)
2. **[Template]** Group by category and display in the format below

## Output

**Coding Style**
- [key]: [value] (source: explicit/inferred)

**Workflow**
- ...

If no preferences: "No preferences recorded yet. Use /alfred:learn to teach alfred."

## Guardrails

- Do NOT modify preferences in this skill — it's read-only
`,
	},
	{
		Dir: "alfred-update-docs",
		Content: `---
name: alfred-update-docs
description: >
  Crawl Claude Code documentation and ingest into the alfred knowledge
  base for semantic search. Updates existing docs and adds new ones.
user-invocable: true
allowed-tools: WebFetch, WebSearch, mcp__claude-alfred__ingest, mcp__claude-alfred__knowledge
context: fork
agent: general-purpose
---

Documentation crawler for the knowledge base.

## Steps

1. **[HOW]** Fetch the docs index page:
   - WebFetch url="https://docs.claude.com/en/docs" with prompt="Extract all documentation page URLs from the sidebar navigation. Return as a JSON array of {url, title} objects."

2. **[HOW]** For each documentation page:
   - WebFetch the page URL with prompt="Split the page content into sections by h2/h3 headings. Return as a JSON array of {path, content} objects where path is 'Page Title > Section Heading' and content is the section text. Omit navigation and boilerplate."
   - Call ingest with url, sections, source_type="docs"

3. **[HOW]** Fetch the changelog:
   - WebSearch query="Claude Code changelog site:docs.claude.com"
   - WebFetch and split into version entries
   - Call ingest with source_type="changelog"

4. **[WHAT]** Verify: Call knowledge with a test query to confirm ingestion worked

## Guardrails

- Do NOT ingest sections > 2000 chars (split further)
- Do NOT stop on individual page failures — skip and continue
- Do NOT ingest navigation, footer, or boilerplate content
`,
	},

	// ─── Update: 更新系 ─────────────────────────────────────────────────

	{
		Dir: "alfred-update",
		Content: `---
name: alfred-update
description: >
  Update an existing Claude Code configuration file (skill, rule, hook, agent,
  CLAUDE.md, memory) against latest best practices. Reads the current file,
  compares with knowledge base, proposes improvements, and validates in a
  separate review context.
user-invocable: true
argument-hint: "<type> [name]  (e.g. skill my-skill, rule go-errors, claude-md)"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Update an existing Claude Code configuration file.

## Steps

1. **[HOW]** Parse $ARGUMENTS to determine target type and name:
   - Valid types: skill, rule, hook, agent, claude-md, memory, mcp
   - If no arguments, ask with AskUserQuestion: "What do you want to update?" (skill/rule/hook/agent/claude-md/memory/mcp)
2. **[HOW]** Locate the target file:
   - skill: .claude/skills/<name>/SKILL.md
   - rule: .claude/rules/<name>.md
   - hook: .claude/hooks.json (or settings.json hooks section)
   - agent: .claude/agents/<name>.md
   - claude-md: CLAUDE.md
   - memory: auto memory path MEMORY.md
   - mcp: .mcp.json
   - If name not specified and multiple exist, list them and ask which one
3. **[HOW]** Read the current file content
4. **[HOW]** Call preferences with action="get" to load user preferences
5. **[HOW]** Call knowledge to fetch latest best practices for this file type:
   - query: "Claude Code <type> best practices latest spec"
6. **[WHAT]** Compare current file against best practices and identify gaps:
   - skill: missing constraint type tags? missing guardrails? vague description? missing argument-hint?
   - rule: missing paths? vague instructions? too long?
   - hook: timeout too high? matcher too broad? missing error messages?
   - agent: missing model? vague description? excessive tools?
   - claude-md: over 200 lines? missing sections? vague rules?
   - memory: over 200 lines? chronological instead of topical? sensitive data?
   - mcp: hardcoded API keys? missing env vars?
7. **[HOW]** Present the proposed changes as a diff to the user:
   - Show each change with WHY it improves the file
   - Ask for approval before applying
8. **[HOW]** Apply approved changes with Edit tool (preserve unchanged sections)
9. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the updated file in a separate context:
   - Prompt: "Read <file-path> and validate against Claude Code <type> spec. Compare with latest best practices via mcp__claude-alfred__knowledge. Check all quality criteria for this file type. Report PASS or list specific remaining issues."
   - If issues found: present to user and offer to fix

## Guardrails

- Do NOT overwrite the file without showing changes and getting approval first
- Do NOT change content the user intentionally customized (check preferences)
- Do NOT add boilerplate the user previously removed (check git history if available)
- Do NOT apply changes silently — always explain WHY each change improves the file
`,
	},

	// ─── Power: 応用系 ──────────────────────────────────────────────────

	{
		Dir: "alfred-setup",
		Content: `---
name: alfred-setup
description: >
  Interactive wizard to set up Claude Code best practices for your project.
  Creates CLAUDE.md, hooks, skills, rules, and MCP configuration step by step.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences, mcp__claude-alfred__review
---

Project setup wizard.

## Steps

1. **[HOW]** Call review with project_path to assess current setup
2. **[HOW]** Call preferences with action="get" for user preferences
3. **[HOW]** Show current setup status and ask what to configure:
   - AskUserQuestion with multiSelect: CLAUDE.md, Skills, Rules, Hooks, MCP, Memory
4. **[HOW]** For each selected item, run the corresponding create flow:
   - Each create flow follows its own skill's template and validation
5. **[WHAT]** After all items created, call review again and verify:
   - Setup score improved
   - No configuration conflicts (e.g. hook and rule targeting same concern)

## Guardrails

- Do NOT create all items without user selection — let them choose
- Do NOT skip validation steps from individual create skills
`,
	},
	{
		Dir: "alfred-migrate",
		Content: `---
name: alfred-migrate
description: >
  Compare your current Claude Code setup against latest best practices
  and generate migration suggestions. Shows what's outdated and how to update.
user-invocable: true
allowed-tools: Read, Glob, Bash, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__review, mcp__claude-alfred__preferences
context: fork
agent: general-purpose
---

Setup migration advisor.

## Steps

1. **[HOW]** Call review with project_path to get current setup analysis
2. **[HOW]** Call knowledge with query="Claude Code latest features changelog new capabilities"
3. **[WHAT]** Compare current setup against latest best practices:
   - Skills: have constraint-type tags? argument-hint? guardrails section?
   - Hooks: using new event types (Stop, ConfigChange, prompt/agent handler types)?
   - Agents: have maxTurns, memory, skills preloading?
   - CLAUDE.md: using @imports? Under 200 lines?
4. **[HOW]** Call preferences with action="get" to filter by user preferences
5. **[Template]** Generate migration plan

## Output

**Available Updates** (ordered by impact):
1. [feature]: [current state] → [recommended state]
   - How: [specific change]

## Guardrails

- Do NOT suggest changes that would break existing workflows
- Do NOT include changes the user has explicitly rejected (check preferences)
`,
	},
	{
		Dir: "alfred-explain",
		Content: `---
name: alfred-explain
description: >
  Explain any Claude Code feature with concrete examples. Covers hooks,
  skills, rules, agents, MCP, memory, worktrees, teams, and more.
user-invocable: true
argument-hint: "[feature-name]"
allowed-tools: AskUserQuestion, mcp__claude-alfred__knowledge
---

Claude Code feature explainer.

## Steps

1. **[HOW]** If $ARGUMENTS is provided, use it as the feature name. Otherwise ask:
   "Which feature would you like to learn about?"
   - Hooks, Skills, Rules, Agents, MCP Servers, Memory, Other
2. **[HOW]** Call knowledge with query about the selected feature
3. **[Template]** Explain using this format:

## Output

**[Feature Name]**

**What**: <one sentence>
**When to use**: <2-3 concrete scenarios>
**Setup**:
` + "```" + `
<minimal working example, copy-pasteable>
` + "```" + `
**Tips**: <2-3 practical tips>

## Guardrails

- Do NOT write abstract descriptions — every explanation needs a concrete example
- Do NOT explain multiple features at once — focus on the one requested
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
