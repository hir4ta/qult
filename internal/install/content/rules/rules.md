---
paths:
  - "**/.claude/rules/**"
---

# Rules Best Practices

Rules are markdown files that inject instructions based on file path matching.

## Rule File Format (.md in .claude/rules/)
```markdown
---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Rules

Always use describe/it blocks...
```

## Key Concepts
- `paths` — glob patterns that trigger this rule
- Rules are injected when Claude reads/edits matching files
- Multiple rules can activate simultaneously
- Rules without `paths` apply globally (like mini CLAUDE.md)

## Tips
- Use rules for file-type-specific conventions (test style, component patterns)
- Keep rules concise — they're injected into context on every match
- Use glob patterns effectively: `**/*.go` for all Go files, `src/api/**` for API code
- Global rules (no paths) are good for team-wide conventions
- Don't duplicate CLAUDE.md content in rules
