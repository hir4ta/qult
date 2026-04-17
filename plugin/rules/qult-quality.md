# qult code quality

Defaults that apply to all qult-enabled projects.

## Trust standard tooling for routine checks

Lint and typecheck are run by the project's standard tools (biome, eslint, tsc, ruff, mypy, etc.). Run them after meaningful edits — not after every line. Use the project's configured `gates.on_write` commands (visible via `mcp__plugin_qult_qult__get_gate_config`).

## qult-specific quality gates

These are NOT covered by lint/typecheck and are enforced by `/qult:review` (Tier 1, always run):

- **security-check** — OWASP Top 10, hardcoded secrets, CORS misuse
- **dep-vuln-check** — osv-scanner against installed packages
- **hallucinated-package-check** — npm registry existence verification
- **test-quality-check** — empty tests, trivial assertions, always-true
- **export-check** — breaking change detection on public exports

## Opt-in heavy detectors

Available but disabled by default. Enable per-project via `set_config`:

- **dataflow-check** — Tree-sitter taint tracking (3-hop)
- **complexity-check** — cyclomatic / cognitive complexity
- **duplication-check** — cross-file duplication
- **semantic-check** — LSP-based unreachable / unused
- **mutation-test** — Stryker / mutmut score threshold

## On-demand execution

Detectors run during `/qult:review` Stage 0.7. To run them outside of review, ask the architect — there is no auto-fire on edit.

## Honest fixes

When a detector finding is a false positive, document why and call `mcp__plugin_qult_qult__clear_pending_fixes`. Do NOT silence findings by editing detector code.
