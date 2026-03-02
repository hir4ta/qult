---
name: harvest
description: >
  Manually refresh the alfred knowledge base. Normally auto-harvest keeps
  docs fresh automatically — use this for forced full crawl or targeted
  page updates.
user-invocable: true
argument-hint: "[--force | page-topic]"
allowed-tools: WebFetch, WebSearch, mcp__alfred__ingest, mcp__alfred__knowledge
context: fork
agent: general-purpose
---

The butler's procurement run — gathering the finest ingredients for the knowledge base.

## Steps

1. **[HOW]** Check current KB freshness:
   - Call `knowledge` with query="Claude Code changelog latest version" (limit=1)
   - Note the `version` and `freshness_days` from the result
   - If no results, treat as empty KB → go to Step 4 (full crawl)

2. **[HOW]** Fetch latest changelog:
   - WebFetch url="https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md" with prompt="Extract the latest 5 version entries. For each entry return: version number, release date, and a list of changes. Focus on changes to: hooks, skills, plugins, MCP, agents, rules, settings. Return as JSON array."

3. **[WHAT]** Determine action:
   - If $ARGUMENTS contains "--force": skip freshness check, go to Step 4 (full crawl)
   - If $ARGUMENTS contains a page topic (e.g., "hooks"): go to Step 5 (targeted)
   - If KB version matches latest AND freshness < 7 days:
     → Report "Knowledge base is up to date (vX.Y.Z, N days old)" and STOP
   - Otherwise: identify affected doc pages from changelog diff

4. **[HOW]** Full crawl (empty KB, --force, or major version jump):
   - WebFetch url="https://code.claude.com/docs/llms.txt" to get full docs index
   - Fetch each page and split into sections by h2/h3 headings
   - For each page: WebFetch with prompt="Split content into sections by h2/h3 headings. Return as JSON array of {path, content} objects where path is 'Page Title > Section Heading'. Omit navigation and boilerplate."
   - Call `ingest` with url, sections, source_type="docs"
   - Go to Step 6

5. **[HOW]** Targeted update (specific page or changelog-diff):
   - Map topics to doc URLs:
     - hooks → https://code.claude.com/docs/en/hooks
     - skills → https://code.claude.com/docs/en/skills
     - plugins → https://code.claude.com/docs/en/plugins-reference
     - mcp → https://code.claude.com/docs/en/mcp
     - settings → https://code.claude.com/docs/en/settings
     - agents → https://code.claude.com/docs/en/agents
     - rules → https://code.claude.com/docs/en/rules
     - memory → https://code.claude.com/docs/en/memory
   - Fetch only affected pages, split into sections, ingest

6. **[HOW]** Ingest changelog entries:
   - Split new changelog versions into sections
   - Call `ingest` with source_type="changelog", version=<version number>

7. **[WHAT]** Verify:
   - Call `knowledge` with a test query related to the updated content
   - Report summary: "Updated N pages, ingested changelog vX.Y.Z"

## Guardrails

- Do NOT crawl all pages unless KB is empty or --force is specified
- Do NOT ingest sections > 2000 chars (split further)
- Do NOT stop on individual page failures — skip and continue
- Do NOT ingest navigation, footer, or boilerplate content
- Do NOT make WebFetch calls if Step 3 determines KB is up to date
