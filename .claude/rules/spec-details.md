---
description: Spec management internals — sizes, types, templates, validation, confidence
paths:
  - "src/spec/**"
  - ".alfred/specs/**"
---

# Spec Details

## Slug & Lifecycle
- task_slug: `^[a-z0-9][a-z0-9\-]{0,63}$`; spec.ValidSlug exported regex
- Task lifecycle: active → complete (preserves spec files, sets completed_at) or delete (removes files)
- ActiveTask fields: slug, started_at, status (active/completed), completed_at, review_status (pending/approved/changes_requested), size (S/M/L/XL), spec_type (feature/bugfix)
- Spec file locking: advisory flock on `.lock` file (exponential backoff 100/200/400/800ms ~1.5s total, context-aware cancellation, graceful fallback + stderr warning)
- Spec version history: `.history/` dir with max 20 versions per file; rollback saves current first

## Size & Type System
- SpecSize: S (3 files), M (4-5 files), L/XL (7 files), D (2 files: delta.md + session.md)
- Auto-detected from description length (< 100 → S, < 300 → M, else L); D and XL are manual-only
- SpecType: feature (default, uses requirements.md), bugfix (uses bugfix.md), delta (uses delta.md) — orthogonal to size; delta auto-set when size=D
- FilesForSize(size, specType): returns file list for any (size, type) combination
- Init functional options: WithSize(SpecSize), WithSpecType(SpecType); InitWithResult returns SpecDir + Size + SpecType + Files
- Backward compat: legacy _active.md without size/spec_type defaults to L/feature; EffectiveSize()/EffectiveSpecType() helpers

## Spec Files
- Spec v3: 6 files (requirements, design, tasks, test-specs, research, session); decisions.md removed — decisions saved via `ledger save sub_type=decision` directly
- Spec cross-references: `@spec:task-slug/file.md` format parsed by `spec.ParseRefs()`, resolved against filesystem
- Spec complete auto-extracts: design.md patterns → permanent knowledge (sub_type=pattern)
- Wave: Closing required in all tasks.md: self-review, CLAUDE.md update, test verification, knowledge save

## Templates
- Spec templates: `src/spec/templates.ts` — inline EN/JA templates rendered via `renderForSize()` (TemplateData: TaskSlug, Description, Date, SpecType)
- Supported file templates: requirements.md, bugfix.md, delta.md, design.md, tasks.md, test-specs.md, research.md, session.md
- Bugfix template: Bug Summary, Severity & Impact P0-P3, Reproduction Steps, Root Cause Analysis with 5 Whys, Fix Strategy, Regression Prevention
- Delta template: Change Summary, Files Affected with CHG-N IDs, Before/After per CHG-N, Rationale, Impact Scope, Test Plan, Rollback Strategy
- Template 2-layer resolution (planned): `.alfred/templates/specs/` (user override) > embedded defaults

## Traceability
- EARS notation: requirements use 6 patterns (Ubiquitous, WHEN, WHILE, WHERE, IF-THEN, Complex)
- Traceability IDs: FR-N (functional), NFR-N (non-functional), DEC-N (decisions), T-N.N (tasks wave.task), TS-N.N (tests)
- Traceability matrix: design.md maps Req ID → Component → Task ID → Test ID
- CHG-N: delta spec change identifiers (logical change unit, scoped per change not per file)

## Confidence & Grounding
- Spec confidence scoring: `<!-- confidence: N | source: TYPE | grounding: LEVEL -->` annotations
- Source: user/design-doc/code/inference/assumption; Grounding: verified/reviewed/inferred/speculative (optional, backward compatible)
- Status returns avg + low_items + low_confidence_warnings (score <= 5 + assumption) + grounding_distribution + grounding_warnings
- Grounding levels: verified (code/test proven) > reviewed (design-reviewed/user-confirmed) > inferred (reasoned from evidence) > speculative (hypothesis)

## Validation (dossier validate)
- 21 checks: required_sections, min_fr_count (S:1+, M:3+, L:5+, XL:8+; bugfix uses substantive content check), traceability (fr_to_task, task_to_fr), confidence_annotations, closing_wave, design_fr_references, testspec_fr_references, nfr_traceability (L/XL only), gherkin_syntax, orphan_tests, orphan_tasks, content_placeholder, research_completeness (L/XL only), confidence_coverage (XL only), xl_wave_count (>=4, XL only), xl_nfr_required (XL only), delta_sections_present (D only), grounding_coverage (opt-in: L/XL or D, >30% speculative fails), delta_change_ids (D only), delta_before_after (D only). decisions_completeness removed (decisions saved via ledger directly)

## Approval Gate
- complete action: M/L/XL specs require review_status="approved" AND approved review JSON file in reviews/ directory (S/D exempt)
- Fail-closed: YAML parse errors reject completion. Manual _active.md editing cannot bypass the gate
- Review data: .alfred/specs/{slug}/reviews/review-{timestamp}.json
- ReviewComment: file, line (1-based), body, resolved
- Review status: pending → approved or changes_requested (stored in _active.md review_status)
