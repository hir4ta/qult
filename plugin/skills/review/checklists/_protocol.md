# Review Protocol

Shared reference for all review profiles. Defines scoring, severity, and output format.

## Severity Levels

| Level | Points | Gate? | Meaning |
|---|---|---|---|
| CRITICAL | gate | Yes | Must fix. Any critical = NEEDS_FIXES verdict |
| HIGH | 2 | No | Should fix. Significant quality impact |
| MEDIUM | 1 | No | Consider fixing. Noticeable improvement |
| LOW | 0.5 | No | Nice to have. Minor polish |

## Scoring

Score = (earned points / max applicable points) * 100

Map to maturity labels (consistent with config-review MCP tool):

| Score | Label | Meaning |
|---|---|---|
| 0-20 | needs-attention | Critical issues found |
| 21-40 | basic | Functional but significant gaps |
| 41-60 | adequate | Meets minimum standards |
| 61-80 | good | Well-implemented with minor issues |
| 81-100 | exemplary | Best practices throughout |

Items that don't apply (N/A) are excluded from the denominator.

## Output Format

### Single Profile

```
## Review: {profile-name}

**Score: {X}/100 ({label})**
**Verdict: {PASS | PASS_WITH_WARNINGS | NEEDS_FIXES}**
Reviewed: {N files, M lines}

### Critical
- [{CATEGORY}] `file:line` — description
  → fix suggestion

### High
- [{CATEGORY}] `file:line` — description
  → fix suggestion

### Medium / Low
- [{CATEGORY}] `file:line` — description

### Checklist Summary
| # | Check | Status | Detail |
|---|-------|--------|--------|
| C1 | name | OK/NG/N/A | evidence |
```

### Multi-Profile Summary (--all)

```
## Review Summary

| Profile | Score | Verdict | Critical | High | Medium |
|---------|-------|---------|----------|------|--------|
| code | 85 | PASS | 0 | 1 | 2 |
| security | 92 | PASS | 0 | 0 | 1 |
| config | 78 | PASS_WITH_WARNINGS | 0 | 2 | 3 |

### Priority Actions (top 5 across all profiles)
1. [HIGH/security] `file:line` — description
2. ...
```

## Verdict Rules

- **PASS**: 0 critical, score >= 80%
- **PASS_WITH_WARNINGS**: 0 critical, score 60-79%
- **NEEDS_FIXES**: any critical finding OR score < 60%

## Evaluation Principles

- Only report real issues — do NOT pad with trivial comments
- Each finding must include file:line reference when applicable
- Prefer false negatives over false positives — noise erodes trust
- If no issues found: "No issues found. Changes look good."
- Cap at 10 findings per profile (prioritize by severity)
- Always call `knowledge` before evaluating to get latest best practices
