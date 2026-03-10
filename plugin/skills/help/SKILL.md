---
name: help
description: >
  Show all available alfred capabilities and when to use each one.
  Quick reference for skills, agents, MCP tools, and CLI commands.
user-invocable: true
argument-hint: "[feature-name]"
allowed-tools: mcp__plugin_alfred_alfred__knowledge
context: current
---

# /alfred:help — Capability Reference

If `$ARGUMENTS` names a specific feature, call `knowledge` to provide detailed guidance,
then output a focused explanation. Otherwise, show the full reference below.

## Skills (invoke with `/alfred:<name>`)

| Skill | Purpose | When to use |
|-------|---------|-------------|
| **plan** | Multi-agent spec generation | Starting a new task, organizing a design |
| **brainstorm** | Divergent thinking (3 agents) | Need ideas, surface risks, expand options |
| **refine** | Convergent decision-making | Stuck on a choice, need to resolve a blocker |
| **review** | Multi-agent code review | Before committing, after a milestone |
| **configure** | Single config file generation | Create/polish one skill, rule, hook, etc. |
| **setup** | Project-wide setup wizard | First-time project setup, feature explanation |
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

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALFRED_QUIET` | `0` | Set to `1` to suppress knowledge injection |
| `ALFRED_RELEVANCE_THRESHOLD` | `0.40` | Minimum score for knowledge injection |
| `ALFRED_CRAWL_INTERVAL_DAYS` | `7` | Auto-crawl interval |
| `ALFRED_DEBUG` | unset | Set to `1` for debug logging (~/.claude-alfred/debug.log) |

## How It Works

alfred operates on two layers:

1. **Hooks** (automatic): SessionStart injects task context, UserPromptSubmit surfaces
   relevant knowledge, PreCompact preserves session state, SessionEnd saves memories
2. **MCP Tools** (on-demand): Deep knowledge search, config auditing, spec management,
   memory recall

The hooks are lightweight (FTS-only, no API calls). The MCP tools use hybrid
vector + FTS5 + Voyage AI reranking for deeper search.
