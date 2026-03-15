---
name: concierge
description: >
  Show all available alfred capabilities and when to use each one.
  Quick reference for skills, agents, MCP tools.
  Use when the user asks what alfred can do, wants to list available commands,
  or needs guidance on which skill to use. NOT for executing tasks (use the
  specific skill instead).
user-invocable: true
argument-hint: "[feature-name]"
allowed-tools: mcp__plugin_alfred_alfred__knowledge
model: sonnet
context: current
---

# /alfred:concierge — Capability Reference

If `$ARGUMENTS` names a specific feature, call `knowledge` to provide detailed guidance,
then output a focused explanation. Otherwise, show the full reference below.

## Skills (12)

| Skill | Purpose | When to use |
|-------|---------|-------------|
| **brief** | Multi-agent spec generation | Starting a new task, organizing a design |
| **attend** | Autonomous development orchestrator | End-to-end: spec → implement → review → commit |
| **inspect** | Profile-based quality review (6 profiles) | Before committing, after a milestone |
| **mend** | Bug fix with memory-enhanced diagnosis | Fixing bugs, resolving test failures |
| **survey** | Reverse-engineer specs from code | Onboarding to existing code, documenting legacy |
| **salon** | Divergent thinking (3 agents) | Need ideas, surface risks, expand options |
| **polish** | Convergent decision-making | Stuck on a choice, need to resolve a blocker |
| **valet** | Skill audit against official guide | Auditing skills before publishing |
| **furnish** | Single config file generation | Create/polish one skill, rule, hook, etc. |
| **quarters** | Project-wide setup wizard | First-time project setup, feature explanation |
| **archive** | Reference material processor | Onboarding large files, docs, CSV |
| **concierge** | This reference | Discover what alfred can do |

## Agents (auto-delegated by Claude)

| Agent | Purpose | Triggers |
|-------|---------|----------|
| **alfred** | Butler — knowledge lookup, config guidance | Claude Code questions, config changes |
| **code-reviewer** | Read-only multi-agent reviewer | Code review requests |

## MCP Tools (called by Claude when needed)

| Tool | Purpose | Example |
|------|---------|---------|
| **knowledge** | Search Claude Code docs & best practices | "How do hooks work?" |
| **config-review** | Audit .claude/ config with scoring | "Is my setup good?" |
| **dossier** | Task spec management (init/update/status) | "Start task auth-refactor" |
| **ledger** | Search/save persistent memories | "Have I done this before?" |

## Which skill should I use?

```
Starting a new task?
  → /alfred:brief    — Multi-agent spec generation
  → /alfred:attend   — Full autonomous pipeline (spec → code → review → commit)

Fixing a bug?
  → /alfred:mend     — Reproduce → root cause (+ past bug memory) → fix → verify

Have a vague idea, need to explore?
  → /alfred:salon    — Divergent thinking (3 agents)

Have options but can't choose?
  → /alfred:polish   — Narrowing, scoring, deciding

Ready to commit code?
  → /alfred:inspect   — Profile-based quality review

Need to understand existing code?
  → /alfred:survey   — Reverse-engineer specs from code

Need to set up Claude Code config?
  → /alfred:quarters — Project-wide wizard
  → /alfred:furnish  — Single file (skill, rule, hook, etc.)

Onboarding reference materials?
  → /alfred:archive  — CSV, TXT, PDF → structured persistent knowledge
```

## Example

User: `/alfred:concierge hooks`

```
## Hooks

**What**: Shell commands that run automatically during Claude Code events.

**alfred's hooks**:
- SessionStart: restore spec context + ingest CLAUDE.md
- PreCompact: extract decisions + save session state + persist memories
- UserPromptSubmit: semantic search → surface relevant past experience

**Tips**:
- Keep hooks fast (< 2s for synchronous)
- Use `matcher` to scope which tools trigger
```

**Typical flow:** salon → polish → brief → implement → inspect
**Autonomous flow:** /alfred:attend (runs the full pipeline automatically)

## Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `VOYAGE_API_KEY` | (none) | Voyage AI API key for vector search + reranking |

## How It Works

alfred operates on two layers:

1. **Hooks** (automatic): SessionStart injects task context, UserPromptSubmit surfaces
   relevant memories via Voyage AI semantic search, PreCompact preserves session state
2. **MCP Tools** (on-demand): dossier for spec management, ledger for memory,
   knowledge for Claude Code best practices, config-review for setup auditing
