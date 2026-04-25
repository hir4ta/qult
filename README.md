# qult

> **qu**ality + c**ult** — fanatical devotion to quality.
> A multi-agent SDD + harness engineering toolkit, distributed as an `npx` command.

[日本語 / README.ja.md](README.ja.md)

## What qult is

qult installs a structured Spec-Driven Development workflow and a stateful MCP server
into your project, usable from any AI coding tool that supports MCP — Claude Code,
OpenAI Codex, Cursor, and Gemini CLI. It writes the right config files for every tool
you have, keeps a single AGENTS.md as the source of truth, and tracks spec / wave /
test / review state under `.qult/`.

Inspired by [GitHub spec-kit](https://github.com/github/spec-kit) and
[OpenSpec](https://github.com/Fission-AI/OpenSpec). The prior version of qult was a
Claude Code Plugin; v1.1 onwards is a tool-agnostic CLI.

## Quick start

```bash
# In your project
npx qult init                # auto-detects .claude/ / .cursor/ / .codex/ / .gemini/
npx qult init --agent claude # or pick one explicitly
npx qult check               # snapshot of SDD state
```

`init` writes:

- `AGENTS.md` (the workflow source of truth, with a `<!-- @generated -->` block)
- per-tool context file (`CLAUDE.md`, `GEMINI.md`, `.cursor/rules/qult.mdc`)
- per-tool slash commands (`.claude/commands/qult-*.md`, `.gemini/commands/qult-*.toml`)
- per-tool MCP server registration (`.mcp.json`, `.cursor/mcp.json`,
  `.gemini/settings.json`, `.codex/config.toml`)
- `.qult/config.json` recording which integrations are enabled

## Subcommands

| command | what it does |
|---------|--------------|
| `qult init` | bootstrap qult; choose integrations |
| `qult update` | refresh integration files from the latest bundled templates (`@generated` blocks only) |
| `qult check [--detect] [--json]` | print SDD state; `--detect` runs Tier 1 detectors |
| `qult add-agent <key> [--force]` | add a single integration after init |
| `qult mcp` | start the stdio JSON-RPC MCP server (called by tools — you usually do not run this) |

Common flags: `--agent <key>` (init only), `--force`, `--json`, `--version`, `--help`.

## SDD lifecycle (driven by the MCP server)

1. `/qult:spec <name> <description>` — drafts `.qult/specs/<name>/{requirements,design,tasks}.md`
   with mandatory clarify and per-phase quality gate.
2. `/qult:wave-start` → implement → `/qult:wave-complete` — per Wave, with a
   `[wave-NN]`-prefixed conventional commit and verified commit-range integrity.
3. `/qult:review` — independent 4-stage review (spec compliance / code quality / security /
   adversarial). Required before commit when 5+ source files changed.
4. `/qult:finish` — archive the spec, then merge / open a PR / hold / discard.

## Supported AI tools

- **Claude Code** — `.claude/commands/`, `CLAUDE.md`, `.mcp.json`
- **OpenAI Codex CLI** — `AGENTS.md`, `.codex/config.toml`
- **Cursor** — `.cursor/rules/qult.mdc`, `.cursor/mcp.json`
- **Gemini CLI** — `.gemini/commands/*.toml`, `GEMINI.md`, `.gemini/settings.json`

All four register the same `qult` MCP server (`npx qult mcp`) so the workflow tools
behave identically across editors.

## `.qult/` directory layout

```
.qult/
├── config.json         # committed: integrations.enabled, review thresholds, etc.
├── specs/              # committed: spec markdown
│   ├── <name>/{requirements,design,tasks}.md + waves/wave-NN.md
│   └── archive/<name>/ # finished specs
└── state/              # gitignored: ephemeral test/review/finish state
```

## Requirements

- Node.js 20 or newer
- An AI coding tool that speaks MCP (any of the four above; `generic` AGENTS.md-only
  fallback is planned for a future version)
- Optional: `semgrep` (for security-check), `osv-scanner` (for dep-vuln-check)

## Development

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # biome check src/
npm run build      # tsup → dist/{cli,mcp-server}.js
```

## License

MIT
