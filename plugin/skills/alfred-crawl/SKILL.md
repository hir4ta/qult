---
name: alfred-crawl
description: >
  Fetch Claude Code documentation and ingest into the alfred knowledge base.
  Crawls code.claude.com/docs, splits pages into sections, and stores them
  via the ingest MCP tool for semantic search.
user-invocable: true
allowed-tools: WebFetch, WebSearch, mcp__claude-alfred__ingest, mcp__claude-alfred__state
context: fork
agent: general-purpose
---

Documentation crawler for the alfred knowledge base.

## Steps

1. Fetch the docs index page:
   - WebFetch url="https://docs.claude.com/en/docs" with prompt="Extract all documentation page URLs from the sidebar navigation. Return as a JSON array of {url, title} objects."

2. For each documentation page:
   - WebFetch the page URL with prompt="Split the page content into sections by h2/h3 headings. Return as a JSON array of {path, content} objects where path is 'Page Title > Section Heading > Subsection' and content is the section text (including code blocks). Omit navigation, footer, and boilerplate."
   - Call ingest with:
     - url: the page URL
     - sections: the array from WebFetch
     - source_type: "docs"

3. Fetch the changelog:
   - WebSearch query="Claude Code changelog site:docs.claude.com"
   - WebFetch the changelog URL with prompt="Split the changelog into version entries. Return as a JSON array of {path, content} objects where path is the version number (e.g. 'v1.0.30') and content is the changes for that version."
   - Call ingest with source_type="changelog"

4. Report summary:
   - Call state with detail="brief" to verify ingested doc count
   - Report: pages crawled, sections ingested, embeddings generated

## Important Notes

- If a page fails to fetch, skip it and continue with the next
- Sections should be self-contained (include relevant context, not just fragments)
- Keep section content under ~2000 chars for effective embedding
- If content hasn't changed (same hash), ingest will skip it automatically
- Re-running this skill updates existing docs and adds new ones
