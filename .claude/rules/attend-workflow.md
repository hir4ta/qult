---
paths:
  - ".alfred/**"
  - "src/spec/**"
---

# attend Workflow — Required Practices

These rules apply when executing /alfred:attend or any spec-driven workflow.

## Spec Approval

- Spec approval MUST happen through `alfred dashboard` (browser review mode)
- Text-based approval ("承認します", "approved", etc.) is NOT valid
- The approval gate verifies both _active.md review_status AND review JSON file existence
- Do NOT manually edit _active.md to set review_status — this will be rejected

## Knowledge Tool Usage

- Before making technology or library decisions (bubbletea, lipgloss, etc.), call the `knowledge` MCP tool to check documentation and best practices
- Do NOT rely on training data for Claude Code features — always search knowledge first
- This applies to: framework patterns, API usage, configuration formats, hook behavior

## Code Review

- Use `/alfred:inspect` for comprehensive review (6 profiles: code, config, security, docs, architecture, testing)
- `alfred:code-reviewer` agent is acceptable for per-task review during implementation
- Final review SHOULD use `/alfred:inspect` for broader coverage

## Dashboard Verification

- After implementation, run `alfred dashboard` to visually verify changes
- The manual test checklist in T-4.2 (or equivalent) MUST be executed — do not skip
- Report any visual issues found during dashboard verification

## Test Tasks

- Test tasks (T-4.x, T-C.3) are NOT optional — do not skip them
- `go test ./...` and `go vet ./...` must pass before committing
- New features require new test cases — "will add tests later" is not acceptable

## Session Progress

- Update session.md after EACH task completion (not in batch)
- Record all design decisions via `ledger action=save sub_type=decision` as they are made
- Use `ledger action=save sub_type=pattern` for patterns worth remembering across sessions
