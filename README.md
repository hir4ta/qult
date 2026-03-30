# qult

![Version](https://img.shields.io/badge/version-0.16.8-7fbbb3?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-standalone_binary-a7c080?style=flat-square&logo=typescript&logoColor=d3c6aa)
![Hooks](https://img.shields.io/badge/hooks-5-dbbc7f?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-83c092?style=flat-square)

**Physically stop Claude's bad habits.** An evaluator harness that enforces code quality through structure.

> Claude is capable, but it leaves lint errors behind and moves to the next file. It commits without tests. It praises its own code and calls the review done.
> qult uses 5 hooks + MCP server + independent Opus evaluator to stop that with **exit 2 (DENY), not advisory messages**.
> Distributed as a Claude Code Plugin. Install with `/plugin install`.

> [!NOTE]
> You may see `SessionStart:startup hook error` or `Stop hook error` at session start. **This is not a qult bug.**
> It's a known Claude Code UI bug that misreports hook success/failure ([#12671](https://github.com/anthropics/claude-code/issues/12671), [#21643](https://github.com/anthropics/claude-code/issues/21643), [#10463](https://github.com/anthropics/claude-code/issues/10463)).
> Hooks are working correctly.

> [!WARNING]
> **PreToolUse DENY may be ignored.** qult correctly returns `exit 2`, but
> Claude Code sometimes executes the tool anyway
> ([#21988](https://github.com/anthropics/claude-code/issues/21988), [#4669](https://github.com/anthropics/claude-code/issues/4669), [#24327](https://github.com/anthropics/claude-code/issues/24327)).
> Waiting for a Claude Code fix.

[Japanese README / README.ja.md](README.ja.md)

## How it works

```mermaid
flowchart LR
    Edit["Edit / Write"] --> Gate{"Gate\n(lint, type)"}
    Gate -- pass --> OK["Continue"]
    Gate -- fail --> PF["pending-fixes"]
    PF --> Next["Try to Edit\nanother file"]
    Next --> DENY["DENY\n(exit 2)"]
    DENY --> Fix["Fix the\nsame file"]
    Fix --> Gate

    style DENY fill:#e67e80,color:#2d353b,stroke:#e67e80
    style OK fill:#a7c080,color:#2d353b,stroke:#a7c080
    style PF fill:#dbbc7f,color:#2d353b,stroke:#dbbc7f
```

Operates on the Generator-Evaluator pattern from Anthropic's [Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) article:

```mermaid
flowchart TB
    subgraph Generator["Generator"]
        Claude["Claude\n+ 5 hooks for quality gates"]
    end
    subgraph Evaluator["Evaluator"]
        Rev["/qult:review\n(Opus)"]
    end

    Claude -- "Task done" --> TV["TaskCompleted\nRun Verify immediately"]
    TV -- "FAIL" --> Claude
    TV -- "PASS" --> Claude
    Claude -- "All tasks done" --> Rev
    Rev -- "FAIL / score < 12\ntrend-aware block" --> Claude
    Rev -- "PASS + score >= 12/15" --> Done["Commit"]

    style Generator fill:#7fbbb3,color:#2d353b,stroke:#7fbbb3
    style Evaluator fill:#e69875,color:#2d353b,stroke:#e69875
    style Done fill:#a7c080,color:#2d353b,stroke:#a7c080
    style TV fill:#dbbc7f,color:#2d353b,stroke:#dbbc7f
```

## What it prevents

| Situation | Action |
|---|---|
| Lint/type errors left behind, moves to another file | **DENY** -- blocked until fixed |
| `git commit` without running tests | **DENY** -- requires test pass |
| Declares done without review or after FAIL | **block** -- requires /qult:review |
| Review PASS but low score | **block** -- trend-aware re-review (up to 3x) |
| Plan finalized with omissions | **DENY** -- forces session-wide check (once) |
| Declares done mid-plan | **block** -- requires all tasks completed |
| Plan task completed | **verify** -- runs Verify test immediately |

## 5 Hooks + MCP Server

| Type | Hook | Role |
|------|------|------|
| **Wall** (enforcement) | PostToolUse | Runs lint/type gates after Edit/Write, writes state |
| **Wall** (enforcement) | PreToolUse | DENY if pending fixes, require test/review before commit, force selfcheck on ExitPlanMode |
| **Completion gate** (enforcement) | Stop | Block if unresolved errors, incomplete tasks, or missing review |
| **Subagent** (enforcement) | SubagentStop | Validates review output + enforces trend-aware score threshold (12/15) |
| **Task verify** (advisory) | TaskCompleted | Runs Verify test immediately when plan task completes |

| MCP Tool | Role |
|----------|------|
| get_pending_fixes | Returns lint/typecheck error details |
| get_session_status | Returns test/review state |
| get_gate_config | Returns gate configuration |

## Installation

### 1. Install the plugin (once)

```
/plugin marketplace add hir4ta/qult
/plugin install qult@hir4ta-qult
```

Restart Claude Code after installation (end the session and start a new one).

### 2. Project setup (once per project)

```
/qult:init
```

What init does:
- Creates `.qult/` directory
- Generates `.qult/gates.json` -- auto-detects project lint/typecheck/test tools
- Places `.claude/rules/qult-gates.md` -- MCP tool invocation rules
- Places `.claude/rules/qult-quality.md` -- test-driven, scope management rules
- Places `.claude/rules/qult-plan.md` -- plan structure rules
- Adds `.qult/` to `.gitignore`

### 3. Verify setup

```
/qult:doctor
```

### Available commands after init

| Command | Description |
|---------|-------------|
| `/qult:status` | Show current quality gate status |
| `/qult:review` | Independent code review (Opus evaluator) |
| `/qult:detect-gates` | Re-detect gate configuration |
| `/qult:plan-generator` | Generate structured plan from feature description |
| `/qult:doctor` | Health check for setup |
| `/qult:update` | Update rules files after plugin update |

Hooks (PostToolUse, PreToolUse, Stop, SubagentStop, TaskCompleted) and MCP server run automatically.

## Updating

1. `/plugin` > qult details > update (hooks, skills, agents, MCP server are updated)
2. `/qult:update` (updates project rules files to latest)

## Uninstalling

`/plugin` > delete qult. Manually remove `.qult/` and `.claude/rules/qult*.md` from the project.

## Configuration

Customize thresholds in `.qult/config.json` (all optional):

```json
{
  "review": {
    "score_threshold": 12,
    "max_iterations": 3,
    "required_changed_files": 5
  },
  "gates": {
    "output_max_chars": 2000,
    "default_timeout": 10000
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `review.score_threshold` | number | 12 | Aggregate score required to pass review (max 15) |
| `review.max_iterations` | number | 3 | Maximum review retry iterations |
| `review.required_changed_files` | number | 5 | Number of changed files that triggers mandatory review |
| `gates.output_max_chars` | number | 2000 | Max gate output chars (excess is truncated) |
| `gates.default_timeout` | number | 10000 | Gate command timeout (ms) |

Environment variable overrides: `QULT_REVIEW_SCORE_THRESHOLD`, `QULT_REVIEW_MAX_ITERATIONS`, `QULT_REVIEW_REQUIRED_FILES`, `QULT_GATE_OUTPUT_MAX`, `QULT_GATE_DEFAULT_TIMEOUT`

<details>
<summary><strong>Supported languages and tools</strong></summary>

| Language | on_write (lint/type) | on_commit (test) | on_review (e2e) |
|---|---|---|---|
| **TypeScript/JS** | biome / eslint / tsc | vitest / jest / mocha | -- |
| **Python** | ruff / pyright / mypy | pytest | -- |
| **Go** | go vet | go test | -- |
| **Rust** | cargo clippy / check | cargo test | -- |
| **Ruby** | rubocop | rspec | -- |
| **Java/Kotlin** | ktlint / detekt | gradle test / mvn test | -- |
| **Elixir** | credo | mix test | -- |
| **Deno** | deno lint | deno test | -- |
| **Frontend** | stylelint | -- | playwright / cypress / wdio |

</details>

## Design principles

| Principle | Meaning |
|-----------|---------|
| **Wall > advisory** | Stop with DENY (exit 2). Advisories are assumed to be ignored |
| **fail-open** | All hooks use try-catch. qult failures never block Claude |
| **structural guarantee** | Quality enforced by structure. Stress-test assumptions, remove if broken |
| **zero dependencies** | All devDependencies + bun build bundle |

## Plan generation

```
/qult:plan-generator "Add JWT auth to the API"
  -> Opus analyzes the codebase
  -> Generates plan in WHAT/WHERE/VERIFY/BOUNDARY/SIZE format
  -> Writes to .claude/plans/
```

## Data storage

```
.qult/
└── .state/
    ├── session-state-{id}.json
    └── pending-fixes-{id}.json
```

- Scoped by session ID (concurrent session safe)
- Stale files auto-cleaned after 24h

## Troubleshooting

<details>
<summary><strong>"Hook Error" shown at session start</strong></summary>

Not a qult bug. Known Claude Code UI bug that misreports hook success/failure ([#12671](https://github.com/anthropics/claude-code/issues/12671), [#34713](https://github.com/anthropics/claude-code/issues/34713)). Hooks are working correctly.

</details>

<details>
<summary><strong>DENY issued but tool still executes</strong></summary>

Known Claude Code bug ([#21988](https://github.com/anthropics/claude-code/issues/21988), [#24327](https://github.com/anthropics/claude-code/issues/24327)). qult correctly returns exit 2, but Claude Code sometimes does not block. Awaiting fix.

</details>

<details>
<summary><strong>Gates not detected</strong></summary>

Run `/qult:detect-gates`. Ensure tool binaries are on PATH (`which biome`, `which tsc`, etc.). `node_modules/.bin` is searched automatically.

</details>

<details>
<summary><strong>Corrupt state files</strong></summary>

Delete files in `.qult/.state/` and start a new session. qult is fail-open by design -- corrupt state files will not block Claude.

</details>

<details>
<summary><strong>Skip gates for specific files</strong></summary>

Manually add an `extensions` field to gates in `.qult/gates.json` to restrict which file types are checked:

```json
{
  "on_write": {
    "lint": { "command": "biome check {file}", "extensions": [".ts", ".tsx"] }
  }
}
```

</details>

## Stack

TypeScript / MCP SDK / vitest (tests) / Biome (lint)

Distributed as a Claude Code Plugin. Development requires Bun 1.3+.
