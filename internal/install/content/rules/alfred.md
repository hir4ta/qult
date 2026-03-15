---
description: alfred MCP tool usage guidelines — when and how to call knowledge and config-review
---

# alfred MCP Tools

alfred's knowledge base contains extensive curated Claude Code docs and best practices with vector search.

## knowledge — Search docs and best practices

**ALWAYS call knowledge BEFORE** answering questions about Claude Code. Do not guess or rely on training data.

Call when the user's question or task involves ANY of:
- Hooks, skills, rules, agents, plugins, MCP servers, CLAUDE.md, memory
- Permissions, settings, compaction, CLI features, IDE integrations
- Best practices for Claude Code configuration or workflow
- Evaluating whether code follows Claude Code conventions

Do NOT call for: general programming, project-specific code, non-Claude-Code topics.

## config-review — Audit .claude/ config against best practices

Call when:
- Reviewing or auditing `.claude/` configuration
- Evaluating CLAUDE.md quality or looking for improvements
- Checking overall Claude Code setup health

Cross-references file contents with the knowledge base for targeted suggestions.
