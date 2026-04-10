import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-stop-test");

function setProjectConfig(config: Record<string, unknown>): void {
	const db = getDb();
	const projectId = getProjectId();
	const stmt = db.prepare(
		"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
	);
	function flatten(obj: Record<string, unknown>, prefix = ""): void {
		for (const [k, v] of Object.entries(obj)) {
			const key = prefix ? `${prefix}.${k}` : k;
			if (v !== null && typeof v === "object" && !Array.isArray(v)) {
				flatten(v as Record<string, unknown>, key);
			} else {
				stmt.run(projectId, key, JSON.stringify(v));
			}
		}
	}
	flatten(config);
}
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	// Create dummy source files for claim grounding (file existence check)
	mkdirSync(join(TEST_DIR, "src"), { recursive: true });
	for (const name of [
		"foo.ts",
		"a.ts",
		"b.ts",
		"c.ts",
		"d.ts",
		"e.ts",
		"f.ts",
		"g.ts",
		"h.ts",
		"api.ts",
		"types.ts",
	]) {
		writeFileSync(join(TEST_DIR, "src", name), "// dummy");
	}
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
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- Unit tests ---

import {
	buildPlanEvalBlockMessage,
	buildReviewBlockMessage,
	parseDimensionScores,
	parseQualityScores,
	parseScores,
	parseSecurityScores,
	parseSpecScores,
	validatePlanHeuristics,
	validatePlanStructure,
} from "../hooks/subagent-stop/index.ts";

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

	it("parses dimensions in any order", () => {
		const result = parseScores("Design=5 Security=3 Correctness=4");
		expect(result).not.toBeNull();
		expect(result).toEqual({ correctness: 4, design: 5, security: 3 });
	});

	it("rejects nameless scores (no dimension names)", () => {
		expect(parseScores("Score: =4 =5 =3")).toBeNull();
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

	it("returns null if any dimension out of range", () => {
		expect(parseScores("Correctness=6 Design=5 Security=3")).toBeNull();
		expect(parseScores("Correctness=0 Design=5 Security=3")).toBeNull();
	});

	it("parses mixed = and : separators", () => {
		const result = parseScores("Correctness: 4, Design=5, Security: 3");
		expect(result).not.toBeNull();
		expect(result).toEqual({ correctness: 4, design: 5, security: 3 });
	});

	it("rejects partial dimensions", () => {
		expect(parseScores("Correctness=4 Design=5")).toBeNull();
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

	it("parses dimensions in any order", () => {
		const result = parseDimensionScores("Clarity=3 Feasibility: 4, Completeness=5", dims);
		expect(result).not.toBeNull();
		expect(result).toEqual({ Feasibility: 4, Completeness: 5, Clarity: 3 });
	});

	it("rejects partial dimensions", () => {
		expect(parseDimensionScores("Feasibility=4 Completeness=5", dims)).toBeNull();
	});
});

describe("parseSpecScores", () => {
	it("parses spec reviewer format", () => {
		const result = parseSpecScores("Score: Completeness=4 Accuracy=5");
		expect(result).toEqual({ completeness: 4, accuracy: 5 });
	});

	it("returns null on missing dimension", () => {
		expect(parseSpecScores("Score: Completeness=4")).toBeNull();
	});

	it("returns null on empty string", () => {
		expect(parseSpecScores("")).toBeNull();
	});
});

describe("parseQualityScores", () => {
	it("parses quality reviewer format", () => {
		const result = parseQualityScores("Score: Design=3 Maintainability=4");
		expect(result).toEqual({ design: 3, maintainability: 4 });
	});

	it("returns null on missing dimension", () => {
		expect(parseQualityScores("Score: Design=3")).toBeNull();
	});
});

describe("parseSecurityScores", () => {
	it("parses security reviewer format", () => {
		const result = parseSecurityScores("Score: Vulnerability=5 Hardening=4");
		expect(result).toEqual({ vulnerability: 5, hardening: 4 });
	});

	it("returns null on missing dimension", () => {
		expect(parseSecurityScores("Score: Vulnerability=5")).toBeNull();
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

	it("Go-style TestXxx verify format does not trigger warning", () => {
		const plan = validPlan.replace("foo.test.ts:testTimeout", "TestHandleTimeout");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.filter((w) => w.includes("Verify"))).toHaveLength(0);
	});

	it("Python-style test_xxx verify format does not trigger warning", () => {
		const plan = validPlan.replace("foo.test.ts:testTimeout", "test_handle_timeout");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.filter((w) => w.includes("Verify"))).toHaveLength(0);
	});

	it("vague change with 7 words still triggers warning (threshold is 8)", () => {
		const plan = validPlan.replace(
			"Add a timeout parameter to the execute function with default 5000ms",
			"Fix the bug in session state",
		);
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.some((w) => w.includes("vague"))).toBe(true);
	});

	it("registry file without consumer triggers warning", () => {
		// Write config with registry_files to enable the check
		setProjectConfig({ plan_eval: { registry_files: ["types.ts", "session-state.ts"] } });
		resetAllCaches();

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
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "unknown-agent",
			last_assistant_message: "Some output",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("no output from known reviewer: blocks (not fail-open)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		try {
			await subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "",
			});
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("empty output");
	});

	it("no output from unknown agent: no exit (fail-open)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "unknown-agent",
			last_assistant_message: "",
		});
		expect(exitCode).toBeNull();
	});

	it("stop_hook_active: no exit (short-circuit)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "Spec: FAIL\n[critical] plan — Task 1 not implemented",
				stop_hook_active: true,
			}),
		).resolves.toBeUndefined();
		expect(exitCode).toBeNull();
	});

	it("qult-plan-evaluator with REVISE: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
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
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-plan-evaluator",
			last_assistant_message:
				"Plan: PASS\nScore: Feasibility=5 Completeness=5 Clarity=4\nNo issues found",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("qult-plan-evaluator with invalid output: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-plan-evaluator",
				last_assistant_message: "The plan looks good to me.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Plan evaluator output must include");
	});

	it("Plan agent with valid plan structure and evaluator done: allows", async () => {
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

		// Mark plan-evaluator as having run
		const { recordPlanEvalIteration } = await import("../state/session-state.ts");
		recordPlanEvalIteration(12);

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "Plan",
			last_assistant_message: "Plan created successfully.",
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("Plan agent without plan-evaluator: blocks", async () => {
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

		// No recordPlanEvalIteration call — evaluator never ran

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "Plan",
				last_assistant_message: "Plan created successfully.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("not been evaluated");
	});

	// --- 3-stage review agents ---

	it("qult-spec-reviewer with PASS: allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("qult-spec-reviewer with FAIL: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message:
					"Spec: FAIL\nScore: Completeness=2 Accuracy=3\n[critical] plan — Task 1 not implemented",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Spec: FAIL");
	});

	it("qult-quality-reviewer with PASS: allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=5\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("qult-quality-reviewer with FAIL: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-quality-reviewer",
				last_assistant_message:
					"Quality: FAIL\nScore: Design=2 Maintainability=3\n[critical] Mixed concerns in handler",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Quality: FAIL");
	});

	it("qult-security-reviewer with PASS: allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=5 Hardening=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("qult-security-reviewer with FAIL: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: FAIL\nScore: Vulnerability=1 Hardening=2\n[critical] SQL injection in user input handler",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Security: FAIL");
	});

	it("qult-spec-reviewer with PASS but dimension below floor: blocks", async () => {
		setProjectConfig({ review: { dimension_floor: 3 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "Spec: PASS\nScore: Completeness=2 Accuracy=5\nNo issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below minimum");
		expect(stderrCapture.join("")).toContain("Completeness");
	});

	it("qult-security-reviewer with PASS but dimension below floor: blocks", async () => {
		setProjectConfig({ review: { dimension_floor: 3 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: PASS\nScore: Vulnerability=2 Hardening=4\nNo issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below minimum");
		expect(stderrCapture.join("")).toContain("Vulnerability");
	});

	it("qult-quality-reviewer with PASS and all dimensions at floor: allows", async () => {
		setProjectConfig({ review: { dimension_floor: 3 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message:
				"Quality: PASS\nScore: Design=3 Maintainability=4\n- [low] src/foo.ts — minor design issue",
		});
		expect(exitCode).toBeNull();
	});

	it("qult-spec-reviewer with invalid output: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "The implementation looks correct to me.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Spec reviewer output must include");
	});

	it("qult:spec-reviewer (colon format) works identically", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult:spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=5\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	// --- 3-stage aggregate score tests ---

	it("4-stage review: aggregate below threshold after adversarial-reviewer blocks", async () => {
		setProjectConfig({ review: { score_threshold: 32, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Stage 1: Spec PASS with low scores (findings required for < 4)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message:
				"Spec: PASS\nScore: Completeness=3 Accuracy=3\n- [low] src/a.ts — gap\n- [low] src/b.ts — gap",
		});
		expect(exitCode).toBeNull();

		// Stage 2: Quality PASS with low scores
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message:
				"Quality: PASS\nScore: Design=3 Maintainability=3\n- [low] src/c.ts — issue\n- [low] src/d.ts — issue",
		});
		expect(exitCode).toBeNull();

		// Stage 3: Security PASS
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=3\n- [low] src/e.ts — weak\n- [low] src/f.ts — weak",
		});
		expect(exitCode).toBeNull();

		// Stage 4: Adversarial PASS — aggregate = 8*3 = 24 < 32
		await expect(
			subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message:
					"Adversarial: PASS\nScore: EdgeCases=3 LogicCorrectness=3\n- [low] src/g.ts — edge case\n- [low] src/h.ts — logic",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("24/40");
		expect(stderrCapture.join("")).toContain("below threshold");
	});

	it("4-stage review: aggregate at threshold after adversarial-reviewer allows", async () => {
		setProjectConfig({ review: { score_threshold: 32 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Stage 1: Spec PASS
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=4 Accuracy=4\nNo issues found.",
		});

		// Stage 2: Quality PASS
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});

		// Stage 3: Security PASS
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=4\nNo issues found.",
		});

		// Stage 4: Adversarial PASS — aggregate = 8*4 = 32 >= 32
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message:
				"Adversarial: PASS\nScore: EdgeCases=4 LogicCorrectness=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("4-stage review: stage scores are cleared after successful aggregate", async () => {
		setProjectConfig({ review: { score_threshold: 32 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Complete all 4 stages with passing scores
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=5\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=5 Hardening=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message:
				"Adversarial: PASS\nScore: EdgeCases=4 LogicCorrectness=4\nNo issues found.",
		});

		// Verify stage scores are cleared (next review starts fresh)
		const { readSessionState } = await import("../state/session-state.ts");
		const state = readSessionState();
		expect(state.review_stage_scores).toEqual({});
	});

	// --- Score-findings consistency tests ---

	describe("scoresFindingsConsistency", () => {
		it("all 5/5 with 'No issues found' declaration: allows", async () => {
			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=5\nNo issues found.",
			});
			expect(exitCode).toBeNull();
		});

		it("all 5/5 with no findings and no declaration: blocks", async () => {
			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await expect(
				subagentStop({
					agent_type: "qult-spec-reviewer",
					last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=5",
				}),
			).rejects.toThrow("process.exit");
			expect(exitCode).toBe(2);
			expect(stderrCapture.join("")).toContain("Perfect scores require");
		});

		it("low score without findings: blocks", async () => {
			// dimension_floor=1 to isolate evidence-based scoring test
			setProjectConfig({ review: { dimension_floor: 1 } });
			resetAllCaches();

			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await expect(
				subagentStop({
					agent_type: "qult-quality-reviewer",
					last_assistant_message: "Quality: PASS\nScore: Design=3 Maintainability=5",
				}),
			).rejects.toThrow("process.exit");
			expect(exitCode).toBe(2);
			expect(stderrCapture.join("")).toContain("scored below 4/5 but no findings cited");
		});

		it("critical finding with high scores: blocks", async () => {
			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await expect(
				subagentStop({
					agent_type: "qult-quality-reviewer",
					last_assistant_message:
						"Quality: PASS\nScore: Design=5 Maintainability=5\n[critical] src/foo.ts:10 — duplicated logic across modules",
				}),
			).rejects.toThrow("process.exit");
			expect(exitCode).toBe(2);
			expect(stderrCapture.join("")).toContain("Reconcile findings with scores");
		});

		it("high finding with high scores: blocks", async () => {
			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await expect(
				subagentStop({
					agent_type: "qult-security-reviewer",
					last_assistant_message:
						"Security: PASS\nScore: Vulnerability=4 Hardening=5\n[high] src/api.ts:20 — missing input validation",
				}),
			).rejects.toThrow("process.exit");
			expect(exitCode).toBe(2);
			expect(stderrCapture.join("")).toContain("Reconcile findings with scores");
		});

		it("medium finding with high scores: allows", async () => {
			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message:
					"Spec: PASS\nScore: Completeness=5 Accuracy=5\n[medium] docs could be improved",
			});
			expect(exitCode).toBeNull();
		});

		it("critical finding with low scores: allows (consistent)", async () => {
			setProjectConfig({ review: { dimension_floor: 1 } });
			resetAllCaches();

			const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
			await subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message:
					"Spec: PASS\nScore: Completeness=2 Accuracy=2\n[critical] major gap in implementation",
			});
			expect(exitCode).toBeNull();
		});
	});

	// ── Adversarial reviewer ──────────────────────────────

	it("qult-adversarial-reviewer with PASS: allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message:
				"Adversarial: PASS\nScore: EdgeCases=4 LogicCorrectness=5\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("qult-adversarial-reviewer with FAIL: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message:
					"Adversarial: FAIL\nScore: EdgeCases=2 LogicCorrectness=3\n- [high] src/foo.ts:10 — off-by-one in loop",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("FAIL");
	});

	it("qult-adversarial-reviewer with empty output: blocks", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message: "",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("empty output");
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

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
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

// --- Claim grounding integration tests ---

describe("claim grounding in SubagentStop", () => {
	it("blocks reviewer with nonexistent file reference", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		const output = [
			"Spec: PASS",
			"Score: Completeness=5 Accuracy=5",
			"[medium] src/nonexistent-file.ts:10 — missing validation",
			"No issues found",
		].join("\n");

		await expect(
			subagentStop({
				agent_type: "qult:spec-reviewer",
				last_assistant_message: output,
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("ungrounded");
		expect(stderrCapture.join("")).toContain("src/nonexistent-file.ts");
	});

	it("allows reviewer when referenced files exist", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src", "real-file.ts"), "export function validate() {}");

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		const output = [
			"Spec: PASS",
			"Score: Completeness=5 Accuracy=5",
			"[medium] src/real-file.ts:1 — `validate` should check bounds",
		].join("\n");

		// Should not throw (or throw for aggregate check, not grounding)
		try {
			await subagentStop({
				agent_type: "qult:spec-reviewer",
				last_assistant_message: output,
			});
		} catch (_e) {
			// May throw for aggregate check or other reasons, but not for grounding
			if (stderrCapture.join("").includes("ungrounded")) {
				throw new Error("Should not block for grounding when file exists");
			}
		}
	});
});

// --- Cross-validation integration tests ---

describe("cross-validation in SubagentStop", () => {
	it("blocks on cross-validation contradiction: security no-issues vs detector findings", async () => {
		// Write security-check pending fixes via module
		const { writePendingFixes } = await import("../state/pending-fixes.ts");
		writePendingFixes([
			{ file: "src/foo.ts", errors: ["L10: Hardcoded API key"], gate: "security-check" },
		]);

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		const output = ["Security: PASS", "Score: Vulnerability=5 Hardening=5", "No issues found"].join(
			"\n",
		);

		await expect(
			subagentStop({
				agent_type: "qult:security-reviewer",
				last_assistant_message: output,
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("contradiction");
		expect(stderrCapture.join("")).toContain("security-check");
	});
});

// Read-only uncommitted change detection is tested in subagent-stop-readonly.test.ts
