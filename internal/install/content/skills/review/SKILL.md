---
name: review
description: >
  Knowledge-powered code review with multi-agent architecture. Spawns 3 specialized
  sub-reviewers (security, logic, design) in parallel for thorough coverage, then
  aggregates findings. Use when: (1) before committing, (2) after a milestone,
  (3) want a second opinion on changes.
user-invocable: true
argument-hint: "[focus area]"
allowed-tools: Read, Glob, Grep, Agent, Bash(git diff:*, git log:*, git show:*, git status:*), mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__spec
context: fork
---

# /alfred:review — Multi-Agent Code Review

Review changes using the same multi-agent architecture defined in the `code-reviewer` agent.
Follow the code-reviewer agent's review process (context gathering, 3 parallel sub-reviewers,
aggregation, output format, and guardrails) exactly as documented there.

## Steps

1. **Read the code-reviewer agent definition** to get the full review protocol
   (review dimensions, LLM blind spot checklists, output format, guardrails).
   Try these paths in order: `.claude/agents/code-reviewer.md`, then search with
   `Glob("**/agents/code-reviewer.md")` to find it in plugin cache.
   If the file cannot be found, proceed with general review expertise — each
   sub-reviewer should apply their domain knowledge without the structured checklist.
2. **Context Gathering**: Call `spec` (action=status), run `git diff`, `git log`
3. **Parallel Review**: Spawn 3 sub-reviewer agents as specified in the code-reviewer protocol
4. **Aggregation**: Deduplicate, validate, prioritize, cap at 15 findings
5. **Spec/Knowledge Check**: Cross-reference with spec decisions and knowledge base
6. **Output**: Present unified report using the code-reviewer's output format

If a focus area is provided in $ARGUMENTS, pass it to the sub-reviewers.

## Exit Criteria
- All 3 sub-reviewers completed
- Findings deduplicated and prioritized
- Clear verdict provided
