# qult

> **qu**ality + c**ult** — fanatical devotion to quality.
> Spec-Driven Development + harness engineering for AI coding tools, in one `npx` command.

[日本語 / README.ja.md](README.ja.md)

## What qult does

`qult` installs a structured workflow into your project so any AI coding tool can drive
the same Spec-Driven Development (SDD) process — drafting specs with mandatory clarify
rounds and quality gates, splitting work into commit-anchored Waves, running an
independent 4-stage code review, and tracking everything (test pass / review completion /
detector findings) in versioned `.qult/` files.

It also installs an MCP server that gives your AI tool direct, auditable access to that
state. The same workflow runs identically across **Claude Code**, **OpenAI Codex CLI**,
**Cursor**, and **Gemini CLI**.

## Features

- **5-step lifecycle**: spec → wave-start → implement → wave-complete → review → finish
- **Mandatory clarify** before any spec is locked in
- **Per-phase quality gates** (requirements / design / tasks scored independently)
- **Wave-anchored commits** with verified `[wave-NN]` prefix and SHA range integrity
- **Independent 4-stage review** (spec compliance / code quality / security / adversarial)
- **Tier 1 detectors** — security, dependency vulnerabilities, hallucinated packages,
  test quality, breaking export changes
- **AGENTS.md is the single source of truth** for workflow rules; per-tool files import it
- **Idempotent updates** — `qult update` refreshes generated blocks without losing your edits
- **MCP server** — your AI tool can read/write SDD state through 20 typed tools

## Quick start

```bash
# In your project root
npx @hir4ta/qult init                # auto-detects which AI tools you use
npx @hir4ta/qult init --agent claude # or pick one explicitly
```

After init, just talk to your AI tool — `/qult:spec`, `/qult:wave-start`,
`/qult:wave-complete`, `/qult:review`, `/qult:finish` are now available as slash commands.

## Commands

| command | what it does |
|---------|--------------|
| `qult init [--agent <key>] [--force]` | bootstrap qult; choose AI tool integrations |
| `qult update` | refresh integration files from the latest templates (preserves your edits outside `@generated` blocks) |
| `qult check [--detect] [--json]` | print SDD state; `--detect` runs Tier 1 detectors |
| `qult add-agent <key> [--force]` | add a single integration after init |
| `qult mcp` | start the MCP server (called by AI tools — you don't run this manually) |

Common flags: `--force` (overwrite without prompt), `--json` (CI-friendly output),
`--version`, `--help`.

## SDD lifecycle

```
1. /qult:spec <name> <description>
   ├── drafts requirements.md (with mandatory clarify, score ≥ 18/20)
   ├── drafts design.md (score ≥ 17/20)
   └── drafts tasks.md (score ≥ 16/20)

2. /qult:wave-start  →  implement tasks  →  /qult:wave-complete
   (Wave gate: range integrity → test pass → detector check → conventional commit)

3. /qult:review
   └── 4 independent reviewers: spec / quality / security / adversarial

4. /qult:finish
   └── archive spec, then merge / open PR / hold / discard
```

## Supported AI tools

| tool | files generated |
|------|-----------------|
| **Claude Code** | `.claude/commands/`, `CLAUDE.md`, `.mcp.json` |
| **OpenAI Codex CLI** | `AGENTS.md`, `.codex/config.toml` |
| **Cursor** | `.cursor/rules/qult.mdc`, `.cursor/mcp.json` |
| **Gemini CLI** | `.gemini/commands/*.toml`, `GEMINI.md`, `.gemini/settings.json` |

All four register the same `qult` MCP server so the workflow tools behave identically
across editors.

## `.qult/` directory

```
.qult/
├── config.json         # committed: enabled integrations, review thresholds
├── specs/
│   ├── <name>/{requirements,design,tasks}.md + waves/wave-NN.md
│   └── archive/        # finished specs
└── state/              # gitignored: ephemeral test/review/finish state
```

## Requirements

- Node.js 20 or newer
- An AI coding tool that supports MCP (any of the four above)

### Recommended (boost detector coverage)

Both are auto-skipped if missing — qult never fails because they're not installed.

- **[osv-scanner](https://github.com/google/osv-scanner)** — Google's OSS lockfile
  vulnerability scanner. Enables `dep-vuln-check` to find known CVEs in your
  dependencies. Install: `brew install osv-scanner` or download a release binary.
- **[semgrep](https://semgrep.dev)** — open-source static analyzer. When `semgrep`
  is on your PATH AND `security.enable_semgrep` is `true` in `.qult/config.json`
  (or `QULT_ENABLE_SEMGREP=1`), `security-check` runs semgrep alongside qult's
  built-in pattern matchers. Install: `brew install semgrep` or `pip install semgrep`.
  Override the rule pack with `QULT_SEMGREP_CONFIG` (default: `auto`).

## License

MIT
