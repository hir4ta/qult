# qult

> **qu**ality + c**ult** — fanatical devotion to quality.
> A Claude Code plugin that catches what Claude misses.

[日本語 / README.ja.md](README.ja.md)

## What qult does

qult is a **quality aid for Claude** — it adds five capabilities Claude cannot reliably do alone:

1. **Independent review** (`/qult:review`) — 4 reviewers (spec / quality / security / adversarial) run in **separate subagent contexts** with reviewer model diversity (sonnet × 2 + opus × 2). The implementing model never grades itself. Research: self-review misses **64.5% of self-introduced bugs**¹; family-diverse reviewers reduce correlated errors.
2. **Independent plan evaluation** (`/qult:plan-generator` + `plan-evaluator`) — same architectural pattern as independent review: `plan-generator` produces a plan, then `plan-evaluator` scores it against Feasibility / Completeness / Clarity **in a fresh context**. Iterates until the score passes.
3. **External SAST + CVE knowledge** — `security-check` integrates Semgrep rulesets; `dep-vuln-check` queries osv-scanner against installed packages. Claude alone does not run SAST and does not know CVE data.
4. **Hallucinated package detection** — before an install command runs, `hallucinated-package-check` verifies the package actually exists in the registry. AI-assisted commits leak bad package names at **2× the baseline rate**².
5. **Consistency-guaranteed test quality checks** — `test-quality-check` always flags empty tests, always-true assertions, and trivial assertions. Reviewers can spot these when they happen to read the test file, but the detector flags them *every time*.

That's it. No hooks, no workflow hijacking. qult is a **toolbox**, not a guardrail — it provides sharp tools for you to reach for.

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security) · ² [GitGuardian 2026](https://blog.gitguardian.com/state-of-secrets-sprawl-2026/)

## Measured quality uplift

| Gap (Claude alone) | What qult adds | Observable outcome |
|---|---|---|
| Self-review blind spots | Independent 4-stage review | Bugs caught that the author missed |
| Plan-author blind spots | plan-evaluator in fresh context | Missing files / edge cases / consumer updates flagged before implementation |
| No SAST | Semgrep integration | OWASP Top 10 patterns surfaced |
| No CVE data | osv-scanner integration | Vulnerable dependencies flagged before commit |
| Package-name hallucination | Registry verification | Typosquatting / nonexistent packages blocked |
| Review attention drift (tests skimmed) | test-quality detector always-on | Empty tests / trivial assertions flagged every time |

**When qult is strongest:**
- Production code with 5+ file changes
- Security-sensitive work (auth, input parsing, crypto, external APIs)
- Dependency-heavy changes (new packages, version bumps)
- Multi-session features where state continuity matters

**When qult is overkill:**
- Quick single-file fixes
- Throwaway prototypes
- Spikes and experiments
- → Just skip the review step. qult is opt-in; no hook will block you.

## Install

```bash
# requires Bun: https://bun.sh
brew install semgrep         # recommended (used by security reviewer)
brew install osv-scanner     # recommended (used by dep-vuln-check)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # install workflow rules to ~/.claude/rules/
```

No files are created in your project. State lives in `~/.qult/qult.db`; workflow rules in `~/.claude/rules/qult-*.md`.

After updating the qult plugin later, run `/qult:update` to refresh rules.

## Commands

| Command | What |
|---|---|
| `/qult:init` | Install workflow rules and clean up legacy files (run once after plugin install) |
| `/qult:update` | Refresh rules from the plugin cache (run after plugin update) |
| `/qult:status` | Current state (pending fixes, tests, review) |
| `/qult:plan-generator` | Generate + score an implementation plan |
| `/qult:review` | 4-stage independent review |
| `/qult:finish` | Branch completion checklist |
| `/qult:debug` | Structured root-cause debugging |
| `/qult:skip` | Temporarily disable a detector |
| `/qult:config` | Tweak thresholds and reviewer models |
| `/qult:doctor` | Health check |
| `/qult:uninstall` | Remove qult cleanly |

## Reviewer model mix

| Stage | Model | Why |
|---|---|---|
| spec-reviewer | sonnet | Mechanical plan-vs-code check |
| quality-reviewer | sonnet | Design judgment, fast iteration |
| **security-reviewer** | **opus** | High-stakes — **45% of AI code has vulnerabilities**³ |
| **adversarial-reviewer** | **opus** | Final guardian — edge cases, silent failures |
| plan-generator | sonnet | Generation task |
| **plan-evaluator** | **opus** | Spec quality gate — bad plans poison downstream |

Override via `review.models.*` config or `QULT_REVIEW_MODEL_*` env vars.

³ [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## Honest limits

- **Advisory, not enforcement**: rules at `~/.claude/rules/qult-*.md` are prompt-level guidance. Research (AgentPex) shows **83% of agent traces contain at least one procedural violation** — rules are usually followed, but not reliably. You (the architect) need to actually invoke the skills, or accept that they may be skipped.
- **Review has a token cost**: `/qult:review` spawns 4 subagents reading the diff. For medium changes this adds ~40–100k tokens. Worth it for production code; skip it for tweaks.
- **Detectors are pattern/AST-based, biased toward TypeScript-ish codebases**: security-check and test-quality-check cover multi-language basics, but Python/Go/Rust projects get reduced fidelity.

## Uninstall

```bash
/plugin → delete qult
rm -f ~/.claude/rules/qult-*.md
rm -rf ~/.qult          # optional — drops session history DB
```

## Philosophy

```
qult is a Claude aid, not a perfect harness.
Harness engineering research inspires the design — it is not the design.
When in doubt, pick the lighter option.
Add a feature only if Claude cannot do it alone.
```

## Stack

TypeScript / Bun 1.3+ / bun:sqlite / vitest / Biome
