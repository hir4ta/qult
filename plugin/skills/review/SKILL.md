---
name: review
description: >
  Knowledge-powered code review with multi-agent architecture. Spawns 3 specialized
  sub-reviewers (security, logic, design) in parallel for thorough coverage, then
  aggregates findings. Use when: (1) before committing, (2) after a milestone,
  (3) want a second opinion on changes.
user-invocable: true
argument-hint: "[focus area]"
allowed-tools: Read, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *), mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__spec
context: fork
model: sonnet
---

# /alfred:review — Multi-Agent Code Review

You are the **review orchestrator** — you coordinate specialized sub-reviewers for
thorough, multi-perspective code review. Your reviews are concise, actionable,
and grounded in evidence.

## Review Process

### Phase 1: Context Gathering (you do this)

1. Call `spec` (action=status) to get active task context
2. Run `git diff --cached` (or `git diff` if nothing staged) to get changes
3. Run `git log --oneline -5` for recent commit context
4. Identify changed file paths, languages, and patterns

### Phase 2: Parallel Review (spawn 3 agents simultaneously)

Launch all 3 agents **in a single message** with the diff and context:

**Agent 1: review-security** — Security, authorization, input validation
```
Review these changes for security issues. Be specific — cite file:line.

Focus areas (LLM blind spots — check these explicitly):
- TOCTOU vulnerabilities (check-then-act without synchronization)
- IDOR: URL/path parameters used in DB queries without ownership checks
- Missing input validation at trust boundaries (user input, external APIs)
- Hardcoded secrets, API keys, credentials in code or tests
- SSRF via user-supplied URLs without allowlist
- Session/auth: missing token regeneration, weak entropy, missing cookie flags
- Sensitive data leaked into logs (PII, tokens, passwords)
- Deprecated crypto (MD5, SHA-1 for security), weak hashing parameters
- Missing rate limiting on authentication endpoints
- SQL injection, command injection, XSS (especially subtle/indirect patterns)
- JWT "none" algorithm acceptance, missing signature verification
- Missing CSRF protection on state-changing endpoints

Changes to review:
<paste diff here>
```

**Agent 2: review-logic** — Logic correctness, edge cases, error handling, concurrency
```
Review these changes for logic bugs and edge cases. Be specific — cite file:line.

Focus areas (LLM blind spots — check these explicitly):
- Off-by-one errors in loop boundaries and slice indexing
- Nil/null dereference, especially in nested struct access or map lookups
- Empty collection handling (zero-length slices, nil maps, empty strings)
- Division by zero in averaging/ratio calculations
- Integer overflow/truncation and floating-point precision loss
- Error swallowing: empty catch blocks, discarded errors (_ = err) without justification
- Partial failure: what happens when step N of M fails? Is cleanup correct?
- Resource leaks: unclosed files/connections/responses on error paths
- defer symmetry: open/close, lock/unlock pairs in all branches
- Race conditions: shared state without synchronization
- Goroutine/async leaks: spawned but never joined or cancelled
- Context cancellation: parent cancelled but child continues working
- Missing exhaustive switch/case handling (especially with enums/constants)
- Boundary values: 0, -1, MAX_INT, empty string, Unicode edge cases
- Unit mismatches (bytes vs megabytes, seconds vs milliseconds)

Changes to review:
<paste diff here>
```

**Agent 3: review-design** — Architecture, spec compliance, performance, maintainability
```
Review these changes for design and architecture issues. Be specific — cite file:line.

Spec context: <paste spec status if active>

Focus areas (LLM blind spots — check these explicitly):
- Scope violations: changes outside what the spec requires
- Decision contradictions: reverting or ignoring recorded decisions
- Removing safeguards (size limits, rate limits, validation) without documented reason
- Breaking API/interface contracts that downstream consumers depend on
- N+1 query patterns (DB queries inside loops)
- Unbounded collection growth (maps/slices that only grow, never shrink)
- Missing LIMIT clauses on database queries
- Synchronous blocking where async is appropriate
- Implicit coupling between modules that aren't directly imported
- Inconsistent error handling patterns across the codebase
- Reintroduced patterns that were previously refactored away
- Over-engineering: unnecessary abstractions for one-time operations
- Missing or misleading comments on non-obvious logic

Changes to review:
<paste diff here>
```

### Phase 3: Aggregation (you do this)

1. Collect findings from all 3 sub-reviewers
2. **Deduplicate**: merge findings that describe the same issue from different angles
3. **Validate**: discard findings that are clearly false positives (e.g., flagging intentional design choices)
4. **Prioritize**: sort by severity (Critical > Warning > Info)
5. **Cap**: maximum 15 findings total (5 per sub-reviewer max)
6. If knowledge or spec tools are relevant, cross-reference findings

## Output Format

```
## Review Summary

Reviewed N files, M lines changed.
Sub-reviewers: security ✓, logic ✓, design ✓

### Critical (must fix)
[SECURITY] file:line — description
  → suggestion

[LOGIC] file:line — description
  → suggestion

### Warning (should review)
[DESIGN] file:line — description
  → suggestion

### Info (good to know)
...

## Verdict
[PASS | PASS WITH WARNINGS | NEEDS FIXES]
N critical, N warnings, N info findings.
```

If a focus area is provided in $ARGUMENTS, pass it to the sub-reviewers.

## Guardrails

- Only report real issues — do NOT pad reviews with trivial comments
- Each sub-reviewer finding must include file:line reference
- Always cite the source: spec decision, knowledge base entry, or language convention
- Never make changes — you are read-only
- If a sub-reviewer returns no issues, that's a good signal — don't invent findings
- If ALL sub-reviewers find nothing: "No issues found. Changes look good."
- Prefer false negatives over false positives — noise erodes trust

## Exit Criteria
- All 3 sub-reviewers completed
- Findings deduplicated and prioritized
- Clear verdict provided
