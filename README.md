# alfred

Quality butler for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Monitors Claude Code's actions, enforces quality gates, and learns from past sessions.

**Invisible. Mechanical. Relentless.**

## What alfred does

alfred runs as hooks + MCP server inside Claude Code. It watches every file edit, every bash command, every commit — and enforces quality through walls, not suggestions.

- **Lint/type gates**: PostToolUse runs lint and type checks after every file write. Errors become DIRECTIVE — Claude must fix before continuing
- **Test-first enforcement**: PreToolUse blocks edits when no corresponding test file exists
- **Error resolution cache**: Bash errors are matched against past resolutions via Voyage AI vector search
- **Convention enforcement**: Project-specific coding conventions are injected as context at the right moment
- **Quality scoring**: Every gate pass/fail, every error hit/miss is tracked and scored per session

## Architecture

```
User → Claude Code → (alfred hooks monitor + inject + gate)
              ↓ when needed
           alfred MCP (knowledge DB)
```

| Component | Role | Weight |
|---|---|---|
| Hooks (6 events) | Monitor, inject context, enforce gates | 70% |
| DB + Voyage AI | Knowledge storage, vector search | 20% |
| MCP tool | Claude Code interface to knowledge | 10% |

## Install

```bash
# Build
bun install
bun build.ts

# Setup (writes to ~/.claude/)
alfred init
```

## Commands

```bash
alfred init          # Setup: MCP, hooks, rules, skills, agents
alfred mcp           # Start MCP server (stdio, called by Claude Code)
alfred hook <event>  # Handle hook event (called by Claude Code)
alfred tui           # Quality dashboard in terminal
alfred doctor        # Check installation health
alfred version       # Show version
```

## Stack

TypeScript (Bun 1.3+, ESM) / SQLite (bun:sqlite) / Voyage AI (voyage-4-large + rerank-2.5) / MCP SDK / TUI (OpenTUI)

## Design docs

See `design/` for architecture, detailed design, and research references.
