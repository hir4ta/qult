import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-stop-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stderrCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCode = code as number;
		throw new Error(`process.exit(${code})`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- Unit tests ---

import {
	buildPlanEvalBlockMessage,
	buildReviewBlockMessage,
	parseDimensionScores,
	parseScores,
	validatePlanHeuristics,
	validatePlanStructure,
} from "../hooks/subagent-stop.ts";

describe("parseScores", () => {
	it("parses strict format", () => {
		const result = parseScores("Score: Correctness=4 Design=5 Security=3");
		expect(result).not.toBeNull();
		expect(result).toEqual({ correctness: 4, design: 5, security: 3 });
	});

	it("parses colon format", () => {
		const result = parseScores("Correctness: 4, Design: 5, Security: 3");
		expect(result).not.toBeNull();
		expect(result).toEqual({ correctness: 4, design: 5, security: 3 });
	});

	it("parses loose format (Score: with 3 digits)", () => {
		const result = parseScores("Score: =4 =5 =3");
		expect(result).not.toBeNull();
		expect(result).toEqual({ correctness: 4, design: 5, security: 3 });
	});

	it("returns null on invalid input (no scores)", () => {
		const result = parseScores("This has no scores at all");
		expect(result).toBeNull();
		expect(parseScores("Score: only one =4")).toBeNull();
	});

	it("returns null on empty string", () => {
		const result = parseScores("");
		expect(result).toBeNull();
		expect(parseScores("   ")).toBeNull();
	});
});

describe("parseDimensionScores", () => {
	const dims = ["Feasibility", "Completeness", "Clarity"];

	it("parses plan eval strict format", () => {
		const result = parseDimensionScores("Score: Feasibility=4 Completeness=5 Clarity=3", dims);
		expect(result).not.toBeNull();
		expect(result).toEqual({ Feasibility: 4, Completeness: 5, Clarity: 3 });
	});

	it("parses colon format", () => {
		const result = parseDimensionScores("Feasibility: 4, Completeness: 5, Clarity: 3", dims);
		expect(result).not.toBeNull();
		expect(result).toEqual({ Feasibility: 4, Completeness: 5, Clarity: 3 });
	});

	it("returns null on invalid input", () => {
		const result = parseDimensionScores("No dimension scores here", dims);
		expect(result).toBeNull();
		expect(parseDimensionScores("", dims)).toBeNull();
	});
});

describe("buildReviewBlockMessage", () => {
	it("first iteration mentions weakest dimension", () => {
		const scores = { correctness: 3, design: 4, security: 2 };
		const msg = buildReviewBlockMessage(scores, [9], 9, 12, 1, 3);
		expect(msg).toContain("Weakest dimension");
		expect(msg).toContain("Security (2/5)");
	});

	it("improving trend mentions score improved with previous→current", () => {
		const scores = { correctness: 4, design: 4, security: 3 };
		const msg = buildReviewBlockMessage(scores, [9, 11], 11, 12, 2, 3);
		expect(msg).toContain("improved");
		expect(msg).toContain("9→11");
	});

	it("regressing trend mentions regressed and revert", () => {
		const scores = { correctness: 3, design: 3, security: 2 };
		const msg = buildReviewBlockMessage(scores, [10, 8], 8, 12, 2, 3);
		expect(msg).toContain("regressed");
		expect(msg).toContain("revert");
	});

	it("stagnant (2+ iterations same score) mentions stuck and fundamentally different", () => {
		const scores = { correctness: 3, design: 3, security: 3 };
		const msg = buildReviewBlockMessage(scores, [9, 9], 9, 12, 2, 3);
		expect(msg).toContain("stuck");
		expect(msg).toContain("fundamentally different");
	});
});

describe("buildPlanEvalBlockMessage", () => {
	it("first iteration mentions weakest dimension", () => {
		const dims = { Feasibility: 4, Completeness: 2, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [9], 9, 10, 1, 2);
		expect(msg).toContain("Weakest dimension");
		expect(msg).toContain("Completeness (2/5)");
	});

	it("improving trend mentions improved", () => {
		const dims = { Feasibility: 4, Completeness: 3, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [8, 10], 10, 12, 2, 3);
		expect(msg).toContain("improved");
		expect(msg).toContain("8→10");
	});

	it("regressing trend mentions regressed and revert", () => {
		const dims = { Feasibility: 3, Completeness: 2, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [10, 8], 8, 12, 2, 3);
		expect(msg).toContain("regressed");
		expect(msg).toContain("revert");
	});

	it("stagnant mentions stuck", () => {
		const dims = { Feasibility: 3, Completeness: 3, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [9, 9], 9, 12, 2, 3);
		expect(msg).toContain("stuck");
		expect(msg).toContain("restructure");
	});
});

describe("validatePlanStructure", () => {
	const validPlan = `## Context
Why this change is needed.

## Tasks
### Task 1: Add feature [pending]
- **File**: src/foo.ts
- **Change**: Add the new feature
- **Boundary**: Don't touch bar.ts
- **Verify**: foo.test.ts:testFeature

## Success Criteria
- [ ] \`bun vitest run\` -- all tests pass
`;

	it("valid plan passes with no errors", () => {
		const errors = validatePlanStructure(validPlan);
		expect(errors).toHaveLength(0);
		expect(errors).toEqual([]);
	});

	it("reports missing ## Context", () => {
		const plan = validPlan.replace("## Context", "## Background");
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Context"))).toBe(true);
	});

	it("reports missing ## Tasks", () => {
		const plan = validPlan.replace("## Tasks", "## Work Items");
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Tasks"))).toBe(true);
	});

	it("reports missing ## Success Criteria", () => {
		const plan = validPlan.replace("## Success Criteria", "## Done When");
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Success Criteria"))).toBe(true);
	});

	it("reports task missing required field", () => {
		const plan = validPlan.replace("- **Verify**: foo.test.ts:testFeature\n", "");
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Verify"))).toBe(true);
	});

	it("reports too many tasks (>15)", () => {
		const tasks = Array.from(
			{ length: 16 },
			(_, i) => `### Task ${i + 1}: Task ${i + 1} [pending]
- **File**: src/f${i}.ts
- **Change**: Do thing ${i}
- **Boundary**: None
- **Verify**: f${i}.test.ts:test${i}
`,
		).join("\n");
		const plan = `## Context\nReason.\n\n## Tasks\n${tasks}\n## Success Criteria\n- [ ] \`bun test\` -- pass\n`;
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Too many tasks"))).toBe(true);
	});

	it("reports Tasks section with no ### Task entries", () => {
		const plan = `## Context
Reason.

## Tasks
Some text but no task headers.

## Success Criteria
- [ ] \`bun test\` -- pass
`;
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("no task entries"))).toBe(true);
	});
});

describe("validatePlanHeuristics", () => {
	const validPlan = `## Context
Why this change is needed.

## Tasks
### Task 1: Add timeout support [pending]
- **File**: src/foo.ts
- **Change**: Add a timeout parameter to the execute function with default 5000ms
- **Boundary**: Don't touch bar.ts
- **Verify**: foo.test.ts:testTimeout

## Success Criteria
- [ ] \`bun vitest run\` -- all tests pass
`;

	it("valid plan has no warnings", () => {
		const warnings = validatePlanHeuristics(validPlan);
		expect(warnings).toHaveLength(0);
		expect(warnings).toEqual([]);
	});

	it("vague change field triggers warning", () => {
		const plan = validPlan.replace(
			"Add a timeout parameter to the execute function with default 5000ms",
			"Fix errors",
		);
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("vague"))).toBe(true);
	});

	it("invalid Verify format (no colon separator) triggers warning", () => {
		const plan = validPlan.replace("foo.test.ts:testTimeout", "run the tests");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("Verify"))).toBe(true);
	});

	it("registry file without consumer triggers warning", () => {
		const plan = validPlan.replace("src/foo.ts", "src/types.ts");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("registry file") || w.includes("consumer"))).toBe(true);
	});

	it("verbose enough change field with vague verb does not trigger", () => {
		const plan = validPlan.replace(
			"Add a timeout parameter to the execute function with default 5000ms",
			"Update the SessionState interface to add timeout field for gate execution",
		);
		const warnings = validatePlanHeuristics(plan);
		const vagueWarnings = warnings.filter((w) => w.includes("vague"));
		expect(vagueWarnings).toHaveLength(0);
		expect(vagueWarnings.length).toBe(0);
	});
});

// --- Integration tests ---

describe("subagentStop: integration", () => {
	it("unknown agent_type: no exit (fail-open)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "unknown-agent",
			last_assistant_message: "Some output",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("no output: no exit (fail-open)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: "",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("stop_hook_active: no exit (short-circuit)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message: "Review: FAIL\n[critical] src/foo.ts:1 Bad code",
				stop_hook_active: true,
			}),
		).resolves.toBeUndefined();
		expect(exitCode).toBeNull();
	});

	it("qult-reviewer with FAIL verdict: blocks with exit 2", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message:
					"Review: FAIL\n[critical] src/foo.ts:1 Bad code\nScore: Correctness=2 Design=2 Security=1",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("FAIL");
	});

	it("qult-reviewer with PASS + high score (>=12): allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message:
				"Review: PASS\nNo issues found\nScore: Correctness=5 Design=4 Security=4",
		});
		expect(exitCode).toBeNull();

		const { readSessionState } = await import("../state/session-state.ts");
		const state = readSessionState();
		expect(state.review_completed_at).toBeTruthy();
	});

	it("qult:reviewer (colon format from plugin) works identically", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult:reviewer",
			last_assistant_message:
				"Review: PASS\nNo issues found\nScore: Correctness=5 Design=4 Security=4",
		});
		expect(exitCode).toBeNull();

		const { readSessionState } = await import("../state/session-state.ts");
		const state = readSessionState();
		expect(state.review_completed_at).toBeTruthy();
	});

	it("qult-reviewer with PASS + low score (<12): blocks for iteration", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message:
					"Review: PASS\nNo issues found\nScore: Correctness=3 Design=3 Security=3",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below threshold");
	});

	it("qult-reviewer with invalid output (no verdict/score/findings): blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message: "I looked at the code and it seems fine overall.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Reviewer output must include");
	});

	it("qult-plan-evaluator with REVISE: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-plan-evaluator",
				last_assistant_message:
					"Plan: REVISE\nScore: Feasibility=3 Completeness=2 Clarity=3\n[high] Missing boundary definitions",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("REVISE");
	});

	it("qult-plan-evaluator with PASS + high score: allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-plan-evaluator",
			last_assistant_message:
				"Plan: PASS\nScore: Feasibility=5 Completeness=5 Clarity=4\nNo issues found",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("qult-plan-evaluator with invalid output: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-plan-evaluator",
				last_assistant_message: "The plan looks good to me.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Plan evaluator output must include");
	});

	it("Plan agent with valid plan structure: allows", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "plan-001.md"),
			`## Context
Why this change is needed.

## Tasks
### Task 1: Add feature [pending]
- **File**: src/foo.ts
- **Change**: Add the new feature with proper error handling
- **Boundary**: Don't touch bar.ts
- **Verify**: foo.test.ts:testFeature

## Success Criteria
- [ ] \`bun vitest run\` -- all tests pass
`,
		);

		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "Plan",
			last_assistant_message: "Plan created successfully.",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("Plan agent with invalid plan (missing sections): blocks", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "plan-002.md"),
			`## Tasks
### Task 1: Do something [pending]
- **File**: src/foo.ts
- **Change**: Do something

## Success Criteria
- [ ] \`bun test\` -- pass
`,
		);

		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await expect(
			subagentStop({
				agent_type: "Plan",
				last_assistant_message: "Plan created.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("structural issues");
	});
});
