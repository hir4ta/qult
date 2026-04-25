# qult

> **qu**ality + c**ult** — fanatical devotion to quality.
> A Claude Code plugin that catches what Claude misses.

[日本語 / README.ja.md](README.ja.md)

## What qult does

qult is a **quality aid for Claude** — it adds capabilities Claude cannot reliably do alone:

1. **Spec-Driven Development pipeline** (`/qult:spec`) — drafts `requirements.md` (EARS notation) → mandatory `/qult:clarify` round → `design.md` → `tasks.md` (Wave breakdown), with an independent `spec-evaluator` gate at every phase. Markdown is the single source of truth and is committed alongside the code it describes.
2. **Wave-based implementation** — Wave = a bounded, individually-test-passing chunk. Implement freely with `/qult:wip` (auto-prefixes `[wave-NN]`), close with `/qult:wave-complete` which runs tests + Tier-1 detectors + records the commit Range. Reviewers can read `git log --grep '\[wave-02\]'` to see exactly what each Wave shipped.
3. **Independent review** (`/qult:review`) — 4 reviewers (spec / quality / security / adversarial) run in **separate subagent contexts** with reviewer model diversity (sonnet × 2 + opus × 2). The implementing model never grades itself. Research: self-review misses **64.5% of self-introduced bugs**¹; family-diverse reviewers reduce correlated errors.
4. **External SAST + CVE knowledge** — `security-check` integrates Semgrep rulesets; `dep-vuln-check` queries osv-scanner against installed packages. Claude alone does not run SAST and does not know CVE data.
5. **Hallucinated package detection** — before an install command runs, `hallucinated-package-check` verifies the package actually exists in the registry. AI-assisted commits leak bad package names at **2× the baseline rate**².
6. **Consistency-guaranteed test quality checks** — `test-quality-check` always flags empty tests, always-true assertions, and trivial assertions. Reviewers can spot these when they happen to read the test file, but the detector flags them *every time*.

That's it. No hooks, no workflow hijacking. qult is a **toolbox**, not a guardrail — it provides sharp tools for you to reach for.

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security) · ² [GitGuardian 2026](https://blog.gitguardian.com/state-of-secrets-sprawl-2026/)

## Measured quality uplift

| Gap (Claude alone) | What qult adds | Observable outcome |
|---|---|---|
| Plan-as-prompt only, lost on session end | Spec markdown committed to repo | Future sessions / reviewers can read what was promised |
| Ambiguous requirements slip through | Mandatory `/qult:clarify` (5–10 q × ≤3 rounds) | Open Questions resolved before design starts |
| Self-review blind spots | Independent 4-stage review | Bugs caught that the author missed |
| Spec-author blind spots | `spec-evaluator` in fresh context (4 dimensions, threshold 18/17/16) | Missing edge cases / vague AC / scope drift flagged before implementation |
| No SAST | Semgrep integration | OWASP Top 10 patterns surfaced |
| No CVE data | osv-scanner integration | Vulnerable dependencies flagged before commit |
| Package-name hallucination | Registry verification | Typosquatting / nonexistent packages blocked |
| Review attention drift (tests skimmed) | test-quality detector always-on | Empty tests / trivial assertions flagged every time |
| "Which commits implement Wave 2?" guesswork | Wave-NN.md records commit range | `git log Range` answers it precisely |

**When qult is strongest:**
- Multi-Wave features where the spec is non-trivial
- Production code with 5+ file changes
- Security-sensitive work (auth, input parsing, crypto, external APIs)
- Dependency-heavy changes (new packages, version bumps)

**When qult is overkill:**
- Quick single-file fixes (typo, lockfile bump)
- Throwaway prototypes
- Spikes and experiments
- → Just skip the spec / review steps. qult is opt-in; no hook will block you.

## Install

```bash
# requires Bun: https://bun.sh
brew install semgrep         # recommended (used by security reviewer)
brew install osv-scanner     # recommended (used by dep-vuln-check)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # bootstrap .qult/ + install rules to ~/.claude/rules/
```

`/qult:init` creates a `.qult/` directory in your project (`specs/` and `config.json` are committed; `state/` is gitignored). Workflow rules are installed to `~/.claude/rules/qult-*.md`.

After updating the qult plugin later, run `/qult:update` to refresh rules.

## Lifecycle in 30 seconds

```bash
/qult:spec add-oauth "OAuth login with refresh tokens"
   → drafts requirements.md, runs /qult:clarify (mandatory),
     drafts design.md, drafts tasks.md (Wave breakdown).
     Each phase passes a spec-evaluator gate (threshold 18/17/16).

/qult:wave-start                # records HEAD as Wave start commit
…implement Wave 1…
/qult:wip "OAuth handler skeleton"   # `[wave-01] wip: OAuth handler skeleton`
/qult:wip "tests"
/qult:wave-complete             # runs tests + detectors, commits, records Range

# repeat /qult:wave-start … /qult:wave-complete per Wave

/qult:review                    # at spec completion, 4-stage independent review
/qult:finish                    # archive .qult/specs/add-oauth/ → archive/, then merge/PR/hold/discard
```

## Commands

| Command | What |
|---|---|
| `/qult:init` | Bootstrap `.qult/` and install workflow rules (run once per project) |
| `/qult:update` | Refresh rules from the plugin cache (run after plugin update) |
| `/qult:status` | Current state (active spec, pending fixes, tests, review). `/qult:status archive` lists archived specs |
| `/qult:spec` | Start a new spec — runs requirements → clarify → design → tasks |
| `/qult:clarify` | Re-run clarification on the active spec when scope changes |
| `/qult:wave-start` | Record the start commit of the next incomplete Wave |
| `/qult:wave-complete` | Test + detector + commit + record Range. Closes the current Wave |
| `/qult:wip` | Make a `[wave-NN] wip: …` commit during a Wave |
| `/qult:review` | 4-stage independent review at spec completion |
| `/qult:finish` | Archive spec + merge/PR/hold/discard |
| `/qult:debug` | Structured root-cause debugging |
| `/qult:skip` | Temporarily disable a detector |
| `/qult:config` | View / change `.qult/config.json` |
| `/qult:doctor` | Health check (`.qult/` layout, `.gitignore`, MCP, no legacy state) |
| `/qult:uninstall` | Remove qult cleanly |

## Reviewer model mix

| Agent | Model | Why |
|---|---|---|
| spec-generator | sonnet | Generation across requirements / design / tasks (phase-aware) |
| spec-clarifier | **opus** | 5–10 question generation + answer-folding |
| spec-evaluator | **opus** | 3-phase gate — bad spec poisons everything downstream |
| spec-reviewer | sonnet | Mechanical spec-vs-code check |
| quality-reviewer | sonnet | Design judgment, fast iteration |
| **security-reviewer** | **opus** | High-stakes — **45% of AI code has vulnerabilities**³ |
| **adversarial-reviewer** | **opus** | Final guardian — edge cases, silent failures |

Override via `review.models.*` keys in `.qult/config.json` or `QULT_REVIEW_MODEL_*` env vars.

³ [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## Honest limits

- **Advisory, not enforcement**: rules at `~/.claude/rules/qult-*.md` are prompt-level guidance. Research (AgentPex) shows **83% of agent traces contain at least one procedural violation** — rules are usually followed, but not reliably. You (the architect) need to actually invoke the skills, or accept that they may be skipped.
- **Review has a token cost**: `/qult:review` spawns 4 subagents reading the diff. Medium changes ≈ 40–100k tokens. qult runs review at **spec completion only** (not per Wave) to keep cost bounded.
- **Detectors are pattern/AST-based, biased toward TypeScript-ish codebases**: security-check and test-quality-check cover multi-language basics, but Python/Go/Rust projects get reduced fidelity.
- **Single-architect tool**: state writes use atomic rename without locking. Concurrent worktrees editing the same `.qult/` is out-of-scope (clone the repo per worktree if you need parallelism).
- **Claude Code only**: not currently usable from Cursor / Gemini CLI / Copilot. Markdown is portable but the orchestration uses Claude-specific subagents.

## Uninstall

```bash
/qult:uninstall                 # interactive: removes ~/.claude/rules/qult-*.md, optional .qult/
/plugin → uninstall qult
```

## Philosophy

```
qult is a Claude aid, not a perfect harness.
Harness engineering research inspires the design — it is not the design.
Markdown is the source of truth.
When in doubt, pick the lighter option.
Add a feature only if Claude cannot do it alone.
```

## Stack

TypeScript / Bun 1.3+ / vitest / Biome / `.qult/state/*.json` (atomic-rename file I/O, zero npm deps)
