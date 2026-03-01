---
name: alfred-audit
description: >
  Quick setup check against Claude Code best practices. Lighter than
  a full review — just checks configuration exists and is well-formed.
user-invocable: true
allowed-tools: Read, Glob, mcp__claude-alfred__review
context: fork
agent: Explore
---

Quick setup audit.

## Steps

1. **[HOW]** Call review with project_path set to the current working directory
2. **[WHAT]** For each configuration item, check:
   - Exists and is non-empty
   - Follows official format (frontmatter present where required)
   - No obvious anti-patterns (e.g., CLAUDE.md > 200 lines, skills without descriptions)

## Output

```
[x] CLAUDE.md (N lines)
[x] Skills (N configured)
[ ] Hooks (not configured — add for automated checks)
...
```

One-line suggestion for each missing item. Keep under 10 lines.

## Guardrails

- Do NOT read file contents for audit — just check existence and basic structure
- Do NOT suggest installing alfred's own features as improvements
