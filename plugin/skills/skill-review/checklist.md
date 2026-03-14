# Skill Review Baseline Checklist

Source: "The Complete Guide to Building Skills for Claude" (Anthropic, January 2026)
PDF: https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf
Blog: https://claude.com/blog/complete-guide-to-building-skills-for-claude

**IMPORTANT:** This checklist is a baseline. Before each review, call `knowledge`
to fetch the latest guidance. If newer rules exist, they take precedence.

## A. Frontmatter Compliance

### A1: name field — kebab-case only
- No spaces: `Notion Project Setup` -> NG
- No underscores: `notion_project_setup` -> NG
- No capitals: `NotionProjectSetup` -> NG
- Correct: `notion-project-setup`
- Should match folder name

### A2: description field — required
- MUST include both WHAT and WHEN
- Structure: `[What it does] + [When to use it] + [Key capabilities]`

### A3: No XML angle brackets in frontmatter
- `<` and `>` are FORBIDDEN in ANY frontmatter field
- Reason: frontmatter is injected into Claude's system prompt; malicious content could inject instructions
- Common violation: `argument-hint: "<task-slug>"` -> use `"task-slug"` instead
- Note: YAML `>` (folded scalar indicator) is NOT an angle bracket violation

### A4: Reserved name prefixes
- Names starting with "claude" or "anthropic" are reserved
- Applies to the `name` field in frontmatter

## B. Description Quality

### B1: Includes WHAT
Good: "Analyzes Figma design files and generates developer handoff documentation"
Bad: "Helps with projects"

### B2: Includes WHEN (trigger conditions)
Good: "Use when user uploads .fig files, asks for 'design specs', or 'design-to-code handoff'"
Bad: (no trigger phrases at all)

### B3: Under 1024 characters
- Claude Code truncates descriptions longer than 1024 characters
- Aim for 100-300 characters for clarity

### B4: Specific and actionable
Red flags:
- "Helps with..." (too vague)
- Pure technical language with no user-facing triggers
- No mention of file types when relevant

## C. Structure

### C1: Filename must be exactly SKILL.md
- Case-sensitive: `SKILL.MD`, `skill.md`, `Skill.md` all fail
- Verify with: `ls -la` in skill folder

### C2: Folder name is kebab-case
- Same rules as A1 but for the containing directory

### C3: SKILL.md under 500 lines
- Move detailed docs to `references/`
- Keep SKILL.md under 5,000 words
- Link to supporting files instead of inline

### C4: No README.md inside skill folder
- All documentation goes in SKILL.md or references/
- Exception: repo-level README for GitHub distribution is separate from the skill folder

## D. Progressive Disclosure

### D1: Large skills use supporting files
- If SKILL.md > 200 lines, consider splitting:
  - `references/` for detailed documentation
  - `scripts/` for validation/executable code
  - `examples/` for example outputs
  - `assets/` for templates, fonts, icons

### D2: Supporting files referenced from SKILL.md
- Use relative links: `[api-guide](references/api-guide.md)`
- Claude won't discover files it doesn't know about

### D3: SKILL.md focused on core instructions
- Frontmatter + core workflow steps
- Detailed API docs, schemas etc. in references/

## E. Best Practices

### E1: Specific and actionable instructions
Good: `Run python scripts/validate.py --input {filename} to check data format`
Bad: `Validate the data before proceeding`

### E2: Error handling included
- Common failure modes documented
- Recovery steps for each error
- MCP connection troubleshooting if applicable

### E3: Examples for complex workflows
- At least one "Example 1: [common scenario]" section
- Show: user says X -> actions -> result

### E4: Negative triggers (anti-over-firing)
- "Do NOT use for simple data exploration (use data-viz skill instead)"
- Differentiate from similar skills
- Clarify scope boundaries

## F. Security

### F1: allowed-tools restricts access
- Least privilege: only grant tools the skill actually needs
- Use full MCP tool names: `mcp__server-name__tool-name`

### F2: No embedded secrets
- No API keys, tokens, passwords in skill content
- Use environment variables or MCP server configuration instead

## Scoring

| Severity | Points per pass | Impact |
|---|---|---|
| CRITICAL | gate | Any failure = must fix |
| HIGH | 2 | Significant quality impact |
| MEDIUM | 1 | Noticeable improvement |
| LOW | 0.5 | Nice to have |

Maximum score: depends on applicable checks (skip N/A items)

## Related Resources

- Official skills docs: https://code.claude.com/docs/en/skills
- Skills API quickstart: https://code.claude.com/docs/en/skills-api-quickstart
- Example skills: https://github.com/anthropics/skills
- Agent Skills open standard: https://agentskills.io
- Anthropic course: https://anthropic.skilljar.com/introduction-to-agent-skills
