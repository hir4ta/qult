---
name: help
description: >
  Show all available alfred capabilities and when to use each one.
  Quick reference for skills, agents, MCP tools, and CLI commands.
  Use when the user asks what alfred can do, wants to list available commands,
  or needs guidance on which skill to use. NOT for executing tasks (use the
  specific skill instead).
user-invocable: true
argument-hint: "[feature-name]"
allowed-tools: mcp__plugin_alfred_alfred__knowledge
model: sonnet
context: current
---

# /alfred:help — Capability Reference

If `$ARGUMENTS` names a specific feature, call `knowledge` to provide detailed guidance,
then output a focused explanation. Otherwise, show the full reference below.

## Skills (invoke with `/alfred:<name>`)

| Skill | Purpose | When to use |
|-------|---------|-------------|
| **plan** | Multi-agent spec generation | Starting a new task, organizing a design |
| **develop** | Autonomous development orchestrator | End-to-end: spec → implement → review → commit |
| **review** | Profile-based quality review (6 profiles) | Before committing, after a milestone, auditing config/security |
| **skill-review** | Skill audit against official guide | Auditing skills before publishing, checking quality |
| **brainstorm** | Divergent thinking (3 agents) | Need ideas, surface risks, expand options |
| **refine** | Convergent decision-making | Stuck on a choice, need to resolve a blocker |
| **configure** | Single config file generation | Create/polish one skill, rule, hook, etc. |
| **setup** | Project-wide setup wizard | First-time project setup, feature explanation |
| **ingest** | Reference material processor | Onboarding large files, docs, CSV into persistent knowledge |
| **help** | This reference | Discover what alfred can do |

## Agents (auto-delegated by Claude)

| Agent | Purpose | Triggers |
|-------|---------|----------|
| **alfred** | Silent butler — knowledge lookup, config guidance | Claude Code questions, config changes |
| **code-reviewer** | Read-only multi-agent reviewer | Code review requests |

## MCP Tools (called by Claude when needed)

| Tool | Purpose | Example |
|------|---------|---------|
| **knowledge** | Search Claude Code docs & best practices | "How do hooks work?" |
| **config-review** | Audit .claude/ config with scoring | "Is my setup good?" |
| **spec** | Task spec management (init/update/status) | "Start task auth-refactor" |
| **recall** | Search/save persistent memories | "Have I done this before?" |

## CLI Commands

| Command | Purpose |
|---------|---------|
| `alfred init` | First-time setup (seed docs, optional Voyage API key) |
| `alfred status` | System state: doc count, memories, last crawl |
| `alfred export` | Export memories to JSON (`--all` includes specs) |
| `alfred memory` | Manage memories (`prune`, `stats`) |
| `alfred settings` | Manage Voyage API key |
| `alfred update` | Self-update binary |

## Which skill should I use?

```
Starting a new task?
  → /alfred:plan          — Multi-agent spec generation
  → /alfred:develop       — Full autonomous pipeline (spec → code → review → commit)

Have a vague idea, need to explore?
  → /alfred:brainstorm    — Divergent thinking (3 agents)

Have options but can't choose?
  → /alfred:refine        — Narrowing, scoring, deciding

Ready to commit code?
  → /alfred:review        — Profile-based quality review (code/config/security/docs/arch/testing)
  → /alfred:skill-review  — Audit skills against official best practices

Need to set up Claude Code config?
  → /alfred:setup         — Project-wide wizard
  → /alfred:configure     — Single file (skill, rule, hook, etc.)

Onboarding reference materials?
  → /alfred:ingest        — CSV, TXT, PDF → structured persistent knowledge
```

## Example

User: `/alfred:help hooks`

```
## Hooks

**What**: Shell commands or LLM prompts that run automatically during Claude Code events.

**When to use**:
- Enforce coding standards before every edit
- Auto-format on save
- Block dangerous commands

**Setup** (copy-pasteable):
{ "hooks": { "PreToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "./lint.sh" }] }] } }

**Tips**:
- Keep hooks fast (< 2s for synchronous)
- Use `matcher` to scope which tools trigger
```

**Typical flow:** brainstorm → refine → plan → implement → review
**Autonomous flow:** /alfred:develop (runs the full pipeline automatically)

## Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `VOYAGE_API_KEY` | (none) | Voyage AI API key for vector search + reranking |

## How It Works

alfred operates on two layers:

1. **Hooks** (automatic): SessionStart injects task context, UserPromptSubmit surfaces
   relevant knowledge, PreCompact preserves session state, SessionEnd saves memories
2. **MCP Tools** (on-demand): Deep knowledge search, config auditing, spec management,
   memory recall

The hooks are lightweight (FTS-only, no API calls). The MCP tools use hybrid
vector + FTS5 + Voyage AI reranking for deeper search.
