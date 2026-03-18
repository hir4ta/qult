# Implementation Discipline

## Spec-First Rule

Before writing ANY implementation code (new features, bug fixes, refactors):
1. Check if an active spec exists via `dossier action=status`
2. If no spec → create one via `/alfred:brief` or `dossier action=init` (minimum S size)
3. Never skip this step — even for "small" changes

## Wave Self-Review Rule

After completing each Wave in tasks.md:
1. MUST run a self-review (delegate to `alfred:code-reviewer` agent or `/alfred:inspect`)
2. Fix all Critical and Warning findings before proceeding to next Wave
3. Update session.md with review results

## Commit Discipline

- Commit at Wave boundaries, not mid-Wave
- Include Wave number in commit message (e.g., `feat: jarvis-enforcement Wave 1 — approval gate + directives`)
