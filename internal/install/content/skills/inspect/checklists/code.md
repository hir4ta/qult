# Code Review Checklist

Profile: `code`
Trigger: source code changes (*.go, *.ts, *.py, *.rs, etc.)

Before evaluating, call `knowledge` with: "code review best practices error handling patterns"

## Logic Correctness

| # | Check | Severity | What to look for |
|---|---|---|---|
| L1 | Off-by-one errors | HIGH | Loop boundaries, slice indexing, fence-post errors |
| L2 | Nil/null dereference | HIGH | Nested struct access, map lookups, optional returns |
| L3 | Empty collection handling | HIGH | Zero-length slices, nil maps, empty strings |
| L4 | Division by zero | HIGH | Averaging, ratio calculations, user-supplied denominators |
| L5 | Integer overflow/truncation | MEDIUM | Type conversions, arithmetic on user input |
| L6 | Floating-point precision | LOW | Currency, equality comparisons, accumulation |

## Error Handling

| # | Check | Severity | What to look for |
|---|---|---|---|
| E1 | Error swallowing | CRITICAL | Empty catch blocks, `_ = err` without justification |
| E2 | Partial failure cleanup | HIGH | Step N of M fails — is prior state restored? |
| E3 | Resource leaks | HIGH | Unclosed files/connections/responses on error paths |
| E4 | defer symmetry | MEDIUM | open/close, lock/unlock pairs in all branches |
| E5 | Error message quality | LOW | Includes context (what failed, what was attempted) |

## Concurrency

| # | Check | Severity | What to look for |
|---|---|---|---|
| C1 | Race conditions | CRITICAL | Shared state without synchronization |
| C2 | Goroutine/async leaks | HIGH | Spawned but never joined or cancelled |
| C3 | Context cancellation | HIGH | Parent cancelled but child continues working |
| C4 | Deadlock potential | HIGH | Lock ordering, channel blocking, select without default |
| C5 | Channel direction | LOW | Missing `<-chan` / `chan<-` type constraints |

## Naming & Style

| # | Check | Severity | What to look for |
|---|---|---|---|
| N1 | Naming consistency | MEDIUM | Same concept, different names across files |
| N2 | Exported API surface | MEDIUM | Unnecessarily exported symbols |
| N3 | Magic numbers/strings | LOW | Undocumented constants, repeated literals |

## Performance (basic)

| # | Check | Severity | What to look for |
|---|---|---|---|
| P1 | N+1 queries | HIGH | DB queries inside loops |
| P2 | Unbounded growth | HIGH | Maps/slices that only grow, never shrink |
| P3 | Missing LIMIT | MEDIUM | DB queries without pagination/limit |
| P4 | Synchronous blocking | MEDIUM | Blocking I/O where async is appropriate |
| P5 | Unnecessary allocation | LOW | Repeated allocation in hot paths |

## Commit Scope

| # | Check | Severity | What to look for |
|---|---|---|---|
| S1 | Unrelated changes bundled | MEDIUM | Multiple concerns in one diff |
| S2 | Debug/temp code left in | HIGH | fmt.Println, console.log, TODO/FIXME without issue ref |
| S3 | Missing tests for new logic | MEDIUM | New branches/conditions without test coverage |
