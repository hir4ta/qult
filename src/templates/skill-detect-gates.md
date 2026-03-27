---
name: qult-detect-gates
description: >
  Detect project lint/typecheck/test/e2e tools and write .qult/gates.json.
  Use when gates are empty, after changing toolchain, or when prompted by qult hooks.
  Works with any language or framework.
  NOT for manual gates.json editing or removing specific gates.
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
---

# /qult:detect-gates

Analyze the project and generate `.qult/gates.json` with the correct gate commands.

## Step 1: Discover toolchain

Use Glob to find config files in the project root. Look for (not limited to):

- **Lint**: biome.json, .eslintrc*, eslint.config.*, ruff.toml, .rubocop.yml, .golangci.yml, .swiftlint.yml, phpstan.neon, .credo.exs, shellcheck, tflint, ktlint, detekt, stylelint, deno.json
- **Typecheck**: tsconfig.json, pyrightconfig.json, mypy.ini, go.mod (go vet), Cargo.toml (cargo check)
- **Test**: package.json (vitest/jest/mocha), pytest.ini, setup.cfg, go.mod, Cargo.toml, Gemfile (rspec), build.gradle, pom.xml, mix.exs, deno.json
- **E2E**: playwright.config.*, cypress.config.*, wdio.conf.*

Read the relevant config files to confirm which tools are actually configured.

If no toolchain config files are found, report "No tools detected" and write an empty `{}` to gates.json.

## Step 2: Build gates config

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

## Step 3: Verify

For each gate command, confirm the tool is available (e.g. `which biome`, `cargo --version`). Do NOT run full test suites or commands that modify state. If a tool is not installed, remove that gate.

## Output

Print the final gates.json content and confirm: `Gates configured: N on_write, N on_commit, N on_review`
