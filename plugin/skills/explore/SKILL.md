---
name: explore
description: "AI-development-specific design exploration. Interviews the architect through structured questions before any code is written. Use when starting new features, major changes, or when requirements are unclear. NOT for trivial fixes or well-scoped tasks with clear requirements."
user-invocable: true
---

# /qult:explore

Design exploration through structured architect interview. No code until design is approved.

> **Quality by Structure, Not by Promise.**
> The architect decides *what* to build. The agent decides *how* to build it.
> Ambiguity is resolved by asking, never by guessing.

## The Wall

<HARD-GATE>
NO CODE BEFORE DESIGN APPROVAL.
No implementation files, no "quick prototypes", no "let me just try something."
The Wall blocks code until the architect approves the design.
If you think "this is too simple for a design" — that is exactly when hidden requirements bite.
</HARD-GATE>

## Process

### Phase 1: Intent Discovery

Interview the architect to understand the full picture. Use AskUserQuestion for EVERY question — never assume answers.

**Mandatory question categories** (minimum 2-3 questions per category):

#### 1. Purpose & Motivation
- What problem does this solve? Who experiences this problem?
- What does success look like? How will you know this worked?
- Why now? What triggered this work?

#### 2. Scope & Boundaries
- What is explicitly IN scope? What is explicitly OUT of scope?
- Are there related features you do NOT want changed?
- Should this be a standalone addition or integrated into existing patterns?

#### 3. Edge Cases & Error Handling
- What happens when input is empty / malformed / unexpected?
- What's the expected behavior under failure conditions?
- Are there concurrent access or race condition concerns?

#### 4. Non-Functional Requirements
- Performance requirements? Acceptable latency? Data volume?
- Security considerations? Does this handle external input?
- Backward compatibility constraints? Migration needed?

#### 5. Testing Strategy
- What would break that must NEVER break? (Critical regression targets)
- Integration test or unit test? What's the testing boundary?
- Are there existing test patterns to follow?

#### 6. Existing Codebase Alignment
- Which existing patterns should this follow?
- Are there similar features already implemented to reference?
- Any known tech debt that affects this area?

#### 7. Hidden Assumptions
- "When you say 'user', do you mean authenticated only, or anonymous too?"
- "Does 'fast' mean <100ms, <1s, or <10s?"
- "Should this work offline / in degraded mode?"

### Phase 2: Codebase Alignment

After the architect interview, explore the codebase silently:

1. Find relevant files, existing patterns, types, and tests
2. Identify impact radius — what files will be affected?
3. Check for conflicts with existing code

Then present findings to the architect:
- "The current implementation uses pattern X. Should we follow it or introduce a new approach?"
- "This change will affect N files. Here's the impact radius: [list]"
- "I found potential conflict with [existing feature]. How should we handle this?"

Use AskUserQuestion for each decision point.

### Phase 3: Constraint Mapping

Explicitly check AI-development-specific constraints:

| Constraint | Question to architect |
|---|---|
| **Context window** | "This touches N files. Should we split into sub-tasks for separate agent sessions?" |
| **Testability** | "Can each component be tested in isolation? Any external dependencies to mock?" |
| **Subagent suitability** | "Are there independent parts that can be implemented in parallel by subagents?" |
| **Security boundary** | "Does this cross a trust boundary? Where should input validation go?" |

### Phase 4: Design Decision

Present 2-3 concrete approaches to the architect:

```
## Approach A: [name]
- Pros: ...
- Cons: ...
- Effort: ...
- Risk: ...

## Approach B: [name]
- Pros: ...
- Cons: ...
- Effort: ...
- Risk: ...

## Recommendation: [A or B] because [reason]
```

Wait for architect's explicit approval via AskUserQuestion:
"Which approach do you prefer? Or should I explore a different direction?"

### Phase 5: Spec Documentation

After approval, write the design to `docs/spec-<feature>.md` (or a location the architect specifies):

```markdown
## Problem
What we're solving and why.

## Design Decision
Chosen approach and rationale.

## Scope
- IN: [explicit list]
- OUT: [explicit list]

## Key Decisions
- [Decision 1]: [rationale]
- [Decision 2]: [rationale]

## Testing Strategy
- [What to test and how]

## Constraints
- [Non-functional requirements]
```

### Phase 6: Handoff

Terminal state: invoke `/qult:plan-generator` with the spec as input.

Announce: "Design approved. Handing off to plan generation."

Do NOT skip to implementation. Do NOT write code. The Wall stands.

## Rationalization Prevention

| You might think... | Reality |
|---|---|
| "This is too simple for a design" | Simple projects hide the most unexamined assumptions |
| "I already know what to build" | You know what YOU think. The architect may think differently |
| "Questions will slow us down" | 15 minutes of questions prevents 3 hours of rework |
| "I'll figure out edge cases during implementation" | Edge cases found during implementation cost 10x to fix |
| "The architect will be annoyed by too many questions" | The architect will be MORE annoyed by wrong assumptions |
| "I can just start and ask later" | Sunk cost fallacy makes it harder to change direction after code exists |

## Red Flags — STOP if you catch yourself thinking:

- "Let me just write a quick prototype" → The Wall blocks this. Design first.
- "This is basically the same as X" → Ask the architect. "Basically" hides differences.
- "I'll ask about that later" → Ask NOW. Later = after you've built on a wrong assumption.
- "The requirements are obvious" → If they were obvious, the architect wouldn't need an agent.
- "One more file won't hurt" → Scope creep starts with "just one more."
