---
paths:
  - "**/.claude/memory/**"
  - "**/MEMORY.md"
---

# Memory Best Practices

Memory files persist information across Claude Code conversations.

## MEMORY.md
- Located at project root or in `.claude/memory/`
- Automatically loaded into every conversation
- Lines after ~200 are truncated — keep it concise
- Use for: stable patterns, user preferences, key decisions

## .claude/memory/ Directory
- Create topic-specific files (e.g., `debugging.md`, `architecture.md`)
- Link to them from MEMORY.md for organization
- Files persist across conversations but are not auto-loaded (must be read explicitly)

## What to Store
- Confirmed patterns and conventions (verified across multiple interactions)
- Architectural decisions with rationale
- User workflow preferences
- Solutions to recurring problems

## What NOT to Store
- Session-specific context (current task, in-progress work)
- Unverified or speculative conclusions
- Information that duplicates CLAUDE.md
- Sensitive data (credentials, API keys)

## Tips
- Update memories when they become outdated
- Check for existing entries before creating duplicates
- Keep MEMORY.md under 200 lines
- Use separate files for detailed notes, link from MEMORY.md
