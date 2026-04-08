---
name: init
description: "Set up or re-initialize qult for the current project. Registers project in DB, detects gates, and stores config. Idempotent — safe to run multiple times. Use for initial setup or after changing toolchain. NOT for config changes (use /qult:config)."
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

## Step 2: Detect gates

Analyze the project toolchain and generate gate configuration.

### 2a: Discover toolchain

Check which config files exist **in the project root only** (not recursive). Use Glob with root-only patterns like `biome.json`, `tsconfig.json`, `package.json` — never `**/*` patterns.

Look for:

- **Lint**: biome.json, .eslintrc*, eslint.config.*, ruff.toml, .rubocop.yml, .golangci.yml, deno.json, stylelint.config.*
- **Typecheck**: tsconfig.json, pyrightconfig.json, mypy.ini, go.mod (go vet), Cargo.toml (cargo check)
- **Test**: package.json (check scripts/devDependencies for vitest/jest/mocha), pytest.ini, setup.cfg, go.mod, Cargo.toml, Gemfile, mix.exs, deno.json
- **E2E**: playwright.config.*, cypress.config.*, wdio.conf.*

Read the relevant config files to confirm which tools are actually configured.

If no toolchain config files are found, report "No tools detected".

### 2b: Build gates config

Build the gate config using this structure:

```json
{
  "on_write": {
    "lint": { "command": "...", "timeout": 3000 },
    "typecheck": { "command": "...", "timeout": 10000, "run_once_per_batch": true }
  },
  "on_commit": {
    "test": { "command": "...", "timeout": 30000 }
  },
  "on_review": {
    "e2e": { "command": "...", "timeout": 60000 }
  }
}
```

Rules:
- `on_write` commands use `{file}` placeholder for the edited file path (e.g. `biome check {file}`)
- `run_once_per_batch: true` for expensive commands that check the whole project (typecheck, full lint)
- `on_commit` commands run before each commit (unit/integration tests)
- `on_review` commands run during code review (e2e, browser tests)
- Omit empty categories
- Prefer fast tools (biome > eslint, ruff > flake8, pyright > mypy)
- Use the project's package manager (bun/pnpm/yarn/npm, uv/poetry, cargo, go)

### 2c: Verify

For each gate command, confirm the tool is available (e.g. `which biome`, `cargo --version`). Do NOT run full test suites or commands that modify state. If a tool is not installed, remove that gate.

### 2d: Store gates via MCP

Call `mcp__plugin_qult_qult__save_gates` with the gates object built in 2b. This atomically replaces all existing gates and invalidates the MCP server's cache.

Then call `mcp__plugin_qult_qult__get_gate_config` to verify the gates were stored correctly.

**Note**: The gate config is stored in `~/.qult/qult.db`, NOT in a project file. No project directory is modified.

## Step 3: Clean up legacy files

Remove if they exist (from older qult versions):
- `.qult/` directory (entire directory — no longer needed, state is in `~/.qult/qult.db`)
- `.claude/rules/qult.md` (old single rule file)
- `.claude/rules/qult-gates.md` (replaced by MCP instructions)
- `.claude/rules/qult-quality.md` (replaced by MCP instructions)
- `.claude/rules/qult-plan.md` (replaced by MCP instructions)
- Old qult entries in `.claude/settings.local.json` containing `.qult/hook.mjs`
- Remove `.qult/` from `.gitignore` if present (no longer needed)

## Output

```
qult initialized:
  DB: ~/.qult/qult.db — connected
  Gates: N on_write, N on_commit, N on_review
  Legacy cleanup: (list removed items, or "none")
```

If hooks don't fire in VS Code or your environment, suggest: `/qult:register-hooks`
