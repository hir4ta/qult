---
name: review
description: >
  Knowledge-powered code review. Checks changes against active spec (decisions, scope)
  and best practices from the knowledge base.
  Use when: (1) before committing, (2) after a milestone, (3) want a second opinion on changes.
user-invocable: true
argument-hint: "[focus area]"
allowed-tools: Read, Glob, Grep, Bash, mcp__alfred__knowledge, mcp__alfred__spec
context: fork
---

# /alfred:review — Knowledge-Powered Code Review

Review changes against specs and best practices from the knowledge base.

## Key Principles
- Surface **actionable** findings, not noise. Every finding should help the developer.
- Prioritize critical issues (scope violations, decision contradictions) over style.
- Reference sources so the developer can verify and learn.

## Steps

1. **[CONTEXT]** Gather review context:
   - Call `spec` with action=status to check if an active spec exists
   - Read the git diff (`git diff --cached` or `git diff` or `git diff HEAD~3..HEAD`)
   - If a focus area is provided in $ARGUMENTS, use it to guide the review

2. **[SPEC CHECK]** If an active spec exists:
   - Read decisions.md — check if changes contradict recorded decisions
   - Read requirements.md — check if changes fall outside defined scope
   - Flag scope violations as critical, decision conflicts as warnings

3. **[KNOWLEDGE CHECK]** Search for relevant best practices:
   - Call `knowledge` with queries derived from the diff (changed file types, patterns)
   - Compare findings against the actual changes
   - Flag deviations from best practices as info/warnings

4. **[OUTPUT]** Present findings organized by severity:

   **Critical** — Must fix before committing:
   - Out-of-scope changes detected
   - Contradicts a recorded decision

   **Warning** — Should review:
   - Related decisions exist that may be affected
   - Best practice deviation detected

   **Info** — Good to know:
   - Related best practices and documentation

5. **[SUMMARY]** End with:
   - Total findings by severity
   - Recommended actions (if any critical/warning findings)
   - If no findings: "Changes look good. No issues found against spec or best practices."

## Exit Criteria
- Spec checked (if active)
- Knowledge base consulted
- Findings presented with sources
- Clear recommendation provided
