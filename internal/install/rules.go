package install

type ruleDef struct {
	File    string // filename under rules/
	Content string // markdown content
}

var alfredRules = []ruleDef{
	{
		File: "claude-md.md",
		Content: `---
paths:
  - "**/CLAUDE.md"
---

# CLAUDE.md Best Practices

CLAUDE.md is the primary instruction file for Claude Code. It's loaded into every conversation.

## Structure
- Keep it concise — every line consumes context window
- Use headers and bullet points for scannability
- Put the most important instructions first
- Use ` + "`## Commands`" + ` section for build/test/run commands
- Use ` + "`## Rules`" + ` section for coding conventions

## Content Guidelines
- Include: build commands, test commands, coding style, project structure
- Avoid: long explanations, documentation that belongs elsewhere
- Commands should be copy-pasteable (absolute paths or clear context)
- Rules should be actionable ("use X" not "consider using X")

## Common Patterns
- ` + "`## Stack`" + ` — language, framework, key dependencies
- ` + "`## Commands`" + ` — build, test, lint, run commands
- ` + "`## Structure`" + ` — directory layout table
- ` + "`## Rules`" + ` — coding conventions, do/don't lists

## Anti-patterns
- Don't duplicate README content
- Don't include environment-specific paths
- Don't add rules that contradict language conventions
- Don't make it longer than ~200 lines (context cost)
`,
	},
	{
		File: "skills.md",
		Content: `---
paths:
  - "**/.claude/skills/**"
  - "**/SKILL.md"
---

# Skills Best Practices

Skills are reusable prompt templates that Claude Code executes on demand.

## SKILL.md Frontmatter
Required fields:
- ` + "`name`" + ` — kebab-case identifier (e.g., ` + "`my-skill`" + `)
- ` + "`description`" + ` — when Claude should auto-invoke this skill

Optional fields:
- ` + "`user-invocable: true`" + ` — allows ` + "`/skill-name`" + ` invocation
- ` + "`allowed-tools`" + ` — comma-separated list of tools the skill can use
- ` + "`context: fork`" + ` — runs in a forked context (isolated from main conversation)
- ` + "`agent`" + ` — agent type for forked context (` + "`general-purpose`" + `, ` + "`Explore`" + `, etc.)

## Content Structure
1. Brief description of what the skill does
2. ` + "`## Steps`" + ` — numbered steps the skill follows
3. ` + "`## Output`" + ` — expected output format
4. ` + "`## Important Notes`" + ` — edge cases, constraints

## Tips
- Keep skills focused — one skill, one purpose
- Use ` + "`context: fork`" + ` for skills that do heavy exploration
- Reference MCP tools by full name: ` + "`mcp__server-name__tool-name`" + `
- Skills with ` + "`user-invocable: false`" + ` are auto-invoked by Claude when the description matches
`,
	},
	{
		File: "hooks.md",
		Content: `---
paths:
  - "**/.claude/hooks/**"
  - "**/hooks.json"
---

# Hooks Best Practices

Hooks run shell commands in response to Claude Code lifecycle events.

## Event Types
- ` + "`PreToolUse`" + ` — before a tool executes (can block with non-zero exit)
- ` + "`PostToolUse`" + ` — after a tool succeeds
- ` + "`PostToolUseFailure`" + ` — after a tool fails
- ` + "`UserPromptSubmit`" + ` — when user sends a message
- ` + "`SessionStart`" + ` — on session start/resume/compact
- ` + "`SessionEnd`" + ` — on session end
- ` + "`PreCompact`" + ` — before context compaction

## Hook Configuration (hooks.json)
` + "```json" + `
{
  "PreToolUse": [{
    "matcher": "Edit|Write",
    "hooks": [{
      "type": "command",
      "command": "./my-hook.sh",
      "timeout": 5
    }]
  }]
}
` + "```" + `

## Key Concepts
- ` + "`matcher`" + ` — regex to filter which tools trigger the hook
- ` + "`timeout`" + ` — seconds before the hook is killed (default: 60)
- ` + "`async: true`" + ` — hook runs in background, doesn't block
- Hooks receive event data via stdin (JSON)
- stdout is injected as ` + "`additionalContext`" + ` into the conversation
- Non-zero exit code on ` + "`PreToolUse`" + ` blocks the tool execution

## Tips
- Keep hooks fast (< 2s for synchronous hooks)
- Use ` + "`async: true`" + ` for data collection that doesn't need to block
- Use ` + "`matcher`" + ` to limit which tools trigger the hook
- Hook output goes into context — keep it concise
`,
	},
	{
		File: "agents.md",
		Content: `---
paths:
  - "**/.claude/agents/**"
---

# Custom Agents Best Practices

Custom agents are specialized agent configurations for the Agent tool.

## Agent File Format (.md in .claude/agents/)
` + "```markdown" + `
---
name: my-agent
description: When to use this agent
allowed-tools: Read, Grep, Glob, Bash
---

Instructions for the agent go here.
` + "```" + `

## Key Fields
- ` + "`name`" + ` — identifier used in ` + "`subagent_type`" + ` parameter
- ` + "`description`" + ` — helps Claude decide when to spawn this agent
- ` + "`allowed-tools`" + ` — tools available to the agent (security boundary)

## Tips
- Restrict ` + "`allowed-tools`" + ` to minimum needed (principle of least privilege)
- Write clear instructions — agents don't have conversation history
- Include output format expectations in instructions
- Agents run in isolation — they can't see the main conversation
- Use for: code review, test running, research, parallel tasks
`,
	},
	{
		File: "mcp-config.md",
		Content: `---
paths:
  - "**/.mcp.json"
  - "**/.claude/mcp.json"
---

# MCP Server Configuration Best Practices

MCP (Model Context Protocol) servers extend Claude Code with custom tools, resources, and prompts.

## Configuration File
` + "`.mcp.json`" + ` (project-level) or ` + "`.claude/mcp.json`" + `:
` + "```json" + `
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
` + "```" + `

## Transport Types
- ` + "`stdio`" + ` — most common, communicates via stdin/stdout
- ` + "`sse`" + ` — Server-Sent Events for remote servers

## Tips
- Use project-level ` + "`.mcp.json`" + ` for project-specific servers
- Use ` + "`~/.claude/mcp.json`" + ` for global servers (personal tools)
- Set environment variables in ` + "`env`" + ` field, not system-wide
- MCP tools are namespaced: ` + "`mcp__server-name__tool-name`" + `
- Servers start on demand and persist for the session
- Use ` + "`claude mcp add`" + ` CLI command for interactive setup
`,
	},
	{
		File: "rules.md",
		Content: `---
paths:
  - "**/.claude/rules/**"
---

# Rules Best Practices

Rules are markdown files that inject instructions based on file path matching.

## Rule File Format (.md in .claude/rules/)
` + "```markdown" + `
---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Rules

Always use describe/it blocks...
` + "```" + `

## Key Concepts
- ` + "`paths`" + ` — glob patterns that trigger this rule
- Rules are injected when Claude reads/edits matching files
- Multiple rules can activate simultaneously
- Rules without ` + "`paths`" + ` apply globally (like mini CLAUDE.md)

## Tips
- Use rules for file-type-specific conventions (test style, component patterns)
- Keep rules concise — they're injected into context on every match
- Use glob patterns effectively: ` + "`**/*.go`" + ` for all Go files, ` + "`src/api/**`" + ` for API code
- Global rules (no paths) are good for team-wide conventions
- Don't duplicate CLAUDE.md content in rules
`,
	},
	{
		File: "alfred.md",
		Content: `# alfred MCP Tools

alfred's knowledge base contains Claude Code docs, best practices, AND user's custom technology documentation.
Do NOT proceed with .claude/ configuration tasks by only reading files.

## knowledge — Search docs and best practices

**Auto-consult on every user prompt:** If the user's question or task likely relates to a technology or library in the knowledge base, call knowledge BEFORE responding. This includes:
- Claude Code features (hooks, skills, rules, agents, MCP, memory, CLAUDE.md)
- Creating, modifying, or reviewing ` + "`.claude/`" + ` configuration files
- Any technology the user has added to their knowledge base (check ` + "`~/.claude-alfred/sources.yaml`" + ` for registered sources)
- API usage, framework patterns, or library-specific questions

When in doubt, call knowledge — it's fast and the cost of missing relevant context is higher than an extra search.

## review — Analyze project's Claude Code utilization

CALL FIRST when:
- Reviewing or auditing ` + "`.claude/`" + ` configuration (agents, skills, rules, hooks, MCP)
- Evaluating CLAUDE.md quality or looking for improvements
- Checking overall Claude Code setup health for a project

## suggest — Suggest .claude/ config changes based on code changes

USE when:
- After code changes, to check if .claude/ configuration needs updating
- When reviewing whether project setup is still aligned with current code
`,
	},
	{
		File: "memory.md",
		Content: `---
paths:
  - "**/.claude/memory/**"
  - "**/MEMORY.md"
---

# Memory Best Practices

Memory files persist information across Claude Code conversations.

## MEMORY.md
- Located at project root or in ` + "`.claude/memory/`" + `
- Automatically loaded into every conversation
- Lines after ~200 are truncated — keep it concise
- Use for: stable patterns, user preferences, key decisions

## .claude/memory/ Directory
- Create topic-specific files (e.g., ` + "`debugging.md`" + `, ` + "`architecture.md`" + `)
- Link to them from MEMORY.md for organization
- Files persist across conversations but are not auto-loaded (must be read explicitly)

## What to Store
- Confirmed patterns and conventions (verified across multiple interactions)
- Architectural decisions with rationale
- User workflow preferences
- Solutions to recurring problems

## What NOT to Store
- Session-specific context (current task, in-progress work)
- Unverified or speculative conclusions
- Information that duplicates CLAUDE.md
- Sensitive data (credentials, API keys)

## Tips
- Update memories when they become outdated
- Check for existing entries before creating duplicates
- Keep MEMORY.md under 200 lines
- Use separate files for detailed notes, link from MEMORY.md
`,
	},
	{
		File: "butler-protocol.md",
		Content: `# Butler Protocol — Autonomous Spec Management

When a ` + "`.alfred/specs/`" + ` directory exists in the project, follow this protocol:

## Session Start
- Call ` + "`butler-status`" + ` with project_path to check for an active task
- If active, read the session state to understand current position and next steps
- If session.md mentions "Compact Marker", you are resuming after context compaction — read all spec files to restore full context

## Starting New Work
- Before implementation, call ` + "`butler-init`" + ` to create a spec
- Fill in requirements.md and design.md through conversation with the user
- Break work into tasks in tasks.md

## During Implementation
Record these autonomously — do not wait for user instruction:

**decisions.md** — When you make or recommend a design choice:
` + "```" + `
## [date] Decision Title
- **Chosen:** what was selected
- **Alternatives:** what was considered
- **Reason:** why this option
` + "```" + `

**knowledge.md** — When you discover something:
` + "```" + `
## Discovery Title
- **Finding:** what you learned
- **Context:** when/where this matters
- **Dead ends:** what didn't work and why (CRITICAL — prevents re-exploration)
` + "```" + `

**tasks.md** — Update checkboxes as you complete work

**session.md** — Update when:
- Starting a new sub-task (Current Position)
- Completing a milestone
- Encountering a blocker (Unresolved Issues)

## Compact/Session Recovery
After compact or new session, butler-status provides session.md.
Read spec files in this order to rebuild context:
1. session.md (where am I?)
2. requirements.md (what am I building?)
3. design.md (how?)
4. tasks.md (what's done/remaining?)
5. decisions.md (why these choices?)
6. knowledge.md (what did I learn?)

## Review
- Before committing, call ` + "`butler-review`" + ` to check changes against specs and accumulated knowledge
`,
	},
}
