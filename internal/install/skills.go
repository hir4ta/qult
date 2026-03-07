package install
type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var alfredSkills = []skillDef{
	{
		Dir: "configure",
		Content: `---
name: configure
description: >
  Create or polish a single Claude Code configuration file (skill, rule, hook,
  agent, MCP server, CLAUDE.md, or memory) with independent review.
  For project-wide setup, use /alfred:setup instead.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__alfred__knowledge
context: current
---

The butler tends to the estate's configuration — whether building new or polishing existing.

## Steps

1. **[WHAT]** Determine target type from $ARGUMENTS:
   - Parse for type: ` + "`skill`" + `, ` + "`rule`" + `, ` + "`hook`" + `, ` + "`agent`" + `, ` + "`mcp`" + `, ` + "`claude-md`" + `, ` + "`memory`" + `
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

2. **[HOW]** Check if target file exists:
   - Glob for existing files at the target path (see Target Paths below)

3. **[HOW]** If file EXISTS (polish flow):
   - Read the current file content in full
   - Call ` + "`knowledge`" + ` with query about latest best practices for this type
   - Compare against best practices and identify gaps (type-specific):
     - **skill**: constraint tags (HOW/WHAT/Template/Guardrails), tool least-privilege, argument-hint, context choice
     - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
     - **hook**: timeout values appropriate, matchers specific, handler robust
     - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
     - **mcp**: env vars for secrets, valid command
     - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
     - **memory**: <200 lines, topic-organized, no session-specific content
   - Present proposed changes with before/after diff and ask for approval
   - Use Edit tool to apply approved changes (preserve unchanged sections)

4. **[HOW]** If file is NEW (prepare flow):
   - Gather requirements (type-specific):
     - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
     - **rule**: enforcement concept, glob patterns (e.g., ` + "`**/*.go`" + `)
     - **hook**: event type, handler purpose, blocking behavior
     - **agent**: specialization, required tools, memory type (user/project/local)
     - **mcp**: server name/npm package, server type (stdio/sse)
     - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
     - **memory**: check auto memory path, topic organization
   - Call ` + "`knowledge`" + ` with query about the specific type's best practices
   - Generate from type-specific template:
     - **skill**: frontmatter (name, description, allowed-tools, context, agent) + constraint tags (HOW/WHAT/Template/Guardrails)
     - **rule**: frontmatter with paths + actionable instructions (<20 lines)
     - **hook**: hooks.json entry (timeout, matcher, command) + handler script
     - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
     - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
     - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
     - **memory**: MEMORY.md template organized by topic

5. **[HOW]** Validate type-specific constraints:
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

6. **[HOW]** Write/Edit file to target path

7. **[HOW]** Independent review:
   - Spawn Explore agent to validate the generated/updated file against knowledge base
   - Fix any issues found

## Target Paths

| Type | Path |
|------|------|
| skill | ` + "`.claude/skills/<name>/SKILL.md`" + ` |
| rule | ` + "`.claude/rules/<name>.md`" + ` |
| hook | ` + "`.claude/hooks.json`" + ` (or settings.json hooks section) |
| agent | ` + "`.claude/agents/<name>.md`" + ` |
| mcp | ` + "`.mcp.json`" + ` |
| claude-md | ` + "`CLAUDE.md`" + ` (project root) |
| memory | Auto memory path ` + "`MEMORY.md`" + ` |

## Guardrails

- Do NOT overwrite existing files without asking for approval first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
- Preserve the user's voice and style when updating existing files
`,
	},
	{
		Dir: "setup",
		Content: `---
name: setup
description: >
  Project-wide Claude Code setup wizard, or explain any Claude Code feature
  with examples. Scans the whole project and guides multi-file configuration.
  For single-file work, use /alfred:configure instead.
user-invocable: true
argument-hint: "[feature | --wizard]"
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__config-review
context: current
---

The butler welcomes the master and briefs them on the estate.

## Steps

1. **[WHAT]** Determine mode from $ARGUMENTS:
   - If arguments contain a feature name (hooks, skills, rules, agents, MCP, memory, worktrees, teams) → go to Step 2 (brief flow)
   - If arguments contain "--wizard" or no arguments → go to Step 3 (wizard flow)

2. **[HOW]** Brief flow — explain a feature:
   - Call ` + "`knowledge`" + ` with query about the selected feature
   - If multiple results, synthesize the most relevant
   - Output in template format:
     ` + "```" + `
     ## <Feature Name>

     **What**: One sentence explanation.

     **When to use**:
     - Scenario 1
     - Scenario 2

     **Setup** (copy-pasteable):
     ` + "```" + `
     <minimal working example>
     ` + "```" + `

     **Tips**:
     - Practical tip 1
     - Practical tip 2
     ` + "```" + `
   - STOP here

3. **[HOW]** Wizard flow — interactive setup:
   - Call ` + "`config-review`" + ` with project_path=$CWD to assess current setup
   - Present current state as a status checklist: ` + "`[x] CLAUDE.md`" + `, ` + "`[ ] Hooks`" + `, etc.

4. **[WHAT]** Ask what to configure:
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

5. **[HOW]** Auto-detect project stack:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

6. **[HOW]** Generate selected items:
   - For each selected item, follow generation logic with sensible defaults based on detected stack
   - Use streamlined wizard mode — ask fewer questions, prefer smart defaults

7. **[HOW]** Verify setup:
   - Call ` + "`config-review`" + ` again to check improvement
   - Report before/after score

8. **[Template]** Final output:
   ` + "```" + `
   ## Setup Complete

   Created:
   - CLAUDE.md (N lines)
   - .claude/hooks.json (N hooks)
   - ...

   Setup Score: N/10 (was M/10)

   Next: Try asking Claude Code about your project — alfred's knowledge
   base will help provide better answers.
   ` + "```" + `

## Guardrails

- Do NOT overwrite existing files without asking
- Do NOT create configurations that conflict with each other
- Do NOT ask more than 2 questions per item in wizard mode (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
- Do NOT output more than 20 lines in brief mode unless the user asks for detail
- Do NOT fabricate features in brief mode — only explain what's in the knowledge base
`,
	},
	{
		Dir: "brainstorm",
		Content: `---
name: brainstorm
description: |
  Divergent thinking: Generate perspectives, options, hypotheses, and questions from a rough theme, producing decision-ready Markdown.
  Leverages alfred knowledge to supplement with relevant information from the knowledge base.
  Use when: (1) unsure what to think about, (2) ideas are few or thinking is rigid,
  (3) need to surface risks and issues, (4) need raw material for convergence (/alfred:refine).
user-invocable: true
argument-hint: "<theme or rough prompt>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-init
context: current
---

# /alfred:brainstorm

A skill for divergent thinking with AI — expanding options, perspectives, hypotheses, and questions.
The goal is not "deciding" but "expanding." However, it creates an entry point to convergence at the end.

## Key Principles
- This skill's role is **divergence**. It does not judge or decide (decisions are made by /alfred:refine).
- Where facts are insufficient, explicitly label as "hypothesis" — **never assert speculation as fact**.
- If output gets too long, compress to key points and continue.

## alfred-Specific Features
- In Phase 1, use the ` + "`knowledge`" + ` tool to search the knowledge base for related documents and best practices as divergence material
- After Phase 4 output, offer the option "Create a spec with spec-init?"
- Output can be persisted to DB (via spec-init)

## Phase 0: Intake & Minimal Assumption Check (AskUserQuestion recommended)
Confirm with up to 3 questions (with choices):

1) What is the goal?
- a) Determine direction
- b) Expand options
- c) Surface risks/issues
- d) Reframe the question

2) Any constraints?
- Deadline / time / budget / team / tech restrictions / hard no's

3) What is the scope?
- Personal decision / team consensus / product / learning / career etc

*If the user says "you decide", proceed with reasonable defaults.*

## Phase 1: Comprehensive Perspectives (Divergence) + Knowledge Search
First, use the ` + "`knowledge`" + ` tool to search for documents related to the theme as divergence material.

At minimum, produce these "perspective blocks":
- Goals & success state (What good looks like)
- Target users/situations (Who is affected and how)
- Approach types (Categories of solutions)
- Trade-off axes (Speed/quality, short-term/long-term, etc.)
- Risks / failure patterns
- Validation (How to verify)

## Phase 2: Idea Generation (in bundles)
3 bundles — "Conservative / Realistic / Experimental", 3-7 ideas each.
Each idea must follow this brief format:
- One-liner
- 30-second explanation
- When it works
- Fit with constraints
- Minimal validation

## Phase 3: Generate Questions for Convergence
Create 5-12 questions needed for convergence (decision-making).

## Phase 4: Output (Markdown)
Always use this structure:

` + "```md" + `
# Brainstorm Output: <Theme>

## Assumptions
- Goal:
- Constraints:
- Scope:

## Perspectives (coverage check)
- ...

## Idea Bundles
### Conservative
- ...
### Realistic
- ...
### Experimental
- ...

## Risks / Concerns (anticipated failure patterns)
- ...

## Validation Seeds
- Test ideas:
- Observation/logging ideas:

## Questions to Answer for Convergence (priority order)
1.
2.
3.

## Recommended Next Step
- To converge: /alfred:refine
- To create a spec: /alfred:plan
- To explore: files to read in Plan Mode / commands to investigate
` + "```" + `

## Exit Criteria
- User says "enough"
- At least 10 ideas generated across bundles
- Questions for convergence are ready
`,
	},
	{
		Dir: "refine",
		Content: `---
name: refine
description: |
  Convergent thinking: Fix the issue to one line, narrow options to 3 max, score with criteria, finalize the next output as Markdown.
  Decisions are automatically saved to spec via spec-update.
  Use when: (1) stuck and can't move forward, (2) have candidates but can't choose, (3) need to define minimum scope,
  (4) need to turn brainstorm results or notes into decisions.
user-invocable: true
argument-hint: "<theme or current messy notes>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-update, mcp__alfred__spec-status
context: current
---

# /alfred:refine

Purpose: Produce an "agreed decision" and "next output" to move forward.
Approach: Aligned with Claude Code's Explore -> Plan -> Implement flow, this strengthens the Plan phase.

## Key Principles
- This skill's role is **convergence (decision-making)**. It does not implement.
- This skill's output becomes "input for the next plan/implementation." Leave no ambiguity.
- Where facts are insufficient, ask questions to confirm — do not fill in with speculation.
- If discussion diverges, always return to the "one-line issue."

## alfred-Specific Features
- Use the ` + "`knowledge`" + ` tool to search for related best practices as decision material
- After Phase 4 (decision), automatically record via ` + "`spec-update decisions.md`" + `
- If an active spec exists, check current state via ` + "`spec-status`" + ` before starting

## Phase 0: Blocker Type Diagnosis (1 question)
Ask the user to choose:
1) Unclear question
2) Too many options
3) Can't minimize scope
4) Next step is vague
5) Stopped by anxiety

## Phase 1: Fix the Issue (iterate until agreed)
Create and agree on this one-liner:
- "I want to decide <what to decide> in <situation> within <constraints>"

## Phase 2: Option Inventory (max 5 -> 3)
List existing options if any. Otherwise propose 3 tentative options and refine with Yes/No.

## Phase 3: Evaluation Criteria (3-5) + Rough Scoring
Common axes: Impact / Feasibility / Failure cost / Learning / Sustainability / Low dependency

## Phase 4: Decision (the agreement point)
- Selected option (1) or try 2 options in sequence
- OUT (what NOT to do) — always list 3
- **If an active spec exists, record to decisions.md via ` + "`spec-update`" + `**

## Phase 5: Validation Method (fix self-verification conditions)
Test / expected output / screenshot comparison / command

## Phase 6: Finalize One Next Output
Example: 1 diagram / 1-page spec / minimal demo. Completion criteria in 1 line.

## Phase 7: Output (Markdown)
Always use this structure:

` + "```md" + `
# Refine Output: <Theme>

## One-Line Issue (agreed version)
- ...

## Assumptions & Constraints
- ...

## Options (max 3)
1.
2.
3.

## Evaluation Criteria & Rough Scores (1-5)
| Criterion | 1 | 2 | 3 | Notes |
|---|---:|---:|---:|---|
| Impact | | | | |
| Feasibility | | | | |
| Failure cost | | | | |

## Decision
- Selected:
- Reason (brief):
- OUT (not doing):
  - ...
  - ...
  - ...

## Validation
- Command/check:
- Expected result:

## Next Output (do only this)
- Deliverable:
- Completion criteria:
- Reference @file / commands:
` + "```" + `

## Exit Criteria
- One-line issue is agreed
- Narrowed to max 3 options
- One next output is decided
`,
	},
	{
		Dir: "plan",
		Content: `---
name: plan
description: >
  Butler Protocol: Interactively generate a spec. Requirements -> design -> task breakdown,
  saved to .alfred/specs/. Creates a development plan resilient to Compact/session loss.
  Use when: (1) starting a new task, (2) organizing a design, (3) planning before resuming work.
user-invocable: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-init, mcp__alfred__spec-update, mcp__alfred__spec-status
context: current
---

# /alfred:plan — Butler Protocol Spec Generator

Interactively generate a spec, creating a development plan resilient to Compact/session loss.

## Core Principle
**What Compact loses most: reasoning process, rationale for design decisions, dead-end explorations, implicit agreements.**
By explicitly writing these to files, we create a spec that enables perfect recovery regardless of when the session is interrupted.

## Steps

1. **[WHAT]** Parse $ARGUMENTS:
   - task-slug (required): URL-safe identifier
   - description (optional): brief summary
   - If no arguments, confirm via AskUserQuestion

2. **[HOW]** Call ` + "`spec-status`" + ` to check existing state:
   - If active spec exists for this slug -> resume mode (skip to Step 7)
   - If no spec -> creation mode (continue)

3. **[HOW]** Requirements gathering (interactive, max 3 questions):
   - What is the goal? (one sentence)
   - What does success look like? (measurable criteria)
   - What is explicitly out of scope?

4. **[HOW]** Design decisions (interactive + knowledge search):
   - Call ` + "`knowledge`" + ` to search for relevant best practices
   - Discuss architecture approach
   - Record alternatives considered (CRITICAL for compact resilience)

5. **[HOW]** Task breakdown:
   - Break into concrete, checkable tasks
   - Order by dependency

6. **[HOW]** Call ` + "`spec-init`" + ` with gathered information:
   - Creates all 4 files with templates
   - Then call ` + "`spec-update`" + ` for each file to fill in gathered content:
     - requirements.md: replace with full requirements
     - design.md: replace with design decisions
     - decisions.md: append initial design decisions
     - session.md: replace with current position + next steps

7. **[OUTPUT]** Confirm to user:
   ` + "```" + `
   Butler Protocol initialized for '{task-slug}'.

   Spec files: .alfred/specs/{task-slug}/
   - requirements.md ✓
   - design.md ✓
   - decisions.md ✓
   - session.md ✓

   DB synced: {N} documents indexed.

   Compact resilience: Active. Session state will auto-save before compaction.
   Session recovery: Active. Context will auto-restore on session start.

   Ready to implement. Start with the first item in Next Steps.
   ` + "```" + `

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call ` + "`spec-status`" + ` to get current session state
2. Read spec files in recovery order:
   - session.md (where am I?)
   - requirements.md (what am I building?)
   - design.md (how?)
   - decisions.md (why these choices?)
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}. Next steps: {next_steps}"
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record at least the initial approach decision
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered, even if only briefly
- ALWAYS update session.md with current position after plan completion
`,
	},
	{
		Dir: "review",
		Content: `---
name: review
description: >
  3-layer knowledge-powered code review. Checks changes against active spec (decisions, scope),
  semantic knowledge search, and best practices from documentation.
  Use when: (1) before committing, (2) after a milestone, (3) want a second opinion on changes.
user-invocable: true
argument-hint: "[focus area]"
allowed-tools: Read, Glob, Grep, Bash, mcp__alfred__code-review, mcp__alfred__spec-status
context: current
---

# /alfred:review — Knowledge-Powered Code Review

A 3-layer review that goes beyond linting — checking your changes against specs, accumulated knowledge, and best practices.

## Key Principles
- Surface **actionable** findings, not noise. Every finding should help the developer.
- Prioritize critical issues (scope violations, decision contradictions) over style.
- Reference sources so the developer can verify and learn.

## Steps

1. **[CONTEXT]** Gather review context:
   - Call ` + "`spec-status`" + ` to check if an active spec exists
   - If a focus area is provided in $ARGUMENTS, pass it to the review

2. **[REVIEW]** Call ` + "`code-review`" + ` with project_path and optional focus:
   - Layer 1 (Spec): checks changes against decisions.md and requirements scope
   - Layer 2 (Knowledge): semantic search for related knowledge across all sources
   - Layer 3 (Best Practices): FTS search for relevant documentation

3. **[OUTPUT]** Present findings organized by severity:

   **Critical** — Must fix before committing:
   - Out-of-scope changes detected
   - Contradicts a recorded decision

   **Warning** — Should review:
   - Related decisions exist that may be affected
   - Knowledge base has relevant context

   **Info** — Good to know:
   - Related best practices and documentation
   - Knowledge base matches for reference

4. **[SUMMARY]** End with:
   - Total findings by severity
   - Recommended actions (if any critical/warning findings)
   - If no findings: "Changes look good. No issues found against spec, knowledge, or best practices."

## Output Format

` + "```" + `
## Code Review: {focus or "all changes"}

### Critical ({n})
- [spec] {message} — {source}

### Warning ({n})
- [spec] {message} — {source}

### Info ({n})
- [knowledge] {message} — {source}
- [best_practice] {message} — {source}

---
{n} findings total. {recommendation}
` + "```" + `

## Exit Criteria
- All 3 layers checked
- Findings presented with sources
- Clear recommendation provided
`,
	},
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	// v0.1-v0.19 era
	"init",
	"alfred-unstuck",
	"alfred-checkpoint",
	"alfred-before-commit",
	"alfred-impact",
	"alfred-review",
	"alfred-estimate",
	"alfred-error-recovery",
	"alfred-test-guidance",
	"alfred-predict",
	// v0.20-v0.22 era
	"alfred-recover",
	"alfred-gate",
	"alfred-analyze",
	"alfred-forecast",
	"alfred-context-recovery",
	"alfred-crawl",
	// v0.23 era (alfred- prefix removed in v0.24)
	"alfred-create-skill",
	"alfred-create-rule",
	"alfred-create-hook",
	"alfred-create-agent",
	"alfred-create-mcp",
	"alfred-create-claude-md",
	"alfred-create-memory",
	"alfred-review",
	"alfred-audit",
	"alfred-learn",
	"alfred-preferences",
	"alfred-update-docs",
	"alfred-update",
	"alfred-setup",
	"alfred-migrate",
	"alfred-explain",
	// v0.24-v0.26 era (renamed to butler-style in v0.27)
	"create-skill",
	"create-rule",
	"create-hook",
	"create-agent",
	"create-mcp",
	"create-claude-md",
	"create-memory",
	"review",
	"audit",
	"learn",
	"preferences",
	"update-docs",
	"update",
	"setup",
	"migrate",
	"explain",
	// v0.27-v0.28 era (consolidated into configure/setup)
	"inspect",
	"harvest",
	"prepare",
	"polish",
	"greetings",
	"brief",
	"memorize",
}

