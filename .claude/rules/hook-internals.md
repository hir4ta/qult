---
paths:
  - "src/hooks/**"
---

# Hook Internals

## Timeouts

### Command Hooks

| Event | Timeout | Internal | Rationale |
|---|---|---|---|
| SessionStart | 5s | 4.5s | Knowledge sync + spec context injection + adaptive onboarding |
| PreCompact | 10s | 9s | Chapter memory snapshot + auto-complete + breadcrumb |
| PostToolUse | 5s | 4.5s | Living Spec auto-append + drift detection + wave completion |
| UserPromptSubmit | 10s | 9s | Voyage knowledge search + spec guard |
| PreToolUse | 5s | 4.5s | _active.json read + spec approval check (filesystem only, no DB/API) |
| Stop | 5s | 4.5s | tasks.json check + self-review check + spec completion |
| embed-async | 30s | — | Voyage API with 2x exponential backoff (background) |
| embed-doc | 30s | — | Voyage API with 2x exponential backoff (background) |

### Agent Hooks (並列実行、command hook と独立)

| Event | Type | Timeout | Model | Rationale |
|---|---|---|---|---|
| PreCompact | agent | 60s | Haiku | 意思決定抽出（transcript Read + Bash save-decision） |


