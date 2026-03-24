---
paths:
  - "src/hooks/**"
---

# Hook Behavior

## SessionStart
- Knowledge sync + spec context injection (knowledge dir walk + adaptive onboarding)
- Adaptive onboarding: injection depth by project knowledge count (0-5: full spec, 6-20: session+goal, 21+: session only)

## PreCompact
- Decision extraction: agent hook (Haiku) が transcript を Read → 意思決定を構造化 → `alfred hook-internal save-decision` で DB 保存（旧キーワードスコアリングは削除済み）
- Structured chapter memory (JSON): tasks.json snapshot
- Auto-completes task when tasks.json all tasks checked
- Session continuity: writes .alfred/.pending-compact.json breadcrumb, SessionStart resolves → session_links table

## UserPromptSubmit
- **Hybrid**: command hook (knowledge search + spec guard) + prompt hook (Haiku intent classification)
- Command hook: Voyage vector search → FTS5 fallback → keyword fallback for knowledge search
- Prompt hook (Haiku): 7 intents (research/plan/implement/bugfix/review/tdd/save-knowledge) を LLM 分類 → skill 推薦を additionalContext で出力
- Spec proposal (Stage 1): no active spec + implementation keywords → DIRECTIVE requiring AskUserQuestion. Guard resets per session
- Parallel dev guard (Stage 1.5): active spec exists + implementation keywords + slug NOT in worked-slugs → WARNING

## PostToolUse
- Bash error detection → FTS5 knowledge search → additionalContext injection
- Task completion: agent hook (Haiku) が Edit/Write/Bash 後にタスク完了候補を additionalContext で提案 → Claude 本体が dossier check を呼ぶ（旧 autoCheckTasks は削除済み）
- Bash success → git commit detection → living-spec + drift + wave completion
- FR-9: Agent レビューレスポンス検出時に review-gate.json の re_reviewed フラグをセット（fix_mode 中のみ）

## PostToolUse — Living Spec (src/hooks/living-spec.ts)
- git commit → extractChangedFiles (git diff --name-only HEAD~1, 2s timeout) → shouldAutoAppend filter (multi-lang: JS/TS/Python/Go/Ruby/Rust/Java/C#/Swift/Kotlin, excludes test/gen/mock/vendor/dist/plugin/.alfred) → matchComponent (exact directory match against design.md component sections) → appendFileToComponent (design.md, `<!-- auto-added: ISO8601 -->` marker)
- Language config: `src/hooks/lang-filter.ts` — per-language extension + exclusion patterns, shared DIR_EXCLUSIONS

## Dossier Hints
- dossier status next_action: contextual hint based on spec state (all steps done → complete)
- dossier init suggested_search: always includes ledger search suggestion with description keywords
- dossier init: returns `suggested_knowledge` (related knowledge via vector search + FTS5 fallback, sub_type boosted)

## PreToolUse
- Review gate enforcement: reads `.alfred/.state/review-gate.json`, blocks Edit/Write when gate active + slug matches active spec
- Gate types: `spec-review` (auto-set on dossier init), `wave-review` (set per wave via `dossier action=gate`)
- Enforcement order: .alfred/ exempt → gate-exempt paths (docs/, .md, .claude/, project-external) → malformed check → review-gate → allow
- Gate clear: `dossier action=gate sub_action=clear reason="..."` (reason required)
- Gate fix mode: `dossier action=gate sub_action=fix reason="..."` — switches gate to `fix_mode: true`, allowing Edit/Write for applying fixes while keeping gate logically active
- Spec-first guard: no active spec → advisory warning + allowTool. Spec proposal is via UserPromptSubmit CONTEXT
- Active spec optimization: command handler calls `allowTool()` when spec exists and all gates pass

## Stop (review gate + session scope)
- Blocks stopping when review-gate is active (before existing Next Steps / self-review checks)
- Session-scoped reminders: only reminds about specs in worked-slugs. If worked-slugs empty (read-only session), falls back to primary spec
- DEC-4: stop_hook_active=true overrides gate blocking (infinite loop prevention)

## Hook Output & Directives
- Hook output: structured directive levels via `emitDirectives()` — [DIRECTIVE] (must comply), [WARNING] (should check), [CONTEXT] (reference). Max 3 DIRECTIVEs per invocation (NFR-5). Single `emitAdditionalContext()` call per hook (NFR-4)
- Directive utility: `src/hooks/directives.ts` — `buildDirectiveOutput()`, `emitDirectives()`
- Semantic intent classification: Voyage embedding similarity (threshold >= 0.5) with keyword fallback. Prompt embedding reused for knowledge search (DEC-2)
- Hook state persistence: `src/hooks/state.ts` — readStateJSON/writeStateJSON. Stores session-local state in `.alfred/.state/` (gitignored). Path traversal guard on file names
- Shared spec-guard utilities: `src/hooks/spec-guard.ts` — tryReadActiveSpec, isSpecFilePath, countUncheckedNextSteps, hasUncheckedSelfReview, allowTool, denyTool, blockStop
- Validation engine: `src/spec/validate.ts` — 21-check validation for all spec sizes
- Multi-agent skills: inspect (6 profiles), brief (requirements+design agent review loop + inline check for others), attend (spec→implement→review→commit orchestrator), tdd (red→green→refactor), mend (reproduce→analyze→fix→verify)
- brief/attend spec generation order: research → requirements → design → tasks → test-specs (decisions saved via ledger directly, not as spec file)

## Misc
- Background embedding: embed-async/embed-doc subcommands for async Voyage API calls
- Orphan cleanup: CleanOrphanedEmbeddings runs during PreCompact (not per-insert)
- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds
