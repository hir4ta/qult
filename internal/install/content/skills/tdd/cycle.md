# TDD Cycle Details

## RED Phase — Write the Failing Test

### Principles
- **One behavior per test**: each test asserts exactly one thing
- **Name reveals intent**: `TestUserLogin_InvalidPassword_ReturnsError` not `TestLogin2`
- **Arrange-Act-Assert**: clear structure in every test
- **Use table-driven tests** when testing multiple inputs for the same behavior (Go convention)

### Gate Criteria
The test MUST fail, and it must fail for the RIGHT reason:
- Correct: `undefined: NewEpic` (function doesn't exist yet)
- Correct: `expected 3, got 0` (logic not implemented)
- Wrong: `cannot import "pkg"` (test setup broken, not a real RED)
- Wrong: test passes (behavior already exists — skip this cycle)

### Reusing Past Patterns
If ledger search found relevant test patterns from Phase 0:
- Reuse the same test structure (table-driven, mock setup, etc.)
- Adapt assertions to the current test case
- Credit the source: `// Pattern from: {ledger label}`

## GREEN Phase — Minimal Implementation

### The Rule of Minimum
Write the LEAST amount of code that makes the test pass:
- Hardcode return values if only one test case exists
- Use simple if/else before introducing data structures
- Skip error handling unless the test checks for errors
- Let the NEXT test drive the need for generalization

### What "Minimal" Looks Like
```go
// Cycle 1 test: TestProgress_Empty returns (0, 0)
// GREEN implementation:
func (e *EpicDir) Progress() (int, int) {
    return 0, 0  // hardcoded — next test will force real logic
}

// Cycle 2 test: TestProgress_OneCompleted returns (1, 1)
// GREEN implementation (now needs real logic):
func (e *EpicDir) Progress() (int, int) {
    completed := 0
    for _, t := range e.Tasks {
        if t.Status == "completed" {
            completed++
        }
    }
    return completed, len(e.Tasks)
}
```

### Gate Criteria
- ALL tests pass (new + existing)
- No compilation warnings
- If an existing test broke: fix the implementation, NOT the old test

## REFACTOR Phase — Clean Without Changing Behavior

### When to Refactor
- Duplicated code across 3+ locations → extract helper
- Method too long (>30 lines) → split
- Poor naming → rename
- Complex conditional → simplify or extract

### When NOT to Refactor
- Only 1-2 repetitions → wait for the third
- "I might need this later" → YAGNI, wait for the test
- "This could be more elegant" → if tests pass and code is clear, move on

### Safety Net
1. Run ALL tests before refactoring (baseline)
2. Make ONE refactoring change
3. Run ALL tests after
4. If any test fails → revert the refactoring, move on
5. NEVER change test assertions during refactor (tests are the specification)

## Coverage Tracking

### Measuring Coverage
```bash
# Go
go test -coverprofile=coverage.out ./...
go tool cover -func=coverage.out | grep total

# Python
pytest --cov=src --cov-report=term-missing

# JavaScript/TypeScript
npx jest --coverage

# Rust
cargo tarpaulin --out stdout
```

### Recording Delta
Track coverage at:
1. Phase 0 start → `coverage_start`
2. Each VERIFY phase → `coverage_current`
3. Phase 7 complete → `coverage_end`
4. Delta = `coverage_end - coverage_start`

## Anti-Patterns to Avoid

### RED Anti-Patterns
- Writing multiple tests at once (write ONE, make it pass, then the next)
- Writing a test that can never fail (tautology: `assert 1 == 1`)
- Testing implementation details (test behavior, not internals)

### GREEN Anti-Patterns
- Adding "just one more feature" beyond what the test requires
- Refactoring during GREEN (that's what REFACTOR is for)
- Writing production-quality code (it will be refactored anyway)

### REFACTOR Anti-Patterns
- Changing behavior (tests should still pass without modification)
- Adding new tests (that's RED phase)
- "Refactoring" to add features (that's GREEN phase for a new test)
