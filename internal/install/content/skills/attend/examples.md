# Usage Examples

## Basic invocation

```
/alfred:attend add-config-option Add a per-project configuration option for custom knowledge sources
```

First argument is the task-slug, the rest is the description.

## Expected flow

```
Phase 0: Initialize
  → AskUserQuestion: "Confirm scope: Add per-project config option for custom knowledge sources. Proceed?"
  → User: "Yes"
  → spec init: add-config-option
  → initial_commit: abc0000

Phase 1: Spec Creation
  → knowledge search: "custom knowledge sources configuration"
  → Spawn: Architect + Devil's Advocate + Researcher (3 agents)
  → Spawn: Mediator (1 agent)
  → Parent writes spec via: dossier action=update (requirements.md, design.md, decisions.md)
  → State: phase=spec-review, agent_spawns_used=4

Phase 2: Spec Review (iteration 1)
  → Spawn: Agent A (Correctness+Testability) + B (Security+Performance) + C (Architecture+Operability)
  → Agent A: {"verdict": "NEEDS_FIXES", "findings": [{"severity": "high", ...}]}
  → Agent B: {"verdict": "PASS", "findings": []}
  → Agent C: {"verdict": "NEEDS_FIXES", "findings": [{"severity": "warning", ...}]}
  → 1 High finding → fix spec → loop
  → State: iteration=1, agent_spawns_used=7

Phase 2: Spec Review (iteration 2)
  → Spawn: 3 agents → All PASS
  → State: phase=impl-phase-1, agent_spawns_used=10

Phase 3+4: Implementation + Review (phase 1)
  → phase_start_commit = abc1234
  → Implement: config struct + JSON parsing
  → git diff abc1234 → spawn 3 review agents → PASS
  → State: agent_spawns_used=13

Phase 3+4: Implementation + Review (phase 2)
  → Implement: CLI integration → review → PASS
  → State: agent_spawns_used=16

Phase 5: Final Self-Review
  → git diff $(git merge-base main HEAD)..HEAD
  → Spawn 4 agents (3 code + 1 integration validator)
  → Integration validator: all requirements covered ✓
  → State: phase=test-gate, agent_spawns_used=20

Phase 6: Test Gate
  → go test ./... → PASS
  → go vet ./... → PASS
  → State: phase=commit

Phase 7: Commit
  → git diff --name-only abc0000..HEAD → filter paths → stage
  → Credential scan on staged diff → clean
  → git commit -m "feat: add-config-option: per-project custom knowledge source configuration"
  → State: phase=done

Output:
  ✓ Task add-config-option completed.
  Spec: .alfred/specs/add-config-option/
  Commit: def5678
  Review: 2 spec iterations, 0 impl iterations, final PASS
  Agent spawns: 20/20
```

## BLOCKED example (security)

```
Phase 4: Per-Phase Review (iteration 2)
  → Agent B: {"severity": "critical", "category": "security", "file": "cmd/alfred/config.go", "line": 42, "description": "API key stored in plain text"}
  → Security Critical → BLOCKED

Output:
  ## BLOCKED — Human decision required
  ### Reason
  Security Critical: API key stored in plain text
  ### Last clean state
  Phase: impl-phase-1, Commit: abc1234
  ### Recommended actions
  1. Use OS keychain or encrypted storage for API keys
  2. After resolving: run `/alfred:attend add-config-option` to resume
  ### Unresolved findings
  - [critical] cmd/alfred/config.go:42 — API key stored in plain text in config file
```

## Resume after security BLOCKED

```
/alfred:attend add-config-option

Phase 0: Resume
  → spec status: blocked=true, blocked_reason="Security Critical: API key..."
  → AskUserQuestion: "Previous run BLOCKED (security). How did you resolve: API key stored in plain text?"
  → User: "Switched to keychain storage in config.go"
  → Clear blocked → resume from impl-phase-1 REVIEW (re-reviews the security fix)
```
