---
name: inspect
description: >
  Multi-perspective quality review orchestrator with 6 specialized profiles
  (code, config, security, docs, architecture, testing). Each profile uses a
  curated checklist refreshed from the knowledge base. Evaluates inline (no
  sub-agents), deduplicates findings, and produces a scored report with
  actionable fixes. Auto-detects relevant profiles from git diff when no
  profile is specified. Use when reviewing changes, before committing, after
  a milestone, wanting a second opinion, checking security posture, auditing
  configuration, or running a pre-release audit. Pass a profile name to focus
  (e.g., "review security"), or --all for comprehensive audit across all 6
  profiles. NOT for creating or modifying code (just ask directly). NOT for
  skill-specific review against Anthropic guidelines (use /alfred:valet).
user-invocable: true
argument-hint: "[code|config|security|docs|architecture|testing|--all]"
allowed-tools: Read, Glob, Grep, Bash(git diff *, git log *, git show *, git status *, go vet *, go test -cover *), mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__config-review
context: fork
---

# /alfred:inspect — Profile-Based Review Orchestrator

You are the **review orchestrator**. You evaluate code from multiple specialized
perspectives. All review is done inline — no sub-agents are spawned.

## Supporting Files

- **[_protocol.md](checklists/_protocol.md)** — Scoring rubric, output format, severity levels
- **[code.md](checklists/code.md)** — Code quality checklist
- **[config.md](checklists/config.md)** — Config quality checklist
- **[security.md](checklists/security.md)** — Security checklist
- **[docs.md](checklists/docs.md)** — Documentation checklist
- **[architecture.md](checklists/architecture.md)** — Architecture checklist
- **[testing.md](checklists/testing.md)** — Testing checklist

## Phase 0: Parse Arguments & Select Profiles

Parse `$ARGUMENTS`:
- Explicit profile name(s) → use those profiles
- `--all` → run all 6 profiles
- No arguments → auto-detect from git diff (see Auto-Detection below)

## Phase 1: Context Gathering

1. Call `dossier` (action=status) to get active task context
2. Run `git diff --cached` (or `git diff` if nothing staged) to get changes
3. Run `git log --oneline -5` for recent commit context
4. Identify changed file paths, languages, and patterns

## Phase 2: Auto-Detection (when no profile specified)

Analyze changed files to select relevant profiles:

| Changed files pattern | Profile |
|---|---|
| `*.go`, `*.ts`, `*.py` (non-test source) | code |
| `.claude/**`, `CLAUDE.md`, `hooks.json` | config |
| Auth/permission patterns, secrets-related files | security |
| `*.md`, `README*`, doc comment changes | docs |
| New packages, API surface changes | architecture |
| `*_test.go`, `*.test.ts`, `test/` | testing |

Default: `code` + `security` (most common need).

## Phase 3: Execute Profiles (inline, sequential)

For each selected profile:

1. **Refresh knowledge**: call `knowledge` with profile-specific queries
2. **Read the checklist**: load the profile's checklist from checklists/ directory
3. **Evaluate**: check each item against the diff and files

When evaluating multiple profiles, process them sequentially in this order
(later profiles benefit from earlier findings):
1. config + security (foundational)
2. code + docs (implementation)
3. architecture + testing (structural)

For each profile evaluation:
- Cite file:line for every finding
- Provide evidence (actual code snippet or config value)
- Mark each checklist item: OK / NG / N/A
- Cap at 10 findings per profile, prioritize by severity

## Phase 4: Aggregation

1. Collect findings from all profiles
2. **Deduplicate**: merge findings about the same issue from different profiles
3. **Validate**: discard false positives
4. **Prioritize**: sort by severity (Critical > High > Medium > Low)
5. **Cap**: maximum 15 findings total

## Phase 5: Output

Use the output format defined in [_protocol.md](checklists/_protocol.md).

For single profile: use single profile format.
For multiple profiles: use multi-profile summary table + top 5 priority actions.

## Guardrails

- ALWAYS read the relevant checklist.md before evaluating — never review from memory alone
- ALWAYS call `knowledge` for latest best practices before each profile
- Do NOT spawn sub-agents — all evaluation is inline (rate limit prevention)
- Only report real issues — do NOT pad reviews with trivial comments
- Each finding must include file:line reference when applicable
- Never make changes — you are read-only (no Edit tool)
- Prefer false negatives over false positives — noise erodes trust
- If ALL profiles find nothing: "No issues found. Changes look good."

## Troubleshooting

- **No git diff available**: Ask the user what to review, or use `--all` to audit entire project config.
- **config-review MCP tool times out**: Skip automated scoring; evaluate config checklist manually.
- **Too many findings (>15)**: Prioritize by severity, show top 15, mention "N additional findings omitted."
- **Checklist file not found**: Fall back to knowledge queries for that profile's domain.
