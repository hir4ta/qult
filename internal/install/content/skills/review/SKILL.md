---
name: review
description: >
  3-layer knowledge-powered code review. Checks changes against active spec (decisions, scope),
  semantic knowledge search, and best practices from documentation.
  Use when: (1) before committing, (2) after a milestone, (3) want a second opinion on changes.
user-invocable: true
argument-hint: "[focus area]"
allowed-tools: Read, Glob, Grep, Bash, mcp__alfred__code-review, mcp__alfred__spec-status
context: fork
---

# /alfred:review — Knowledge-Powered Code Review

A 3-layer review that goes beyond linting — checking your changes against specs, accumulated knowledge, and best practices.

## Key Principles
- Surface **actionable** findings, not noise. Every finding should help the developer.
- Prioritize critical issues (scope violations, decision contradictions) over style.
- Reference sources so the developer can verify and learn.

## Steps

1. **[CONTEXT]** Gather review context:
   - Call `spec-status` to check if an active spec exists
   - If a focus area is provided in $ARGUMENTS, pass it to the review

2. **[REVIEW]** Call `code-review` with project_path and optional focus:
   - Layer 1 (Spec): checks changes against decisions.md and requirements scope
   - Layer 2 (Knowledge): semantic search for related knowledge across all sources
   - Layer 3 (Best Practices): FTS search for relevant documentation

3. **[OUTPUT]** Present findings organized by severity:

   **Critical** — Must fix before committing:
   - Out-of-scope changes detected
   - Contradicts a recorded decision

   **Warning** — Should review:
   - Related decisions exist that may be affected
   - Knowledge base has relevant context

   **Info** — Good to know:
   - Related best practices and documentation
   - Knowledge base matches for reference

4. **[SUMMARY]** End with:
   - Total findings by severity
   - Recommended actions (if any critical/warning findings)
   - If no findings: "Changes look good. No issues found against spec, knowledge, or best practices."

## Output Format

```
## Code Review: {focus or "all changes"}

### Critical ({n})
- [spec] {message} — {source}

### Warning ({n})
- [spec] {message} — {source}

### Info ({n})
- [knowledge] {message} — {source}
- [best_practice] {message} — {source}

---
{n} findings total. {recommendation}
```

## Exit Criteria
- All 3 layers checked
- Findings presented with sources
- Clear recommendation provided
