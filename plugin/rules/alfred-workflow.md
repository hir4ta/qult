---
name: alfred-workflow
description: Proactive workflow guidance for development tasks
globs:
  - "**/*"
---

# Development Workflow

## Judging task scale — spec is NOT always needed

**Use /alfred:brief (spec-driven) when:**
- Multiple files or components need coordinated changes
- Design decisions with trade-offs need to be made
- The task will span multiple sessions or survive compaction
- The user explicitly asks for planning or structured work

**Skip spec, just implement when:**
- Single file fix or small change
- Clear requirements with no design ambiguity
- Quick bug fix, config change, docs update
- The user says "just do it" or similar

Use judgment. When in doubt, ask: "This looks substantial — want me to create a spec with /alfred:brief, or dive straight in?"

## When to use alfred skills proactively

**Large task (new feature, major refactor, multi-file change):**
1. `/alfred:brief <task-slug>` — Create a structured spec with multi-agent deliberation
2. Implement following the spec
3. `/alfred:inspect` — Multi-agent code review before committing
4. Update spec session.md with final status

**Design exploration (unclear direction, multiple options):**
1. `/alfred:salon <theme>` — Divergent thinking with 3 agents
2. `/alfred:polish` — Converge on a decision
3. Optionally `/alfred:brief` — Create spec from the decision

**Quick fix (bug fix, small change):**
- No plan needed
- `/alfred:inspect` only for non-trivial changes

## Proactive behavior — be JARVIS, not a passive tool

- When the user describes a large task, **suggest** `/alfred:brief` (don't just start coding)
- When implementation is complete, **suggest** `/alfred:inspect`
- When a spec is active, keep session.md updated via the `dossier` MCP tool
- After review findings, record key decisions to spec's decisions.md
- When the user is stuck or exploring options, **suggest** `/alfred:salon`
- Always explain WHY you're suggesting a skill — don't just mention it
