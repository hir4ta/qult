---
paths:
  - "src/hooks/**"
---

# Hook Behavior

## SessionStart
- Knowledge sync + spec context injection (knowledge dir walk + adaptive onboarding)
- Adaptive onboarding: injection depth by project knowledge count (0-5: full spec, 6-20: session+goal, 21+: session only)
- Suggests `ledger action=reflect` when 20+ knowledge entries exist and last reflect >7 days ago
- Suggests `/alfred:init` if steering docs are missing

## PreCompact
- Auto-updates Next Steps completion status from transcript
- Decision extraction: base score 0.35, min confidence 0.4 — bare keyword matches require at least one positive signal (rationale/alternative/arch term)
- Structured chapter memory (JSON): goal, decisions, summary
- Epic progress auto-sync
- Knowledge detection: transcript research patterns (2+ hits from 13 keywords) → stderr reminder to save findings
- Auto-completes task when tasks.md Status="completed"/"done" or all Next Steps are checked
- Suggests updating steering docs when architecture-related decisions detected
- Session continuity: writes .alfred/.pending-compact.json breadcrumb, SessionStart resolves → session_links table

## UserPromptSubmit
- Voyage vector search → FTS5 fallback → keyword fallback
- File context boost from git diff
- Skill nudge: classifyIntent (7 intents: research/plan/implement/bugfix/review/tdd/save-knowledge, JP+EN bilingual phrase keywords) → buildSkillNudge (intent→skill routing with active spec suppression for plan/implement) → additionalContext injection
- save-knowledge suppresses research when both match. No API calls (pure keyword matching, <1ms)
- Parallel dev guard (Stage 1.5): active spec exists + implement/bugfix/tdd intent + slug NOT in worked-slugs → WARNING prompting AskUserQuestion to confirm same task or new task. Suppressed once user edits files for the spec (slug added to worked-slugs via PostToolUse). Fires after Stage 1 (no spec → DIRECTIVE) and after Stage 2 (M/L/XL unapproved → DIRECTIVE)

## PostToolUse
- Bash error detection → FTS5 knowledge search → additionalContext injection
- Bash success → tasks.md Next Steps auto-check (command + action signals matching + file-based matching via git diff)
- Exploration detection: consecutive Read/Grep calls tracked via .alfred/.state/explore-count; at 5+ calls without active spec → survey suggestion. Non-Read/Grep tool resets counter

## PostToolUse — Living Spec (src/hooks/living-spec.ts)
- git commit → extractChangedFiles (git diff --name-only HEAD~1, 2s timeout) → shouldAutoAppend filter (multi-lang: JS/TS/Python/Go/Ruby/Rust/Java/C#/Swift/Kotlin, excludes test/gen/mock/vendor/dist/plugin/.alfred) → matchComponent (exact directory match against design.md component sections) → appendFileToComponent (design.md, `<!-- auto-added: ISO8601 -->` marker) → audit.jsonl (living-spec.update)
- Language config: `src/hooks/lang-filter.ts` — per-language extension + exclusion patterns, shared DIR_EXCLUSIONS
- Timeout warning: stderr notification when git diff times out (design.md not updated for that commit)

## Dossier Hints
- dossier status next_action: contextual hint based on spec state (review_status=pending → dashboard, all steps done → complete, 3+ active tasks without epic → roster init suggestion)
- dossier init suggested_search: always includes ledger search suggestion with description keywords
- dossier init: returns `suggested_knowledge` (related knowledge via vector search + FTS5 fallback, sub_type boosted)

## PreToolUse
- Review gate enforcement: reads `.alfred/.state/review-gate.json`, blocks Edit/Write when gate active + slug matches active spec
- Gate types: `spec-review` (auto-set on dossier init), `wave-review` (set per wave via `dossier action=gate`)
- Enforcement order: .alfred/ exempt → malformed check (empty primary = valid state, not malformed) → review-gate → approval gate (M/L/XL unapproved)
- Gate clear: `dossier action=gate sub_action=clear reason="..."` (reason required, audit logged)
- Spec-first guard: command handler only (prompt-type LLM judge removed in #19). When no active spec and no polish mode, emits stderr advisory warning + `allowTool()`. Enforcement of spec-first rule is via UserPromptSubmit DIRECTIVE (Stage 1), not PreToolUse
- Active spec optimization: command handler calls `allowTool()` when spec exists and all gates pass. This covers: .alfred/ files, deferred/cancelled specs, and active specs with cleared gates

## Stop (review gate + session scope)
- Blocks stopping when review-gate is active (before existing Next Steps / self-review checks)
- Session-scoped reminders: only reminds about specs in worked-slugs. If worked-slugs empty (read-only session), falls back to primary spec
- DEC-4: stop_hook_active=true overrides gate blocking (infinite loop prevention)
- CONTEXT reminders use `systemMessage` (not hookSpecificOutput — Stop schema doesn't support hookEventName)

## Hook Output & Directives
- Hook output: structured directive levels via `emitDirectives()` — [DIRECTIVE] (must comply), [WARNING] (should check), [CONTEXT] (reference). Max 3 DIRECTIVEs per invocation (NFR-5). Single `emitAdditionalContext()` call per hook (NFR-4)
- Directive utility: `src/hooks/directives.ts` — `buildDirectiveOutput()`, `emitDirectives()`
- Directive persuasion: DirectiveItem supports opt-in `rationalizations` (counter-arguments) and `spiritVsLetter` (anti-shortcut sentence). Truncation drops rationalizations first to preserve Spirit vs Letter (NFR-1)
- Semantic intent classification: Voyage embedding similarity (threshold >= 0.5) with keyword fallback. Prompt embedding reused for knowledge search (DEC-2)
- Hook state persistence: `src/hooks/state.ts` — readStateJSON/writeStateJSON/readStateText/writeStateText. Stores session-local state in `.alfred/.state/` (gitignored). Path traversal guard on file names
- Shared spec-guard utilities: `src/hooks/spec-guard.ts` — tryReadActiveSpec, isSpecFilePath, countUncheckedNextSteps, hasUncheckedSelfReview, allowTool, denyTool, blockStop
- Spec-first guard: command handler handles all cases (allowTool/denyTool). Prompt-type LLM judge removed (#19: parallel hook execution causes allow/deny conflicts). No-spec case emits stderr advisory + allowTool; enforcement is via UserPromptSubmit DIRECTIVE (Stage 1)
- Validation engine: `src/spec/validate.ts` — 21-check validation for all spec sizes
- Multi-agent skills: inspect (6 profiles), salon (3 specialists + synthesis), brief (requirements+design agent review loop + inline check for others + approval gate), attend (spec→approve→implement→review→commit orchestrator), tdd (red→green→refactor), mend (reproduce→analyze→fix→verify), survey (code→spec reverse engineering), harvest (PR comment → knowledge)
- brief/attend spec generation order: research → requirements → design → tasks → test-specs → session (decisions saved via ledger directly, not as spec file)

## Misc
- Background embedding: embed-async/embed-doc subcommands for async Voyage API calls
- Orphan cleanup: CleanOrphanedEmbeddings runs during PreCompact (not per-insert)
- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds
