# Recovery and Error Handling

Used by `/alfred:develop` when things go wrong.

## BLOCKED Protocol

### When to enter BLOCKED state

| Trigger | Phase | Action |
|---|---|---|
| Security Critical finding | Any review phase | Immediate BLOCKED |
| Confidence ≤5 in spec section | Spec review | Immediate BLOCKED |
| Max iterations with unresolved Critical | Any review phase | BLOCKED after cap |
| Agent spawn budget exhausted (20) | Any phase | Immediate BLOCKED |
| All review agents failed (2+ of 3) | Any review phase | Immediate BLOCKED |
| go test/vet fails after 2 fix attempts | Test gate | BLOCKED after cap |
| Credential pattern detected in staged diff | Commit | Immediate BLOCKED |

### BLOCKED output format

When entering BLOCKED, output to the user:

```markdown
## BLOCKED — Human decision required

### Reason
{specific finding or failure description}

### Last clean state
Phase: {last successful phase}, Commit: {phase_start_commit}

### Recommended actions
1. {specific resolution steps}
2. After resolving: run `/alfred:develop {task-slug}` to resume

### Unresolved findings
- [{severity}] {file}:{line} — {description}
```

Then update session.md Orchestrator State:
- `blocked: true`
- `blocked_reason: {reason}`
- Write findings to session.md Blockers section

### Recovery on re-invocation

When `/alfred:develop {slug}` is called and state shows `blocked: true`:

**Security-critical blocks:**
1. Ask: "Previous run BLOCKED (security): {blocked_reason}. How did you resolve this?"
2. Resume from the **same phase's review** (re-review the fix, don't skip ahead)

**Non-security blocks:**
1. Ask: "Previous run BLOCKED: {blocked_reason}. Has this been resolved?"
2. If yes → resume from the **next phase**
3. If no → re-output BLOCKED message

This distinction ensures security fixes are always re-reviewed.

---

## Agent Failure Handling

### Detection criteria

| Condition | Classification |
|---|---|
| Agent returns < 100 tokens | Failed |
| JSON verdict parse fails | Degraded (see below) |
| Agent timeout (no response) | Failed |
| Missing `##` headers (spec agents) | Failed (1 retry) |

### Malformed JSON handling

If a review agent returns non-JSON output:
```json
{
  "verdict": "NEEDS_FIXES",
  "findings": [{
    "severity": "high",
    "category": "operability",
    "file": "review-agent",
    "line": 0,
    "description": "Review agent returned malformed verdict. Manual review recommended for: {agent_perspective}"
  }]
}
```

### Graceful degradation

| Failed agents | Action |
|---|---|
| 0 of 3 | Normal flow |
| 1 of 3 | Continue with 2 agents' findings (note reduced coverage in decisions.md) |
| 2+ of 3 | BLOCKED — insufficient review coverage |
| Mediator (spec) | Use agreements from 3 agents only, mark conflicts as confidence ≤5 |

---

## Compaction Recovery

### How state survives compaction

1. `## Orchestrator State` in session.md is preserved by PreCompact hook
2. CLAUDE.md Compact Instructions includes: `Preserve ## Orchestrator State block in session.md verbatim`
3. On skill resume (Phase 0), always read state via `spec` action=status
4. If state block is missing/corrupted after compaction:
   - Read session.md for any partial state
   - If phase can be determined → resume from that phase
   - If not → restart from spec-review (spec files should still exist)

---

## Stagnation Detection

### Hash computation

1. Collect all findings from current iteration
2. Sort by: `severity + ':' + file + ':' + description` (lexicographic, includes file for uniqueness)
3. Concatenate sorted strings with newline separator
4. Compute SHA-256 of concatenated string
5. Compare with `findings_hash` from previous iteration
6. Match → stagnation detected → exit loop

### Stagnation behavior

- If stagnation with remaining Critical findings → BLOCKED
- If stagnation with only High/Warning → log to decisions.md as known trade-offs, proceed

---

## Warning Accumulation

Track `total_warnings` in Orchestrator State across all review phases.
When cumulative warnings exceed 5:
- Log: "Warning accumulation threshold exceeded (N warnings)"
- Treat subsequent warnings as High severity for loop re-entry decisions
- Record escalation in decisions.md
- `total_warnings` is sticky — fixed warnings do not decrement the counter
