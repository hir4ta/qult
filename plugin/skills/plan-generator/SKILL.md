---
name: plan-generator
description: "Generate a structured plan from a feature description. Spawns plan-generator agent to analyze the codebase and produce a task-by-task plan. Use when starting new work or to expand a brief description into a detailed plan. NOT for modifying existing plans."
---

# /qult:plan-generator

Generate a structured implementation plan from a brief feature description.

## Stage 0: Spec document check

Before generating a plan, check if a spec document exists:

1. Search for `docs/spec-*.md` files using Glob
2. If found: read the most recent spec and include it as context for the plan-generator agent
3. If not found: continue without a spec, but note in the agent prompt that no spec was provided

This ensures that design decisions from `/qult:explore` are carried into the plan.

## Stage 1: Plan generation (independent agent)

Detect the language of `$ARGUMENTS` (e.g., Japanese, English, Chinese, Korean, etc.). If the language is not English, include an explicit instruction in the agent prompt: `Output language: <detected language name>` (e.g., `Output language: 日本語`).

Spawn one `plan-generator` agent with:
- The user's feature description: `$ARGUMENTS`
- The spec document content (if found in Stage 0)
- The output language instruction (if non-English detected)

The agent analyzes the codebase independently and outputs a complete plan in markdown format.

## Stage 2: Persist

Write the final plan to `.claude/plans/plan-<timestamp>.md`.

Use format: `plan-YYYYMMDD-HHMMSS.md` for the filename.

## Stage 3: Plan evaluation (independent agent)

Spawn one `plan-evaluator` agent with the plan file path from Stage 2.

The evaluator reads the plan file and scores it on three dimensions:
- **Feasibility**: Can Claude Code execute each task as described?
- **Completeness**: Are all affected files covered, including consumers and tests?
- **Clarity**: Is each task unambiguous and actionable?

If the evaluator's verdict is `Plan: REVISE`:
1. Read the evaluator's findings
2. Fix the issues in the plan file
3. Re-spawn the evaluator on the updated plan

The SubagentStop hook enforces the score threshold mechanically (aggregate >= 10/15, max 2 iterations).

## Output

Summary line: `Plan generated: .claude/plans/<filename> (N tasks, evaluation: Feasibility=N Completeness=N Clarity=N)`

Then suggest: "Enter plan mode (Shift+Tab x2) to review and approve the plan."
