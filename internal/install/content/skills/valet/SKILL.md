---
name: valet
description: >
  Review skills against Anthropic's official "Complete Guide to Building Skills
  for Claude" (33-page guide) and score them. Evaluates 21 checks across 6
  categories: frontmatter compliance (name, description, XML brackets, reserved
  prefixes), description quality (WHAT+WHEN, trigger phrases, 1024-char limit),
  structure (SKILL.md naming, folder kebab-case, 500-line limit, no README),
  progressive disclosure (supporting files, references), best practices
  (actionable instructions, error handling, negative triggers), and security
  (allowed-tools restriction, no embedded secrets). Produces a per-skill
  scorecard and auto-fixes frontmatter issues with --fix flag. Use when
  auditing skills before publishing, after updating guidelines, or checking
  plugin skills quality. NOT for general code review (use /alfred:inspect).
  NOT for CLAUDE.md or hooks review (use /alfred:inspect config).
user-invocable: true
argument-hint: "[skill-path or --all] [--fix]"
allowed-tools: Read, Edit, Glob, Grep, Agent, mcp__plugin_alfred_alfred__knowledge
context: fork
---

# /alfred:valet — Skill Best Practices Auditor

Review skills against Anthropic's official "Complete Guide to Building Skills
for Claude" and produce an actionable scorecard.

## Key Principle

**Always fetch the latest best practices before reviewing.** The knowledge base
is continuously updated — never rely on hardcoded rules alone. The baseline
checklist (see [checklist.md](checklist.md)) provides the structure, but
`knowledge` queries fill in the latest guidance.

## Phase 0: Refresh Knowledge

1. Call `knowledge` with query: "skill frontmatter requirements description best practices"
2. Call `knowledge` with query: "skill security restrictions forbidden XML angle brackets"
3. Call `knowledge` with query: "skill design patterns testing validation"
4. Merge results with the baseline [checklist.md](checklist.md)
5. If knowledge returns newer guidance not in checklist, **use the newer version**

## Phase 1: Discover Skills

Parse `$ARGUMENTS`:
- If a path is given → review that single skill
- If `--all` → scan standard locations:
  - `.claude/skills/*/SKILL.md`
  - `internal/install/content/skills/*/SKILL.md`
  - `plugin/skills/*/SKILL.md`
  - `~/.claude/skills/*/SKILL.md`
- If no arguments → ask which skills to review

Use Glob to find all SKILL.md files in scope.

## Phase 2: Evaluate Each Skill

For each SKILL.md found, read it and evaluate against these categories:

### A. Frontmatter Compliance (4 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| A1 | `name` field exists and is kebab-case | No spaces, capitals, underscores | CRITICAL |
| A2 | `description` field exists | Required for Claude to know when to load | CRITICAL |
| A3 | No XML angle brackets in ANY frontmatter field | Security: frontmatter is injected into system prompt | CRITICAL |
| A4 | No reserved prefixes ("claude", "anthropic") in name | Reserved by Anthropic | CRITICAL |

### B. Description Quality (4 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| B1 | Includes WHAT the skill does | First part of description | HIGH |
| B2 | Includes WHEN to use it (trigger conditions) | Users' actual phrases | HIGH |
| B3 | Under 1024 characters | Claude Code truncation limit | HIGH |
| B4 | Not too vague ("Helps with projects" = bad) | Must be specific and actionable | MEDIUM |

### C. Structure (4 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| C1 | SKILL.md filename exact (case-sensitive) | No SKILL.MD, skill.md, etc. | CRITICAL |
| C2 | Folder name is kebab-case | No spaces, capitals, underscores | CRITICAL |
| C3 | SKILL.md under 500 lines | Prevents context bloat | MEDIUM |
| C4 | No README.md inside skill folder | All docs in SKILL.md or references/ | LOW |

### D. Progressive Disclosure (3 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| D1 | Large skills (200+ lines) use supporting files | references/, scripts/, examples/ | MEDIUM |
| D2 | Supporting files are referenced from SKILL.md | Otherwise Claude won't discover them | MEDIUM |
| D3 | SKILL.md focused on core instructions | Detailed docs in separate files | LOW |

### E. Best Practices (4 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| E1 | Instructions are specific and actionable | "Run X" not "validate things" | MEDIUM |
| E2 | Error handling / troubleshooting included | Common failures documented | MEDIUM |
| E3 | Examples provided for complex workflows | At least one Example section | LOW |
| E4 | Negative triggers for skills that could over-fire | "Do NOT use for..." in description | LOW |

### F. Security (2 checks)

| # | Check | Rule | Severity |
|---|---|---|---|
| F1 | `allowed-tools` restricts tool access | Least privilege principle | MEDIUM |
| F2 | No secrets or API keys in skill content | Never embed credentials | CRITICAL |

## Phase 3: Score & Report

For each skill, calculate:
- **CRITICAL**: any failure = FAIL (must fix before publishing)
- **HIGH**: each pass = 2 points
- **MEDIUM**: each pass = 1 point
- **LOW**: each pass = 0.5 points

### Output Format

```
## Skill Review: {skill-name}

**Score: {X}/{max} ({percentage}%)**
**Status: {PASS | NEEDS_FIXES | CRITICAL_ISSUES}**

### Findings

| # | Check | Status | Detail |
|---|---|---|---|
| A1 | name kebab-case | OK | "my-skill" |
| A3 | No XML brackets | NG | argument-hint contains "<...>" |
| ... | ... | ... | ... |

### Fixes Required
1. [CRITICAL] Remove angle brackets from argument-hint (line 8)
2. [HIGH] Add trigger phrases to description

### Suggested Description
(if B1-B4 have issues, propose an improved description)
```

### Summary Table (for --all)

```
| Skill | Score | Status | Critical | High | Medium |
|---|---|---|---|---|---|
| plan | 95% | PASS | 0 | 0 | 1 |
| review | 100% | PASS | 0 | 0 | 0 |
| ... | ... | ... | ... | ... | ... |
```

## Phase 4: Auto-Fix (if --fix flag)

If `$ARGUMENTS` contains `--fix`:
1. For each CRITICAL/HIGH finding with a clear fix:
   - Show the proposed change
   - Apply the edit
2. Re-run evaluation on fixed files
3. Show before/after comparison

Fixable issues:
- A3: Remove `<` `>` from argument-hint (replace with bare text)
- B2: Append trigger phrases to description (propose, then apply)
- C4: Remove README.md from skill folder (warn first)

Non-fixable (require human judgment):
- B4: Vague description — propose alternatives but don't auto-apply
- D1: Splitting large files — requires understanding of content
- E1-E4: Instruction quality — suggest but don't modify

## Example

User: `/alfred:valet --all`

```
## Skill Review: brainstorm

**Score: 14/14 (100%)**
**Status: PASS**

| # | Check | Status | Detail |
|---|-------|--------|--------|
| A1 | name kebab-case | OK | "brainstorm" |
| A3 | No XML brackets | OK | Clean |
| B2 | Includes WHEN | OK | "Use when you need more ideas..." |
| E4 | Negative triggers | OK | "NOT for convergent decision-making" |

## Summary

| Skill | Score | Status | Critical | High | Medium |
|-------|-------|--------|----------|------|--------|
| brainstorm | 100% | PASS | 0 | 0 | 0 |
| configure | 100% | PASS | 0 | 0 | 0 |
| ... | ... | ... | ... | ... | ... |
```

## Guardrails

- ALWAYS call `knowledge` first — never review with stale criteria
- NEVER modify skill logic/instructions in --fix mode (only frontmatter)
- ALWAYS show changes before applying
- If knowledge returns guidance that CONFLICTS with checklist.md, prefer knowledge (it's newer)
- Report but don't score items not applicable to a skill (e.g., no MCP = skip MCP checks)

## Troubleshooting

- **No skills found at path**: Check glob pattern, try `--all` to scan standard locations.
- **knowledge returns outdated guidance**: Checklist.md is the baseline; knowledge supplements it. If conflicting, prefer knowledge (it's newer).
- **--fix breaks a skill**: Re-read the original file, show the diff, and offer to revert.
- **Description length hard to measure**: Count characters in the folded YAML scalar (after `>` indicator), excluding leading whitespace.
