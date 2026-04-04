---
name: debug
description: "Structured root-cause debugging. Use when encountering any bug, test failure, or unexpected behavior — BEFORE proposing fixes. Enforces systematic investigation over guesswork. NOT for known issues with obvious fixes."
user-invocable: true
---

# /qult:debug

Systematic root-cause analysis. No fixes without evidence.

> **Quality by Structure, Not by Promise.**
> Symptom fixes are failure. Root cause fixes are success.
> The Wall blocks guesswork. Evidence opens the gate.

## The Wall

<HARD-GATE>
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.
No "let me try this", no "maybe it's X", no "quick fix".
Violating the letter of this process is violating the spirit of debugging.
</HARD-GATE>

## Process

### Phase 1: Root Cause Investigation

**Observe, don't hypothesize.**

1. **Reproduce**: Run the failing command/test. Capture exact error output.
2. **Isolate**: What is the smallest input that triggers the bug?
3. **Trace**: Follow the execution path from input to error.
   - Read the stack trace. Every frame matters.
   - Read the code at each frame. Don't assume you know what it does.
4. **Identify the divergence point**: Where does actual behavior diverge from expected?

Do NOT proceed to Phase 2 until you can state:
"The bug occurs at [file:line] because [specific mechanism], triggered by [specific input]."

If you cannot state this, you have not found the root cause. Keep investigating.

### Phase 2: Pattern Analysis

Once you have the root cause, check for patterns:

1. **Is this a systemic issue?** Search for similar patterns in the codebase.
   - `Grep` for the same anti-pattern in other files
   - Check if the same assumption is made elsewhere
2. **What was the original intent?** Read git blame / git log for the problematic code.
3. **Why wasn't this caught?** Is there a missing test? A gap in type checking?

### Phase 3: Hypothesis and Testing

Now — and ONLY now — propose a fix:

1. **State the hypothesis**: "Changing X to Y will fix the bug because Z"
2. **Predict the outcome**: "After the fix, [test] will pass and [edge case] will be handled"
3. **Write the test FIRST**: A failing test that captures the bug
4. **Verify the test fails**: The test MUST fail before the fix (RED)
5. **Apply the minimal fix**: Change only what's necessary
6. **Verify the test passes**: The test MUST pass after the fix (GREEN)

### Phase 4: Verification

1. **Run the full test suite**: Not just the new test
2. **Check for regressions**: Did the fix break anything else?
3. **Verify the original reproduction case**: Does it work now?

## The 3-Strike Rule

If your fix fails 3 times:

**STOP.** Your mental model of the problem is wrong.

1. Revert all attempted fixes
2. Report to the architect: "I've attempted 3 fixes and none resolved the issue. My current understanding is [X]. I suspect the architecture itself may need reconsideration."
3. Use AskUserQuestion: "Should I investigate a different angle, or would you like to discuss the approach?"

Do NOT try a 4th variation of the same approach. That is the definition of insanity.

## Architect's Frustration Signals

If the architect says any of these, you are doing it wrong:

| Signal | Meaning | Action |
|---|---|---|
| "Stop guessing" | You skipped Phase 1 | Go back to Phase 1. Reproduce first. |
| "Why did that break?" | You didn't check regressions | Run full test suite before claiming "fixed" |
| "You already tried that" | You're in a loop | Apply the 3-Strike Rule |
| "Just read the code" | You're making assumptions | Read the actual code, don't rely on memory |
| "Think harder" | Your investigation is too shallow | Trace the full execution path, not just the error line |

## Rationalization Prevention

| You might think... | Reality |
|---|---|
| "I know what this is" | If you knew, it wouldn't be a bug. Investigate. |
| "Let me just try this quick fix" | Quick fixes that miss root cause create more bugs |
| "It's probably a race condition" | "Probably" is not evidence. Reproduce it. |
| "The tests were wrong" | Tests are specifications. If they fail, understand WHY first. |
| "This worked before, so something else changed" | Find WHAT changed. Don't guess. |
| "I'll add more logging" | Logging is investigation, not a fix. Don't ship debug logging. |

## Red Flags — STOP if you catch yourself:

- Editing code before stating the root cause → Phase 1 not complete
- Saying "I think" instead of "I found" → You don't have evidence yet
- Changing multiple things at once → Isolate. One change per hypothesis.
- Skipping test verification → Proof or Block. No exceptions.
- Feeling frustrated → Take a step back. Re-read Phase 1.
