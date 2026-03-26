/**
 * `alfred init` — Setup alfred in ~/.claude/ and project .alfred/
 *
 * Installs: MCP server, hooks, rules, skills, agents, gates, DB
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectGates } from "../gates/index.js";
import { detectProjectProfile } from "../profile/detect.js";
import { Store } from "../store/index.js";

interface InitOptions {
	scan?: boolean;
	force?: boolean;
}

export async function alfredInit(cwd: string, opts: InitOptions = {}): Promise<void> {
	const home = homedir();
	const claudeDir = join(home, ".claude");

	console.log("alfred init\n");

	// 1. MCP server registration
	installMcp(claudeDir, opts.force);

	// 2. Hooks
	installHooks(claudeDir, opts.force);

	// 3. Rules
	installRules(claudeDir);

	// 4. Skills
	installSkills(claudeDir);

	// 5. Agents
	installAgents(claudeDir);

	// 6. Project setup
	await initProject(cwd);

	// 7. DB
	initDb();

	console.log("\nalfred initialized.");
}

function installMcp(claudeDir: string, force?: boolean): void {
	const mcpPath = join(claudeDir, ".mcp.json");
	let mcp: Record<string, unknown> = {};

	if (existsSync(mcpPath)) {
		try {
			mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
		} catch {
			/* new file */
		}
	}

	const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
	if (servers.alfred && !force) {
		console.log("  ✓ MCP: alfred already registered");
		return;
	}

	servers.alfred = {
		type: "stdio",
		command: "alfred",
		args: ["serve"],
		env: { VOYAGE_API_KEY: "${VOYAGE_API_KEY}" },
	};
	mcp.mcpServers = servers;

	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
	console.log("  ✓ MCP: alfred registered → ~/.claude/.mcp.json");
}

function installHooks(claudeDir: string, force?: boolean): void {
	const settingsPath = join(claudeDir, "settings.json");
	let settings: Record<string, unknown> = {};

	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			/* new file */
		}
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;

	// Only install if not already present (or force)
	const alfredHooks = {
		PreToolUse: [
			{
				matcher: "Edit|Write",
				hooks: [{ type: "command", command: "alfred hook pre-tool-use", timeout: 3 }],
			},
		],
		PostToolUse: [
			{
				matcher: "Bash|Edit|Write",
				hooks: [{ type: "command", command: "alfred hook post-tool-use", timeout: 5 }],
			},
		],
		UserPromptSubmit: [
			{ hooks: [{ type: "command", command: "alfred hook user-prompt-submit", timeout: 10 }] },
		],
		SessionStart: [
			{ hooks: [{ type: "command", command: "alfred hook session-start", timeout: 5 }] },
		],
		PreCompact: [
			{
				hooks: [
					{ type: "command", command: "alfred hook pre-compact", timeout: 10 },
					{
						type: "agent",
						prompt:
							"Read the transcript and extract error resolutions (error → fix patterns). For each, run: alfred hook-internal save-decision --title '...' --error_signature '...' --resolution '...'",
						timeout: 60,
					},
				],
			},
		],
		Stop: [{ hooks: [{ type: "command", command: "alfred hook stop", timeout: 3 }] }],
	};

	let installed = 0;
	for (const [event, config] of Object.entries(alfredHooks)) {
		if (!hooks[event] || force) {
			hooks[event] = config;
			installed++;
		}
	}

	settings.hooks = hooks;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	console.log(`  ✓ Hooks: ${installed} events installed → ~/.claude/settings.json`);
}

function installRules(claudeDir: string): void {
	const rulesDir = join(claudeDir, "rules");
	mkdirSync(rulesDir, { recursive: true });

	const qualityRules = `---
description: alfred quality enforcement rules — applied to all projects
---

# Quality Rules

## Test First
- When implementing a new function or module, write the test file FIRST
- Test file must have at least 2 meaningful assertions per test case
- Do not mark implementation as complete until tests pass

## Error Handling
- Check function return values explicitly — do not silently ignore errors
- Prefer early return over deeply nested if/else
- Never catch errors just to log them — either handle or re-throw

## Code Changes
- Keep each logical change under 200 lines of diff
- If a change exceeds 200 lines, split into smaller commits
- Run the project's lint and type check commands after each file edit

## Self-Check Before Completion
- Before marking any task as done, verify:
  1. Are there edge cases that need tests?
  2. Could this fail silently (produce wrong output without crashing)?
  3. Is there a simpler approach?
  4. Does this follow the project's existing patterns?

## When Stuck
- If the same approach fails 3 times, stop and research:
  1. Check official documentation
  2. Search for similar issues on GitHub/StackOverflow
  3. Try a fundamentally different approach
`;

	writeFileSync(join(rulesDir, "alfred-quality.md"), qualityRules);
	console.log("  ✓ Rules: alfred-quality.md → ~/.claude/rules/");
}

function installSkills(claudeDir: string): void {
	// /alfred:review
	const reviewDir = join(claudeDir, "skills", "alfred-review");
	mkdirSync(reviewDir, { recursive: true });

	writeFileSync(join(reviewDir, "SKILL.md"), REVIEW_SKILL_MD);

	// Checklists
	const checklistDir = join(reviewDir, "checklists");
	mkdirSync(checklistDir, { recursive: true });
	writeFileSync(join(checklistDir, "security.md"), CHECKLIST_SECURITY);
	writeFileSync(join(checklistDir, "logic.md"), CHECKLIST_LOGIC);
	writeFileSync(join(checklistDir, "design.md"), CHECKLIST_DESIGN);

	// /alfred:conventions
	const convDir = join(claudeDir, "skills", "alfred-conventions");
	mkdirSync(convDir, { recursive: true });

	writeFileSync(join(convDir, "SKILL.md"), CONVENTIONS_SKILL_MD);

	console.log("  ✓ Skills: alfred-review, alfred-conventions → ~/.claude/skills/");
}

function installAgents(claudeDir: string): void {
	const agentsDir = join(claudeDir, "agents");
	mkdirSync(agentsDir, { recursive: true });

	writeFileSync(
		join(agentsDir, "alfred-reviewer.md"),
		`---
name: alfred-reviewer
description: >
  Single-perspective code reviewer. Used as a sub-agent by /alfred:review.
  Focuses on one review dimension (security, logic, or design).
  Returns structured findings. Never spawns sub-agents itself.
tools: Read, Glob, Grep, Bash(git diff *, git show *)
disallowedTools: Write, Edit, Agent
maxTurns: 15
---

You are a focused code reviewer. You receive a diff and a checklist.
Review ONLY the diff — do not flag pre-existing issues.

Output each finding with severity (critical/high/medium/low), file path, line number,
issue description, and suggested fix.

If no issues found, state: "No issues found in this review dimension."
`,
	);

	console.log("  ✓ Agent: alfred-reviewer → ~/.claude/agents/");
}

async function initProject(cwd: string): Promise<void> {
	const alfredDir = join(cwd, ".alfred");
	const stateDir = join(alfredDir, ".state");
	mkdirSync(stateDir, { recursive: true });

	// gates.json
	const gatesPath = join(alfredDir, "gates.json");
	if (!existsSync(gatesPath)) {
		const gates = detectGates(cwd);
		writeFileSync(gatesPath, `${JSON.stringify(gates, null, 2)}\n`);
		console.log("  ✓ Gates: auto-detected → .alfred/gates.json");
	} else {
		console.log("  ✓ Gates: .alfred/gates.json exists");
	}

	// Project profile
	const profilePath = join(stateDir, "project-profile.json");
	if (!existsSync(profilePath)) {
		const profile = detectProjectProfile(cwd);
		writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
		console.log("  ✓ Profile: auto-detected → .alfred/.state/project-profile.json");
	} else {
		console.log("  ✓ Profile: .alfred/.state/project-profile.json exists");
	}

	// Conventions (auto-generate from profile)
	const convPath = join(alfredDir, "conventions.json");
	if (!existsSync(convPath)) {
		try {
			const profile = existsSync(profilePath)
				? JSON.parse(readFileSync(profilePath, "utf-8"))
				: detectProjectProfile(cwd);
			const { generateBaseConventions } = await import("../profile/conventions.js");
			const conventions = generateBaseConventions(profile);
			writeFileSync(convPath, `${JSON.stringify(conventions, null, 2)}\n`);
			console.log(
				`  ✓ Conventions: ${conventions.length} base conventions → .alfred/conventions.json`,
			);
		} catch {
			writeFileSync(convPath, "[]\n");
			console.log("  ✓ Conventions: empty .alfred/conventions.json (detection failed)");
		}
	} else {
		console.log("  ✓ Conventions: .alfred/conventions.json exists");
	}

	// Layers (architecture boundary enforcement)
	const layersPath = join(alfredDir, "layers.json");
	if (!existsSync(layersPath)) {
		const skeleton = generateLayersSkeleton(cwd);
		if (skeleton) {
			writeFileSync(layersPath, `${JSON.stringify(skeleton, null, 2)}\n`);
			console.log(`  ✓ Layers: ${skeleton.layers.length} layers → .alfred/layers.json`);
		}
	} else {
		console.log("  ✓ Layers: .alfred/layers.json exists");
	}

	// Knowledge directories
	for (const dir of ["error_resolutions", "fix_patterns", "conventions"]) {
		mkdirSync(join(alfredDir, "knowledge", dir), { recursive: true });
	}
	console.log("  ✓ Knowledge: .alfred/knowledge/ directories created");
}

function initDb(): void {
	const store = Store.openDefault();
	store.close();
	console.log("  ✓ DB: ~/.alfred/alfred.db (Schema V1)");
}

// ── Skill/Agent templates ───────────────────────────────────────────

const REVIEW_SKILL_MD = `---
name: alfred-review
description: >
  Deep multi-agent code review with Judge filtering (HubSpot pattern).
  Use when wanting thorough review before a major commit, after a milestone,
  or when wanting a second opinion. Spawns 3 parallel sub-reviewers
  (security, logic, design), then a Judge filters findings by 3 criteria:
  Succinctness, Accuracy, Actionability (80%+ engineer approval rate).
  NOT for everyday small edits (hooks handle that).
user-invocable: true
argument-hint: "[--staged | --commit SHA | --range BASE..HEAD]"
allowed-tools: Read, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *)
context: fork
---

# /alfred:review — Judge-Filtered Code Review

## Phase 1: Gather Context

1. Parse \`$ARGUMENTS\` for scope:
   - \`--staged\` (default): \`git diff --cached\`
   - \`--commit SHA\`: \`git show SHA\`
   - \`--range BASE..HEAD\`: \`git diff BASE..HEAD\`
2. If no args: use \`git diff\` (unstaged changes)
3. Extract changed file paths and languages
4. Read @checklists/security.md, @checklists/logic.md, @checklists/design.md

## Phase 2: Parallel Review (spawn 3 agents simultaneously)

Launch all 3 agents in a single message with the diff:

**Agent 1: security** — @checklists/security.md
Focus: injection, auth bypass, secrets exposure, input validation, TOCTOU

**Agent 2: logic** — @checklists/logic.md
Focus: correctness, edge cases, error handling, race conditions, silent failures

**Agent 3: design** — @checklists/design.md
Focus: naming, structure, duplication, complexity, convention adherence

Each agent returns findings as:
\`\`\`
[severity:critical|high|medium|low] file:line — Description. Suggested fix.
\`\`\`

## Phase 3: Judge Filtering (HubSpot 3-Criteria Pattern)

For each finding, evaluate against ALL 3 criteria:

1. **Succinct?** — Is the feedback clear and to the point? (No vague "consider refactoring")
2. **Accurate?** — Is it technically correct within THIS codebase's context?
3. **Actionable?** — Can the fix be applied directly without ambiguity?

Additionally check:
4. **In scope?** — Is this in the current diff, not a pre-existing issue?

**Discard** findings that fail ANY criterion. Log each discard with the failing criterion.

## Phase 4: Output

\`\`\`
## Review: N findings (X critical, Y high)

### Critical
- [file:line] Description + suggested fix

### High
- [file:line] Description + suggested fix

### Medium (informational)
- [file:line] Description

---
Discarded: M findings (reasons: N not actionable, M out of scope, ...)
\`\`\`

If 0 critical and 0 high: "Ready to commit."
If any critical: "Fix critical issues before committing."
`;

const CHECKLIST_SECURITY = `# Security Review Checklist

Review the diff for these security concerns:

## Input Validation
- [ ] User input sanitized before use in queries, commands, file paths
- [ ] No SQL injection (parameterized queries used)
- [ ] No command injection (no shell interpolation of user input)
- [ ] No path traversal (user input not used in file paths without validation)

## Authentication & Authorization
- [ ] Auth checks present where required
- [ ] No auth bypass through error handling paths
- [ ] Session/token handling is correct

## Secrets & Data Exposure
- [ ] No hardcoded secrets, API keys, passwords
- [ ] No sensitive data in logs or error messages
- [ ] No secrets in git (check for .env, credentials files)

## TOCTOU & Race Conditions
- [ ] File operations are atomic where needed
- [ ] No check-then-act patterns with shared resources

## XSS & Output Encoding
- [ ] User-generated content escaped before rendering
- [ ] No innerHTML with untrusted data
`;

const CHECKLIST_LOGIC = `# Logic Review Checklist

Review the diff for these correctness concerns:

## Edge Cases
- [ ] Null/undefined handling (no unchecked access)
- [ ] Empty arrays/strings handled
- [ ] Boundary values (0, -1, MAX_INT, empty string)
- [ ] Concurrent/parallel execution safety

## Error Handling
- [ ] Errors caught and handled appropriately (not silently swallowed)
- [ ] Error messages are helpful for debugging
- [ ] Resources cleaned up in error paths (files, connections, locks)
- [ ] Async errors properly propagated (no unhandled rejections)

## Silent Failures (most dangerous)
- [ ] Could this produce wrong output WITHOUT crashing?
- [ ] Are return values checked (not just try/catch)?
- [ ] Assertions present for critical invariants

## State Management
- [ ] State transitions are valid
- [ ] No stale data used after async operations
- [ ] Side effects are intentional and documented
`;

const CHECKLIST_DESIGN = `# Design Review Checklist

Review the diff for these design concerns:

## Naming & Readability
- [ ] Names clearly describe purpose (no generic "data", "result", "temp")
- [ ] Consistent with existing codebase naming patterns
- [ ] No misleading names (name matches behavior)

## Structure & Complexity
- [ ] Functions under 50 lines (ideally under 30)
- [ ] No deeply nested conditionals (max 3 levels)
- [ ] Single responsibility per function/module

## Duplication
- [ ] No copy-pasted code (DRY)
- [ ] Common patterns extracted to helpers
- [ ] But: 3 similar lines is better than a premature abstraction

## Convention Adherence
- [ ] Matches project's established patterns
- [ ] Import ordering follows convention
- [ ] Error handling style consistent with codebase
- [ ] Test structure matches existing test files
`;

const CONVENTIONS_SKILL_MD = `---
name: alfred-conventions
description: >
  Scan the codebase and discover implicit coding conventions with adoption rates.
  Inspired by codebase-context's approach: detect patterns, measure adoption %,
  identify conflicts. Use on first setup, after major refactors, or to document
  existing patterns. Saves conventions to knowledge DB and generates rules.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(wc *, head *, git log --oneline *, find * -name *)
---

# /alfred:conventions — Convention Discovery

## Step 1: Project Scan

Detect the project stack first:
- Read package.json / go.mod / Cargo.toml / pyproject.toml
- Check config files: tsconfig.json, biome.json, .eslintrc, .editorconfig

## Step 2: Pattern Analysis

For each category, scan 10-15 representative source files and measure adoption:

### 2.1 Import Ordering
- Read source files, categorize import groups
- Detect pattern: stdlib first → external → internal? Alphabetical? Other?
- Report adoption %

### 2.2 Naming Conventions
- Files: kebab-case? camelCase? snake_case? (glob + count)
- Functions/methods: camelCase? snake_case? (grep for function/const declarations)
- Types/interfaces: PascalCase?
- Constants: UPPER_SNAKE_CASE?
- Report adoption % per category

### 2.3 Error Handling
- Grep for try/catch, .catch, Result type, early return patterns
- Dominant pattern and adoption %
- Flag conflicts (e.g., both try-catch and Result used >20%)

### 2.4 Test Structure
- Co-located (src/foo.test.ts) or separate (__tests__/)?
- .test. or .spec.?
- Framework: describe/it/expect or test()?
- Report adoption %

### 2.5 Code Style
- Check configured rules in biome.json / .eslintrc
- Semicolons, quotes, indentation
- Max line length

### 2.6 Architecture
- Directory structure: feature-based or layer-based?
- Module pattern: barrel exports (index.ts)? Direct imports?

## Step 3: Present Findings

For each convention:
\`\`\`
[category] pattern — adoption X% (N/M files)
  Examples: file1.ts, file2.ts, file3.ts
  Conflicts: (if any competing pattern >20%)
\`\`\`

Confidence levels:
- **High** (>80%): Strong convention, should be enforced
- **Medium** (50-80%): Common but not universal
- **Low** (<50%): Emerging or inconsistent

Ask user to confirm/reject each convention.

## Step 4: Save

For confirmed conventions:
1. Call \`alfred save type=convention\` for each with pattern, category, and example_files
2. Generate \`.claude/rules/alfred-conventions.md\` with path-scoped rules
3. Report: "Saved N conventions. Rules file generated."
`;

// ── Layers skeleton generation ──────────────────────────────────────

interface LayersConfig {
	layers: Array<{ name: string; pattern: string }>;
	rules: Array<{ from: string; deny: string[] }>;
}

function generateLayersSkeleton(cwd: string): LayersConfig | null {
	try {
		const srcDir = join(cwd, "src");
		if (!existsSync(srcDir)) return null;

		const entries = readdirSync(srcDir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		if (dirs.length < 2) return null;

		const layers = dirs.map((d) => ({ name: d, pattern: `^src/${d}` }));

		// Default rules: lower layers don't import higher layers
		// Common pattern: types < store < embedder < gates/profile < hooks < mcp < tui < cli
		const layerOrder = ["types", "store", "embedder", "gates", "profile", "hooks", "mcp", "init", "tui", "cli"];
		const rules: Array<{ from: string; deny: string[] }> = [];

		for (const layer of layers) {
			const idx = layerOrder.indexOf(layer.name);
			if (idx < 0) continue;
			const higherLayers = layerOrder.slice(idx + 1).filter((l) => dirs.includes(l));
			if (higherLayers.length > 0) {
				rules.push({ from: layer.name, deny: higherLayers });
			}
		}

		return rules.length > 0 ? { layers, rules } : null;
	} catch {
		return null;
	}
}
