---
name: init
description: "Set up or re-initialize qult for the current project. Creates .qult/ directory, detects gates, and configures .gitignore. Idempotent — safe to run multiple times. Use for initial setup or after changing toolchain. NOT for config changes (use /qult:config)."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
---

# /qult:init

Set up or re-initialize qult for this project. Idempotent — safe to run anytime.

## Step 1: Create `.qult/.state/` directory

Create if it doesn't exist. Skip if it already exists.

## Step 2: Detect gates and write `.qult/gates.json`

Analyze the project toolchain and generate gate configuration.

### 2a: Discover toolchain

Check which config files exist **in the project root only** (not recursive). Use Glob with root-only patterns like `biome.json`, `tsconfig.json`, `package.json` — never `**/*` patterns.

Look for:

- **Lint**: biome.json, .eslintrc*, eslint.config.*, ruff.toml, .rubocop.yml, .golangci.yml, deno.json, stylelint.config.*
- **Typecheck**: tsconfig.json, pyrightconfig.json, mypy.ini, go.mod (go vet), Cargo.toml (cargo check)
- **Test**: package.json (check scripts/devDependencies for vitest/jest/mocha), pytest.ini, setup.cfg, go.mod, Cargo.toml, Gemfile, mix.exs, deno.json
- **E2E**: playwright.config.*, cypress.config.*, wdio.conf.*

Read the relevant config files to confirm which tools are actually configured.

If no toolchain config files are found, report "No tools detected" and write an empty `{}` to gates.json.

### 2b: Build gates config

Write `.qult/gates.json` using this schema:

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
- Omit empty categories — don't write `"on_write": {}`
- Prefer fast tools (biome > eslint, ruff > flake8, pyright > mypy)
- Use the project's package manager (bun/pnpm/yarn/npm, uv/poetry, cargo, go)

### 2c: Verify

For each gate command, confirm the tool is available (e.g. `which biome`, `cargo --version`). Do NOT run full test suites or commands that modify state. If a tool is not installed, remove that gate.

## Step 3: Add `.qult/` to `.gitignore`

Add `.qult/` to `.gitignore` if not already present. Skip if already there.

## Step 4: Clean up legacy files

Remove if they exist (from older qult versions):
- `.claude/rules/qult.md` (old single rule file)
- `.claude/rules/qult-gates.md` (replaced by MCP instructions)
- `.claude/rules/qult-quality.md` (replaced by MCP instructions)
- `.claude/rules/qult-plan.md` (replaced by MCP instructions)
- `.qult/hook.mjs` (old standalone hook)
- Old qult entries in `.claude/settings.local.json` containing `.qult/hook.mjs`

## Output

```
qult initialized:
  .qult/.state/ — ready
  gates.json — N on_write, N on_commit, N on_review
  .gitignore — .qult/ added
```

If hooks don't fire in VS Code or your environment, suggest: `/qult:register-hooks`
