---
name: writing-skills
description: "TDD methodology for creating and testing qult skills. Use when creating new skills, editing existing skills, or verifying skills work correctly. Applies test-driven development to process documentation. NOT for editing non-skill files."
user-invocable: true
---

# /qult:writing-skills

Test-Driven Development applied to skill creation.

> **Quality by Structure, Not by Promise.**
> A skill that hasn't been tested is a skill that doesn't work.
> Writing skills IS Test-Driven Development applied to process documentation.

## The Wall

<HARD-GATE>
NO SKILL WITHOUT A FAILING TEST FIRST.
No "I'll test after writing". No "this skill is too simple to test".
Write the test. Watch it fail. Then write the skill. Then watch it pass.
</HARD-GATE>

## Process

### Phase 1: RED — Establish Baseline Behavior

Before writing ANY skill content, observe what happens WITHOUT the skill:

1. **Create a test scenario**: Define a specific task that the skill should handle
2. **Run without the skill**: Spawn a subagent with the task (no skill loaded)
3. **Document failure patterns**: What did the agent do wrong?
   - Did it skip steps?
   - Did it make assumptions?
   - Did it produce low-quality output?
   - Did it ignore edge cases?

This is your RED test. The skill must fix these failure patterns.

```markdown
## Baseline Test: [skill-name]
### Task: [specific task description]
### Without skill:
- [ ] Agent skipped [step]
- [ ] Agent assumed [thing] without asking
- [ ] Agent produced [bad output]
### Expected with skill:
- [ ] Agent performs [step]
- [ ] Agent asks architect about [thing]
- [ ] Agent produces [good output]
```

### Phase 2: GREEN — Write the Skill

Now write the skill to fix the observed failures:

#### Skill Structure

```markdown
---
name: [kebab-case, 1-64 chars]
description: "[WHAT it does]. [WHEN to use]. NOT for [exclusions]."
user-invocable: true  # if architect can invoke directly
---

# /qult:[name]

One-line purpose statement.

> **[qult philosophy quote]**

## The Wall (if enforcement needed)
<HARD-GATE>...</HARD-GATE>

## Process
[Numbered steps, clear and specific]

## Rationalization Prevention
[Table of excuses and rebuttals]

## Red Flags
[Self-check list]
```

#### Writing Principles

1. **Description = WHAT + WHEN + NOT**: The description is what agents use to decide whether to load the skill. Be specific.
   - BAD: "Use for debugging" (too vague)
   - GOOD: "Use when encountering any bug, test failure, or unexpected behavior — BEFORE proposing fixes. NOT for known issues with obvious fixes."

2. **Do NOT summarize the workflow in the description**: Agents will read the description and skip the body. Keep the description focused on WHEN to use, not HOW it works.

3. **Process = specific, testable steps**: Each step should produce an observable outcome.
   - BAD: "Think about the design"
   - GOOD: "Present 2-3 approaches to the architect via AskUserQuestion"

4. **Rationalization Prevention = preemptive defense**: List the excuses agents WILL make, and counter each one.

5. **Use qult terminology**: "architect" (not "user"), "The Wall" (for enforcement), "Proof or Block" (for verification).

6. **Token efficiency**: Keep the getting-started section under 150 words. Details go in later sections.

7. **No @ imports**: They consume 200k+ context tokens immediately.

### Phase 3: REFACTOR — Test and Iterate

1. **Run WITH the skill**: Same task, same subagent, skill loaded
2. **Compare against baseline**: Did the failure patterns disappear?
3. **Check for new evasion patterns**: Did the agent find a way around the skill?
   - If yes: add Rationalization Prevention entries and Red Flags
   - Iterate until the agent follows the skill faithfully

```markdown
## Iteration Test: [skill-name] v[N]
### Same task as baseline
### With skill v[N]:
- [x] Agent performs [step] ← FIXED
- [ ] Agent found loophole: [description] ← NEW FAILURE
### Fix: Added rationalization prevention for [loophole]
```

### Phase 4: Deploy

1. Place the skill in `plugin/skills/[name]/SKILL.md`
2. Test in a real session (not just subagent)
3. Document in the skill index if applicable

## Skill Types and Testing Strategies

| Type | Example | Test Strategy |
|---|---|---|
| **Discipline-Enforcing** | TDD, debugging | Subagent without skill should skip discipline; with skill should follow it |
| **Workflow** | explore, finish | Subagent should follow exact step sequence |
| **Pattern** | code review | Subagent output should match expected format |
| **Reference** | API docs | Subagent should use correct APIs/patterns |

## Rationalization Prevention

| You might think... | Reality |
|---|---|
| "This skill is too simple to test" | Simple skills hide simple failure modes. Test takes 30 seconds. |
| "I know skills well enough to write one correctly" | You know the CONCEPT. The agent will find loopholes you didn't imagine. |
| "Testing skills is overhead" | An untested skill that agents ignore is pure waste. |
| "I'll test after writing" | Tests-after prove "what does this do?" Tests-first prove "what SHOULD this do?" |
| "The agent will just follow instructions" | Research shows LLM instruction-following is context-dependent. Verify. |
| "I can iterate in production" | Production iteration = real tasks with real mistakes. Test first. |

## Red Flags — STOP if you catch yourself:

- Writing a full skill before testing baseline behavior → Phase 1 first
- Skipping Rationalization Prevention → Agents WILL rationalize. Preempt it.
- Description longer than 250 chars → Keep it focused on WHEN, not HOW
- Using vague process steps → Each step must produce an observable outcome
- No Red Flags section → If agents can't self-check, they can't self-correct
