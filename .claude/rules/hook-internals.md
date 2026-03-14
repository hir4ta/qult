---
description: Hook timeout constraints and environment variable defaults for alfred
paths:
  - "cmd/alfred/hooks*.go"
  - "**/hooks/hooks.json"
---

# Hook Internals

## Timeouts

| Event | Timeout | Internal | Rationale |
|---|---|---|---|
| SessionStart | 5s | 4.5s | CLAUDE.md ingestion + spec context + auto-crawl + instinct promotion (4 ops parallel via channels) |
| PreCompact | 10s | 9s | Transcript parsing + decision extraction + session.md |
| UserPromptSubmit | 3s | 2.5s | FTS-only keyword search (no Voyage API) |
| SessionEnd | 3s | 2.5s | Session summary + memory save + instinct extraction, skips on reason=clear |
| embed-async | 30s | — | Voyage API with 3x exponential backoff (background) |
| embed-doc | 30s | — | Voyage API with 3x exponential backoff (background) |
| crawl-async | 5m | — | Live docs crawl + DB upsert + optional embeddings |

## Environment Defaults

| Variable | Default | Scope |
|---|---|---|
| `ALFRED_RELEVANCE_THRESHOLD` | `0.40` | UserPromptSubmit: minimum injection score |
| `ALFRED_HIGH_CONFIDENCE_THRESHOLD` | `0.65` | UserPromptSubmit: threshold for 2-result injection |
| `ALFRED_SINGLE_KEYWORD_DAMPEN` | `0.80` | UserPromptSubmit: single-keyword score multiplier |
| `ALFRED_QUIET` | `0` | Suppress knowledge injection (UserPromptSubmit + SessionStart hints) |
| `ALFRED_CONTEXT_BOOST_DISABLE` | `0` | Disable spec/session context boost in UserPromptSubmit |
| `ALFRED_MEMORY_MAX_AGE_DAYS` | `180` | `alfred memory prune`: default cutoff age |
