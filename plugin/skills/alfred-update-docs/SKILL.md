---
name: alfred-update-docs
description: >
  Crawl Claude Code documentation and ingest into the alfred knowledge
  base for semantic search. Updates existing docs and adds new ones.
user-invocable: true
allowed-tools: WebFetch, WebSearch, mcp__claude-alfred__ingest, mcp__claude-alfred__knowledge
context: fork
agent: general-purpose
---

Documentation crawler for the knowledge base.

## Steps

1. **[HOW]** Fetch the docs index page:
   - WebFetch url="https://docs.claude.com/en/docs" with prompt="Extract all documentation page URLs from the sidebar navigation. Return as a JSON array of {url, title} objects."

2. **[HOW]** For each documentation page:
   - WebFetch the page URL with prompt="Split the page content into sections by h2/h3 headings. Return as a JSON array of {path, content} objects where path is 'Page Title > Section Heading' and content is the section text. Omit navigation and boilerplate."
   - Call ingest with url, sections, source_type="docs"

3. **[HOW]** Fetch the changelog:
   - WebSearch query="Claude Code changelog site:docs.claude.com"
   - WebFetch and split into version entries
   - Call ingest with source_type="changelog"

4. **[WHAT]** Verify: Call knowledge with a test query to confirm ingestion worked

## Guardrails

- Do NOT ingest sections > 2000 chars (split further)
- Do NOT stop on individual page failures — skip and continue
- Do NOT ingest navigation, footer, or boilerplate content
