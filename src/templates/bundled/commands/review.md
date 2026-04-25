# /qult:review

4-stage independent code review. Use before a major commit, or whenever 5+ source files
have changed since the last review.

## Stages

Run all 4 stages independently. Each stage uses an isolated context (a fresh subagent /
session) so the reviewer cannot reuse the implementer's reasoning. Self-review misses
~64.5 % of self-introduced errors — independence is the gate.

1. **Spec compliance** — Implementation vs `requirements.md` / `tasks.md`. Every AC and
   every Wave task must be addressed; flag drift.
2. **Code quality** — Design smells, maintainability, edge cases, dead code, premature
   abstraction, missing test coverage, naming.
3. **Security** — OWASP Top 10, injection vectors, hardcoded secrets, unvalidated input,
   path traversal, deserialization. Use Tier 1 detector findings as ground truth (call
   MCP `get_detector_summary` first).
4. **Adversarial** — Concurrency, edge cases, silent failures, off-by-one, partial writes,
   error-recovery paths the implementer didn't think of.

## Scoring

Each stage scores per-dimension on 0–5; aggregate over 4 stages out of 40. Default
thresholds: aggregate ≥ 30, dimension floor ≥ 4. Adjustable via `.qult/config.json`.

## After review

1. Aggregate findings; filter by Succinctness / Accuracy / Actionability.
2. Surface only HIGH-severity items to the user.
3. On pass, call MCP `record_review(aggregate_score)`.
4. On fail, fix the findings and re-run the affected stages (max 3 iterations).

## Don'ts

- Do not let the implementing model self-review.
- Do not ignore detector findings — they are ground truth.
- Do not call `record_review` if any stage failed.
