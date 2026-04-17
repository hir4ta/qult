# qult

> **qu**ality + c**ult** — fanatical devotion to quality.
> A Claude Code plugin that helps Claude ship higher-quality, less-omission-prone code.

[日本語 / README.ja.md](README.ja.md)

## What qult does

qult is an **aid for Claude**, not a perfect harness engineering implementation. It gives Claude:

- **Workflow rules** at `~/.claude/rules/qult-*.md` — Plan → Implement → Review → Finish
- **Independent 4-stage review** (`/qult:review`) — spec, quality, security, adversarial reviewers run in separate subagent contexts (sonnet × 2 + opus × 2). The implementing model never reviews its own work.
- **Structured planning** (`/qult:plan-generator` + `plan-evaluator`) — plans are scored before implementation begins.
- **Tier 1 detectors** surfaced through MCP — security patterns, dep vulnerabilities, hallucinated packages, test quality, breaking export changes. Ground truth for reviewers.

That's it. Everything else (complexity metrics, taint tracking, flywheel learning, SBOM generation) was removed in v0.30 because **Claude can judge those by reading the code** — we only automate what Claude cannot do alone.

## Why install qult

| Without qult | With qult |
|---|---|
| Claude reviews its own code (self-review misses 64.5% of self-bugs¹) | Independent reviewers in separate contexts |
| Plans scope-creep or miss consumers | plan-evaluator scores against Feasibility / Completeness / Clarity |
| Secrets, OWASP patterns, vulnerable deps slip in | Detectors flag them as reviewer ground truth |
| "tests passed, shipping it" | `/qult:status` + `/qult:finish` checklist |
| Knowledge about each project lives in chat | State is durable in `~/.qult/qult.db` |

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security)

## Install

```bash
# requires Bun: https://bun.sh
brew install semgrep         # recommended (security reviewer)
brew install osv-scanner     # recommended (dep-vuln-check)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # detects toolchain (any language), installs rules
```

No files are created in your project. State lives in `~/.qult/qult.db`; rules in `~/.claude/rules/qult-*.md`.

## Commands

| Command | What |
|---|---|
| `/qult:init` | Setup / re-init (idempotent) |
| `/qult:status` | Current state (pending fixes, tests, review) |
| `/qult:plan-generator` | Generate + evaluate an implementation plan |
| `/qult:review` | 4-stage independent review |
| `/qult:finish` | Branch completion checklist |
| `/qult:debug` | Structured root-cause debugging |
| `/qult:skip` | Temporarily disable a gate |
| `/qult:config` | Tweak thresholds |
| `/qult:doctor` | Health check |
| `/qult:uninstall` | Remove qult cleanly |

## Reviewer model mix (B+ plan)

| Stage | Model | Why |
|---|---|---|
| spec-reviewer | sonnet | Mechanical plan-vs-code check |
| quality-reviewer | sonnet | Design judgment, fast |
| **security-reviewer** | **opus** | High-stakes (45% of AI code has vulnerabilities²) |
| **adversarial-reviewer** | **opus** | Final guardian — edge cases, silent failures |
| plan-generator | sonnet | Generation task |
| **plan-evaluator** | **opus** | Spec quality gate — bad plans poison downstream |

Override via `review.models.*` config or `QULT_REVIEW_MODEL_*` env vars.

² [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## Uninstall

```bash
/plugin → delete qult
rm -f ~/.claude/rules/qult-*.md
rm -rf ~/.qult          # optional — drops session history DB
```

## v0.29 → v0.30 changes

- Removed: flywheel, tree-sitter dataflow, complexity metrics, mutation-testing, SBOM, LSP integration, escalation counters, `/qult:explore`, `/qult:writing-skills`, 6 MCP tools, 2 detectors
- `/qult:init` now uses Claude's judgment to detect toolchain (no more hardcoded language list)
- Net: ~5000 lines removed; plugin install size down 10MB+ (no WASM)

## Philosophy

```
qult is a Claude aid, not a perfect harness.
Harness engineering research inspires the design — it is not the design.
When in doubt, pick the lighter option.
Add a feature only if Claude cannot do it alone.
```

## Stack

TypeScript / Bun 1.3+ / bun:sqlite / vitest / Biome
