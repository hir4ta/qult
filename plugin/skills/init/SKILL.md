---
name: init
description: >
  Project onboarding — multi-agent codebase exploration, steering doc generation,
  template setup, and knowledge sync. The single entry point for setting up alfred
  in any project. Use when starting with alfred in a new project, re-initializing
  after major changes, or when steering docs are missing. NOT for spec creation
  (use /alfred:brief). NOT for config review (use /alfred:inspect config).
user-invocable: true
argument-hint: "[--force]"
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(git *, ls *), Agent, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
context: current
---

Alfred initializes the project for spec-driven development.

## Goal

Set up `.alfred/` with steering docs, templates, and knowledge index — all in one command.
After this, the project is ready for `/alfred:brief`, `/alfred:attend`, and all other skills.

## Steps

### Phase 1: Project Analysis (parallel agents)

1. Launch **3 parallel agents** to explore the codebase:

   **Agent 1 — Architecture Explorer**:
   - Read README.md, CLAUDE.md, go.mod/package.json/Cargo.toml/pyproject.toml
   - Scan top-level directory structure
   - Identify tech stack, frameworks, key dependencies
   - Output: project name, description, tech stack, dependencies list

   **Agent 2 — Code Structure Analyzer**:
   - Glob for main entry points (main.go, index.ts, app.py, etc.)
   - Identify package/module boundaries
   - Map directory → responsibility (e.g., "internal/store → database layer")
   - Output: packages list with descriptions, naming conventions

   **Agent 3 — Convention Detector**:
   - Read existing CLAUDE.md, .claude/rules/*.md
   - Check for .editorconfig, .prettierrc, biome.json, golangci.yml, etc.
   - Detect testing patterns (test file locations, frameworks)
   - Detect error handling patterns, logging approach
   - Output: conventions list, coding standards

2. Wait for all 3 agents to complete. Merge results into a unified project profile.

### Phase 2: Steering Document Generation

3. Using the merged profile, generate `.alfred/steering/` documents:
   - `product.md` — project purpose, users, key features
   - `structure.md` — directory layout, module boundaries, component interactions
   - `tech.md` — tech stack, dependencies, architecture patterns

   If steering docs already exist and `--force` is NOT specified:
   - Show diff between current and proposed docs
   - Ask user if they want to update specific files

   Use the 2-layer template system: check `.alfred/templates/steering/` for user overrides first.

### Phase 3: Template Setup

4. Copy default spec templates to `.alfred/templates/specs/` if not already present:
   - requirements.md.tmpl, design.md.tmpl, tasks.md.tmpl, etc.
   - Copy default steering templates to `.alfred/templates/steering/`
   - Tell user they can customize these templates

### Phase 4: Knowledge Sync

5. Scan `.alfred/knowledge/` for any existing Markdown files and report count.
   If knowledge files exist from a previous setup, confirm they will be indexed on next session start.

6. If the project has no knowledge entries yet, suggest:
   - `ledger action=save` to save important decisions from the current session
   - `/alfred:survey` to reverse-engineer specs from existing code

### Phase 5: Validation & Summary

7. Run `dossier action=status` to verify the setup is working.

8. Output a summary:

```
## alfred initialized ✓

### Steering docs
- product.md — {brief description}
- structure.md — {N directories mapped}
- tech.md — {tech stack detected}

### Templates
- {N} spec templates in .alfred/templates/specs/
- {N} steering templates in .alfred/templates/steering/

### Knowledge
- {N} existing knowledge files indexed
- {N} project conventions detected

### Next steps
- `/alfred:brief` — start your first spec
- `/alfred:attend` — full autopilot from spec to commit
- `alfred dashboard` — browser-based project overview
```

## Important

- If `--force` is in $ARGUMENTS, overwrite existing steering docs without asking
- Do NOT create spec files — this skill only sets up the project infrastructure
- Do NOT modify existing code — only create files under `.alfred/`
- Template files should be the embedded defaults copied out, not custom-generated content

## Troubleshooting

- **Steering docs already exist**: Use `--force` flag to overwrite (`/alfred:init --force`). Without it, the skill shows a diff and asks before updating.
- **No go.mod/package.json found**: The analysis agents will have limited context. Provide the tech stack and project description manually when prompted.
- **Agent spawn failure**: Usually caused by rate limits. Retry after a short wait. If persistent, the skill can fall back to sequential analysis instead of parallel agents.
