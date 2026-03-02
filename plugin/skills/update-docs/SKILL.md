---
name: update-docs
description: >
  Crawl Claude Code documentation and ingest into the alfred knowledge
  base for semantic search. Updates existing docs and adds new ones.
  Uses changelog-first approach: checks for version changes before crawling.
user-invocable: true
argument-hint: "[--force]"
allowed-tools: WebFetch, WebSearch, mcp__alfred__ingest, mcp__alfred__knowledge
context: fork
agent: general-purpose
---

Documentation updater for the knowledge base (changelog-first).

## Steps

1. **[HOW]** Check current KB freshness:
   - Call knowledge with query="Claude Code changelog latest version" (limit=1)
   - Note the `version` and `freshness_days` from the result
   - If no results, treat as empty KB → go to Step 4 (full crawl)

2. **[HOW]** Fetch latest changelog:
   - WebFetch url="https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md" with prompt="Extract the latest 5 version entries. For each entry return: version number, release date, and a list of changes. Focus on changes to: hooks, skills, plugins, MCP, agents, rules, settings. Return as JSON array."

3. **[WHAT]** Compare versions:
   - If KB version matches latest changelog version AND freshness < 7 days:
     → Report "Knowledge base is up to date (vX.Y.Z, N days old)" and STOP
   - If $ARGUMENTS contains "--force": skip this check, go to Step 4
   - Otherwise: identify which doc pages are affected by the changelog diff

4. **[HOW]** Fetch and ingest documentation:
   - **If diff-based (from Step 3)**: Only fetch pages mentioned in or affected by the changelog changes. Map changelog topics to doc URLs:
     - hooks changes → https://code.claude.com/docs/en/hooks
     - skills changes → https://code.claude.com/docs/en/skills
     - plugin changes → https://code.claude.com/docs/en/plugins-reference
     - MCP changes → https://code.claude.com/docs/en/mcp
     - settings changes → https://code.claude.com/docs/en/settings
   - **If full crawl** (empty KB or --force):
     - WebFetch url="https://code.claude.com/docs/llms.txt" to get the full docs index
     - Fetch each page and split into sections by h2/h3 headings
   - For each page: WebFetch with prompt="Split content into sections by h2/h3 headings. Return as JSON array of {path, content} objects where path is 'Page Title > Section Heading'. Omit navigation and boilerplate."
   - Call ingest with url, sections, source_type="docs"

5. **[HOW]** Ingest changelog entries:
   - Split new changelog versions into sections
   - Call ingest with source_type="changelog", version=<version number>

6. **[WHAT]** Verify: Call knowledge with a test query related to the updated content to confirm ingestion worked

## Guardrails

- Do NOT crawl all pages unless KB is empty or --force is specified
- Do NOT ingest sections > 2000 chars (split further)
- Do NOT stop on individual page failures — skip and continue
- Do NOT ingest navigation, footer, or boilerplate content
- Do NOT make WebFetch calls if Step 3 determines KB is up to date
