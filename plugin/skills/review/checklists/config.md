# Config Review Checklist

Profile: `config`
Trigger: .claude/ files, CLAUDE.md, hooks.json, .mcp.json, settings.json changes

Before evaluating, call `knowledge` with:
- "CLAUDE.md best practices size structure"
- "hooks configuration event types timeout"
- "rules path-scoped glob patterns"

Also call `config-review` MCP tool for automated maturity scoring, then add
cross-reference checks the MCP tool cannot perform.

## CLAUDE.md

| # | Check | Severity | What to look for |
|---|---|---|---|
| CM1 | Size under 200 lines | HIGH | Count lines; bloated CLAUDE.md = instructions ignored |
| CM2 | Structure has headers | MEDIUM | Scannable with ##; not a wall of text |
| CM3 | Commands are copy-pasteable | HIGH | `go test ./...` not "run the tests" |
| CM4 | No redundancy with rules/ | MEDIUM | Same instruction in CLAUDE.md AND rules/*.md |
| CM5 | No self-evident instructions | LOW | "write clean code" adds no value |
| CM6 | @imports resolve | HIGH | `@docs/guide.md` — does the file exist? |

## Skills

| # | Check | Severity | What to look for |
|---|---|---|---|
| SK1 | SKILL.md exact filename | CRITICAL | Case-sensitive: not SKILL.MD or skill.md |
| SK2 | Folder is kebab-case | CRITICAL | No spaces, capitals, underscores |
| SK3 | description includes WHAT+WHEN | HIGH | Both present; not vague |
| SK4 | description under 1024 chars | HIGH | Claude Code truncation limit |
| SK5 | No XML angle brackets in frontmatter | CRITICAL | Security: `<` `>` forbidden |
| SK6 | No reserved name prefix | CRITICAL | "claude" or "anthropic" are reserved |
| SK7 | SKILL.md under 500 lines | MEDIUM | Progressive disclosure for larger skills |
| SK8 | allowed-tools is least-privilege | MEDIUM | Only tools the skill actually needs |

## Rules

| # | Check | Severity | What to look for |
|---|---|---|---|
| R1 | One topic per file | MEDIUM | testing.md, api-design.md — not "everything.md" |
| R2 | paths glob validity | HIGH | Glob patterns actually match intended files |
| R3 | No CLAUDE.md duplication | MEDIUM | Rule repeats what CLAUDE.md already says |
| R4 | Descriptive filename | LOW | Filename tells you the topic without reading |

## Hooks

| # | Check | Severity | What to look for |
|---|---|---|---|
| H1 | Valid event names | CRITICAL | PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/PreCompact/Stop/SessionEnd |
| H2 | type field present | CRITICAL | command/http/prompt/agent |
| H3 | command non-empty | CRITICAL | type=command but command="" |
| H4 | Timeout in range | HIGH | Default 600s for command; unreasonably high/low values |
| H5 | matcher regex valid | HIGH | Invalid regex = hook never fires |
| H6 | No secrets in command | CRITICAL | API keys, tokens in hook command string |
| H7 | async only on command type | MEDIUM | async: true on non-command hooks is ignored |

## Agents

| # | Check | Severity | What to look for |
|---|---|---|---|
| A1 | description present | HIGH | Without it, Claude doesn't know when to use the agent |
| A2 | tools restricted | MEDIUM | Least privilege; not all tools |
| A3 | model specified | LOW | Explicit is better than default |
| A4 | bypassPermissions warning | CRITICAL | bypassPermissions: true is dangerous |

## Permissions (settings.json)

| # | Check | Severity | What to look for |
|---|---|---|---|
| PM1 | No allow/deny conflicts | HIGH | Same pattern in both allow and deny |
| PM2 | No over-permissive Bash | HIGH | `Bash(*)` allows everything |
| PM3 | settings.local.json consistency | MEDIUM | Conflicts with settings.json |

## MCP (.mcp.json)

| # | Check | Severity | What to look for |
|---|---|---|---|
| MC1 | No hardcoded secrets in env | CRITICAL | API keys directly in .mcp.json |
| MC2 | Server command exists | HIGH | command points to installed binary |
| MC3 | Tool naming convention | LOW | mcp__server-name__tool-name |

## Memory

| # | Check | Severity | What to look for |
|---|---|---|---|
| ME1 | MEMORY.md under 200 lines | HIGH | Lines after 200 are truncated |
| ME2 | No duplicate entries | MEDIUM | Same information stored twice |
| ME3 | Memory files have frontmatter | MEDIUM | name, description, type fields |
| ME4 | No stale memories | LOW | References to completed/abandoned work |
