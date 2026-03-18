---
description: Hook runtime behavior, event pipelines, and skill nudge logic
paths:
  - "cmd/alfred/hooks*.go"
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
- Auto-completes task when session.md Status="completed"/"done" or all Next Steps are checked
- Suggests updating steering docs when architecture-related decisions detected
- Session continuity: writes .alfred/.pending-compact.json breadcrumb, SessionStart resolves → session_links table

## UserPromptSubmit
- Voyage vector search → FTS5 fallback → keyword fallback
- File context boost from git diff
- Skill nudge: classifyIntent (7 intents: research/plan/implement/bugfix/review/tdd/save-knowledge, JP+EN bilingual phrase keywords) → buildSkillNudge (intent→skill routing with active spec suppression for plan/implement) → additionalContext injection
- save-knowledge suppresses research when both match. No API calls (pure keyword matching, <1ms)

## PostToolUse
- Bash error detection → FTS5 knowledge search → additionalContext injection
- Bash success → session.md Next Steps auto-check (command + action signals matching + file-based matching via git diff)
- Exploration detection: consecutive Read/Grep calls tracked via /tmp counter; at 5+ calls without active spec → survey suggestion. Non-Read/Grep tool resets counter

## PostToolUse — Living Spec (hooks_autoappend.go)
- git commit → extractChangedFiles (shared, called once) → shouldAutoAppend filter (.go only, excludes _test/_gen/.pb/_mock/_string/vendor/plugin/.alfred) → matchComponentByPackage → appendFileToComponent (design.md, flock-protected, `<!-- auto-added: ISO8601 -->` marker) → audit.jsonl (living-spec.update)
- Auto-appended files excluded from drift warnings

## PostToolUse — Drift Detection
- extractChangedFiles (git diff --name-only HEAD~1, 500ms timeout, fail-open) → parseSpecFileRefs (design.md File: + tasks.md Files:) → matchComponentByPackage → reverseMapFileToFR → compare → additionalContext warning + audit.jsonl
- Severity: info (test files), warning (source files not in spec), critical (component-level drift)

## Dossier Hints
- dossier status next_action: contextual hint based on spec state (review_status=pending → dashboard, all steps done → complete, 3+ active tasks without epic → roster init suggestion)
- dossier init suggested_search: always includes ledger search suggestion with description keywords
- dossier init: returns `suggested_knowledge` (related knowledge via vector search + FTS5 fallback, sub_type boosted)

## Misc
- Background embedding: embed-async/embed-doc subcommands for async Voyage API calls
- Orphan cleanup: CleanOrphanedEmbeddings runs during PreCompact (not per-insert)
- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds
