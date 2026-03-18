---
description: Hook timeout constraints and environment variable defaults for alfred
paths:
  - "cmd/alfred/hooks*.go"
---

# Hook Internals

## Timeouts

| Event | Timeout | Internal | Rationale |
|---|---|---|---|
| SessionStart | 5s | 4.5s | Knowledge sync + spec context injection + adaptive onboarding |
| PreCompact | 10s | 9s | Transcript parsing + decision extraction + session.md |
| PostToolUse | 5s | 4.5s | Next Steps auto-check + Living Spec auto-append + drift detection |
| UserPromptSubmit | 10s | 9s | Voyage semantic search (embed + vector search + rerank) |
| PreToolUse | 5s | 4.5s | _active.md read + spec approval check (filesystem only, no DB/API) |
| Stop | 5s | 4.5s | session.md Next Steps check + self-review check + spec completion |
| embed-async | 30s | — | Voyage API with 3x exponential backoff (background) |
| embed-doc | 30s | — | Voyage API with 3x exponential backoff (background) |

