# alfred Spec-Driven Development Flow

This is the invariant development flow enforced by alfred. All implementation work MUST follow this flow.

## Concept Hierarchy

**Spec > Wave > Task** — immutable.

## Flow

1. **Spec Creation** — `dossier action=init` or `/alfred:brief`
2. **Self-Review** — Review all spec documents (all sizes, including S/D)
   - OK → Request user approval (M/L/XL only; S/D proceed to implementation)
   - NG → Fix and re-review
3. **User Approval** — M/L/XL specs reviewed via `alfred dashboard`
4. **Implementation** — Execute Wave by Wave:
   - Per **Task** completion: tasks.md auto-updated
   - Per **Wave** completion: Commit → Self-review → Knowledge save (`ledger save`)
   - Wave self-review gate blocks next Wave until cleared
5. **Completion** — Final self-review → `dossier action=complete`
