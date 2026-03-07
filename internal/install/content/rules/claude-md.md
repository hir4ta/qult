---
paths:
  - "**/CLAUDE.md"
---

# CLAUDE.md Best Practices

CLAUDE.md is the primary instruction file for Claude Code. It's loaded into every conversation.

## Structure
- Keep it concise — every line consumes context window
- Use headers and bullet points for scannability
- Put the most important instructions first
- Use `## Commands` section for build/test/run commands
- Use `## Rules` section for coding conventions

## Content Guidelines
- Include: build commands, test commands, coding style, project structure
- Avoid: long explanations, documentation that belongs elsewhere
- Commands should be copy-pasteable (absolute paths or clear context)
- Rules should be actionable ("use X" not "consider using X")

## Common Patterns
- `## Stack` — language, framework, key dependencies
- `## Commands` — build, test, lint, run commands
- `## Structure` — directory layout table
- `## Rules` — coding conventions, do/don't lists

## Anti-patterns
- Don't duplicate README content
- Don't include environment-specific paths
- Don't add rules that contradict language conventions
- Don't make it longer than ~200 lines (context cost)
