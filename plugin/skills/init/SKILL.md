---
name: init
description: "Set up or re-initialize qult for the current project. Detects toolchain via Claude's judgment (any language), registers gates in DB, and installs workflow rules. Idempotent — safe to run multiple times."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - mcp__plugin_qult_qult__get_gate_config
  - mcp__plugin_qult_qult__get_session_status
  - mcp__plugin_qult_qult__save_gates
---

# /qult:init

Set up or re-initialize qult for this project. Idempotent — safe to run anytime.

## Step 1: Verify DB connectivity

Call `mcp__plugin_qult_qult__get_session_status` to verify the qult MCP server is running and the DB is accessible. If it fails, check that Bun is installed and the qult plugin is loaded.

## Step 2: Detect gates — LLM-driven, language-agnostic

Use your own judgment to detect lint / typecheck / test / e2e commands for this project. qult does NOT maintain a hardcoded list of tools or languages — you are expected to figure it out from the project files.

### 2a: Discover config files (root-only)

List config files **in the project root only** (not recursive). Use Bash: `ls -1 | head -50`. Then Read any file that looks like a toolchain config (package.json, Cargo.toml, go.mod, pyproject.toml, composer.json, Gemfile, pom.xml, build.gradle, deno.json, mix.exs, stack.yaml, *.nimble, Package.swift, CMakeLists.txt, etc.).

Do NOT use recursive Glob patterns like `**/*` — they are slow and usually match node_modules.

### 2b: Build gates config using judgment

Based on what you found, construct a gate config:

```json
{
  "on_write": {
    "lint": { "command": "...", "timeout": 3000 },
    "typecheck": { "command": "...", "timeout": 15000, "run_once_per_batch": true }
  },
  "on_commit": {
    "test": { "command": "...", "timeout": 60000 }
  },
  "on_review": {
    "e2e": { "command": "...", "timeout": 120000 }
  }
}
```

Principles:
- `on_write` commands use `{file}` placeholder for the edited file path when the tool supports per-file linting (e.g. `biome check {file}`, `eslint {file}`, `ruff check {file}`)
- `run_once_per_batch: true` for whole-project commands (tsc, cargo check, go vet)
- `on_commit` commands run the full test suite
- `on_review` commands run e2e / integration tests that are slower
- Omit any category you cannot find a command for
- Prefer **fast, modern tools** when multiple options exist (biome > eslint, ruff > flake8, pyright > mypy, clippy > default, gotestsum > go test)
- Use the project's actual package manager and invocation style (bun/pnpm/yarn/npm, uv/poetry/pip, cargo, go, mvn/gradle, composer, mix, stack, swift)
- If the project has npm scripts that wrap commands (e.g. `"test": "bun vitest run"`), prefer the wrapper script so conventions match

### 2c: Verify tools are available

For each gate command, run a lightweight availability check — typically `which <tool>` or `<tool> --version`. Do NOT run the full test suite or any command that modifies state. If a tool is not installed, omit that gate rather than failing.

### 2d: Report what you decided

Before saving, show the architect the gate config you plan to save and why you chose each command. One line per gate. Give them a chance to override.

### 2e: Save via MCP

Call `mcp__plugin_qult_qult__save_gates` with the gates object. This atomically replaces all existing gates.

Then call `mcp__plugin_qult_qult__get_gate_config` to confirm the save succeeded.

**Note**: Gate config is stored in `~/.qult/qult.db`, NOT in a project file. No project directory is modified.

## Step 3: Install user-level rules

qult ships workflow rules in `${CLAUDE_PLUGIN_ROOT}/rules/qult-*.md`. Copy them to `~/.claude/rules/` so Claude loads them in every session:

```bash
mkdir -p ~/.claude/rules
cp -f "${CLAUDE_PLUGIN_ROOT}/rules/"qult-*.md ~/.claude/rules/
```

**Always overwrite** — qult may have updated rule contents in a new version.

## Step 4: Clean up legacy files

Remove if they exist (from older qult versions):
- `.qult/` directory (state lives in `~/.qult/qult.db`)
- `.claude/rules/qult*.md` (rules moved to user level)
- Old settings.local.json hook entries referencing `.qult/hook.mjs` or `dist/hook.mjs`
- `.qult/` from `.gitignore`

## Output

```
qult initialized:
  DB: ~/.qult/qult.db — connected
  Gates: N on_write, N on_commit, N on_review
  Rules: N installed at ~/.claude/rules/qult-*.md
  Legacy cleanup: (list removed items, or "none")
```
