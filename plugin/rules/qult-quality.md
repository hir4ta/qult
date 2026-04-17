# qult code quality

Defaults that apply to all qult-enabled projects.

## Trust standard tooling for routine checks

Lint and typecheck are run by the project's standard tools (biome, eslint, tsc, ruff, mypy, cargo clippy, etc.). The configured commands are visible via `mcp__plugin_qult_qult__get_gate_config`. Run them after meaningful edits — not after every line.

## qult-specific quality gates (Tier 1)

These are NOT covered by standard lint/typecheck and are used by `/qult:review`:

- **security-check** — OWASP Top 10 patterns, hardcoded secrets, CORS misuse
- **dep-vuln-check** — osv-scanner against installed packages
- **hallucinated-package-check** — registry existence verification before install
- **test-quality-check** — empty tests, trivial assertions, always-true
- **export-check** — breaking change detection on public exports

## Honest fixes

When a detector finding is a false positive, document why and call `mcp__plugin_qult_qult__clear_pending_fixes`. Do NOT silence findings by editing detector code.

## Not everything is a detector's job

Code complexity, design smells, duplication, unused imports, semantic issues (unreachable code, loose equality) — these are **review-level** concerns. The reviewer agents (`/qult:review`) read the code and evaluate these holistically. qult does not ship dedicated detectors for them in v0.30 — the reviewer's judgment is better than rigid pattern matching.
