---
name: harvest
description: >
  Extract knowledge from GitHub PR review comments. Given a PR URL, fetches
  review comments via gh CLI, extracts decisions and patterns, and saves them
  as permanent memories via ledger. Use when wanting to capture PR review
  insights for future recall. NOT for code review (use /alfred:inspect).
  NOT for creating PRs (use /create-pr).
user-invocable: true
argument-hint: "<PR-URL>"
allowed-tools: Bash(gh api *, gh pr view *), mcp__plugin_alfred_alfred__ledger
context: fork
---

# /alfred:harvest — PR Knowledge Extractor

Extract decisions, patterns, and insights from GitHub PR review comments
and save them as permanent memories.

## Steps

### 1. Parse PR URL

Extract owner, repo, and PR number from `$ARGUMENTS`.
Supported formats:
- `https://github.com/owner/repo/pull/123`
- `owner/repo#123`
- `#123` (assumes current repo)

### 2. Fetch PR Data

```bash
gh pr view <number> --json title,body,reviews,comments,files
gh api repos/<owner>/<repo>/pulls/<number>/comments
```

### 3. Extract Knowledge

From review comments, identify:
- **Decisions**: "Let's use X instead of Y because..."
- **Patterns**: "This pattern is better for..." / "Always do X when..."
- **Warnings**: "Don't do X because..." / "This caused issues when..."
- **Architecture**: Changes to interfaces, APIs, or data models

For each extracted item, classify as:
- `decision`: A technical choice with rationale
- `pattern`: A repeatable practice
- `warning`: Something to avoid

### 4. Save to Memory

For each extracted item, call `ledger` with action=save:
- **label**: `PR#<number>: <short description>`
- **content**: Structured record:
  ```
  PR: <title> (#<number>)
  Type: decision|pattern|warning
  Context: <file path if applicable>
  Insight: <the extracted knowledge>
  Source: <reviewer name>
  ```
- **project**: Current project name

### 5. Output Summary

```
Harvested PR #<number>: <title>
  Decisions: N
  Patterns: N
  Warnings: N
  Total memories saved: N
```

## Example

```
/alfred:harvest https://github.com/hir4ta/claude-alfred/pull/42

Harvested PR #42: Add FTS5 full-text search
  Decisions: 2
    - Use bm25 ranking over tf-idf (performance on small corpora)
    - Keep LIKE fallback for FTS5 failure (graceful degradation)
  Patterns: 1
    - FTS5 trigger sync pattern for content tables
  Warnings: 1
    - Don't use FTS5 tokenize=porter for CJK text
  Total memories saved: 4
```

## Guardrails

- NEVER modify code — this is a read-only knowledge extraction skill
- ALWAYS verify the PR exists before parsing (gh pr view)
- ALWAYS include the PR number and title in saved memories for traceability
- Skip comments that are just style nits or formatting suggestions
- Focus on comments with rationale ("because", "since", "to avoid")
