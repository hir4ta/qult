import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-stop-test");
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(join(TEST_DIR, ".qult", ".state"), { recursive: true });
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

describe("subagentStop", () => {
	it("allows normal subagent completion", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			stop_hook_active: false,
		});
		expect(exitCode).toBeNull();
	});

	it("does not block when stop_hook_active is true", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			stop_hook_active: true,
		});
		expect(exitCode).toBeNull();
	});

	it("allows unknown agent_type (fail-open)", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Explore",
			last_assistant_message: "some output",
		});
		expect(exitCode).toBeNull();
	});

	it("allows when last_assistant_message is missing (fail-open)", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-spec-reviewer",
		});
		expect(exitCode).toBeNull();
	});

	it("blocks qult-spec-reviewer with FAIL verdict", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-spec-reviewer",
				last_assistant_message:
					"Spec: FAIL\nScore: Completeness=2 Accuracy=3\n- [critical] plan — Task 1 not implemented",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("FAIL");
	});

	it("allows qult-spec-reviewer with PASS + scores", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("blocks qult-spec-reviewer with no verdict, no score, no findings", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "I looked at the code and it seems fine to me.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("blocks Plan agent when plan file lacks required sections", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "bad-plan.md"), "## Context\n- Do stuff\n- Do more stuff");

		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "Plan",
				last_assistant_message: "I created a plan.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("allows Plan agent when plan file has Tasks section and evaluator done", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "good-plan.md"),
			[
				"## Context",
				"Adding auth",
				"",
				"## Tasks",
				"### Task 1: Add middleware [pending]",
				"- **File**: src/auth.ts",
				"- **Change**: Extract token validation into middleware function with JWT checks",
				"- **Boundary**: Do not modify existing route handlers",
				"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` -- all tests pass",
			].join("\n"),
		);

		const { recordPlanEvalIteration } = await import("../../state/session-state.ts");
		recordPlanEvalIteration(12);

		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Plan",
			last_assistant_message: "I created a plan with tasks and review gates.",
		});
		expect(exitCode).toBeNull();
	});

	it("allows Plan agent when no plan file exists (fail-open)", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Plan",
			last_assistant_message: "I created a plan.",
		});
		expect(exitCode).toBeNull();
	});
});

// --- Level 1: validatePlanStructure ---

describe("validatePlanStructure", () => {
	it("returns no errors for a valid plan", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth middleware.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function",
			"- **Boundary**: Do not modify existing route handlers",
			"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- all tests pass",
		].join("\n");
		expect(validatePlanStructure(plan)).toEqual([]);
	});

	it("reports missing ## Context", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function",
			"- **Boundary**: Do not modify existing route handlers",
			"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- all tests pass",
		].join("\n");
		const errors = validatePlanStructure(plan);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("Context"))).toBe(true);
	});

	it("reports missing ## Tasks", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = "## Context\nDoing stuff\n\n## Success Criteria\n- [ ] `test` -- pass";
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => e.includes("Tasks"))).toBe(true);
	});

	it("reports zero task entries", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = "## Context\nDoing stuff\n\n## Tasks\n\n## Success Criteria\n- [ ] `test` -- pass";
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => /task/i.test(e))).toBe(true);
	});

	it("reports more than 15 tasks", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const tasks = Array.from(
			{ length: 16 },
			(_, i) =>
				`### Task ${i + 1}: Thing ${i + 1} [pending]\n- **File**: f.ts\n- **Change**: do\n- **Boundary**: none\n- **Verify**: t.ts:fn`,
		).join("\n");
		const plan = `## Context\nBig plan\n\n## Tasks\n${tasks}\n\n## Success Criteria\n- [ ] \`test\` -- pass`;
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => /15/i.test(e))).toBe(true);
	});

	it("reports missing task fields", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation",
			// Missing Boundary and Verify
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- all tests pass",
		].join("\n");
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => e.includes("Boundary"))).toBe(true);
		expect(errors.some((e) => e.includes("Verify"))).toBe(true);
	});

	it("reports missing ## Success Criteria", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function",
			"- **Boundary**: Do not modify existing route handlers",
			"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
		].join("\n");
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => e.includes("Success Criteria"))).toBe(true);
	});

	it("reports Success Criteria without backtick command", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function",
			"- **Boundary**: Do not modify existing route handlers",
			"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
			"",
			"## Success Criteria",
			"- [ ] All tests should pass",
		].join("\n");
		const errors = validatePlanStructure(plan);
		expect(errors.some((e) => /command|backtick/i.test(e))).toBe(true);
	});
	it("handles Tasks as last section (no ## after it)", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding feature.",
			"",
			"## Tasks",
			"### Task 1: Add widget [pending]",
			"- **File**: src/widget.ts",
			"- **Change**: Create widget component",
			"- **Boundary**: Do not touch existing components",
			"- **Verify**: src/__tests__/widget.test.ts:testWidget",
		].join("\n");
		const errors = validatePlanStructure(plan);
		// Should report missing Success Criteria, but NOT crash on missing next section
		expect(errors.some((e) => /Success Criteria/i.test(e))).toBe(true);
		// Should still parse the task fields correctly (no missing field errors)
		expect(errors.some((e) => /missing required field/i.test(e))).toBe(false);
	});

	it("handles Tasks section header with no trailing newline", async () => {
		const { validatePlanStructure } = await import("../subagent-stop/index.ts");
		const plan =
			"## Context\nWhy.\n\n## Tasks\n### Task 1: Do thing [pending]\n- **File**: a.ts\n- **Change**: something\n- **Boundary**: nothing\n- **Verify**: a.test.ts:test1\n\n## Success Criteria\n- [ ] `bun test` passes";
		const errors = validatePlanStructure(plan);
		expect(errors).toHaveLength(0);
	});
});

// --- Level 2: validatePlanHeuristics ---

describe("validatePlanHeuristics", () => {
	it("returns no warnings for a well-formed plan", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function with JWT verification",
			"- **Boundary**: Do not modify existing route handlers",
			"- **Verify**: src/__tests__/auth.test.ts:testMiddleware",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- all tests pass",
		].join("\n");
		expect(validatePlanHeuristics(plan)).toEqual([]);
	});

	it("flags vague Change field (single verb + short object)", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Fixing auth.",
			"",
			"## Tasks",
			"### Task 1: Fix auth [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Fix the auth module",
			"- **Boundary**: none",
			"- **Verify**: src/__tests__/auth.test.ts:testAuth",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.some((w) => /vague|Change/i.test(w))).toBe(true);
	});

	it("allows specific Change field starting with vague verb", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Improving auth.",
			"",
			"## Tasks",
			"### Task 1: Improve auth [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Improve auth by adding rate limiting with exponential backoff and Redis-based token bucket",
			"- **Boundary**: none",
			"- **Verify**: src/__tests__/auth.test.ts:testRateLimit",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.filter((w) => /vague|Change/i.test(w))).toEqual([]);
	});

	it("flags invalid Verify format (no colon separator)", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding auth.",
			"",
			"## Tasks",
			"### Task 1: Add middleware [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Extract token validation into middleware function with JWT verification",
			"- **Boundary**: Do not modify route handlers",
			"- **Verify**: manual testing",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.some((w) => /Verify/i.test(w))).toBe(true);
	});

	it("flags registry file without consumer file in plan", async () => {
		// Write config with registry_files to enable the check
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ plan_eval: { registry_files: ["session-state.ts", "types.ts"] } }),
		);
		resetAllCaches();

		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding new state field.",
			"",
			"## Tasks",
			"### Task 1: Add field to session-state [pending]",
			"- **File**: src/state/session-state.ts",
			"- **Change**: Add plan_eval_iteration field to SessionState interface and defaultState",
			"- **Boundary**: Do not modify existing fields",
			"- **Verify**: src/__tests__/session-state.test.ts:testNewField",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.some((w) => /consumer/i.test(w))).toBe(true);
	});

	it("allows specific Change with many words even starting with vague verb", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Refactoring.",
			"",
			"## Tasks",
			"### Task 1: Refactor auth [pending]",
			"- **File**: src/auth.ts",
			"- **Change**: Refactor by extracting token refresh logic into a separate refreshToken function with exponential backoff",
			"- **Boundary**: none",
			"- **Verify**: src/__tests__/auth.test.ts:testRefresh",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.filter((w) => /vague|Change/i.test(w))).toEqual([]);
	});

	it("passes when registry file has consumer file in another task", async () => {
		const { validatePlanHeuristics } = await import("../subagent-stop/index.ts");
		const plan = [
			"## Context",
			"Adding new state field.",
			"",
			"## Tasks",
			"### Task 1: Add field to session-state [pending]",
			"- **File**: src/state/session-state.ts",
			"- **Change**: Add plan_eval_iteration field to SessionState interface and defaultState",
			"- **Boundary**: Do not modify existing fields",
			"- **Verify**: src/__tests__/session-state.test.ts:testNewField",
			"",
			"### Task 2: Update subagent-stop to use new field [pending]",
			"- **File**: src/hooks/subagent-stop.ts",
			"- **Change**: Use plan_eval_iteration in plan-evaluator handling",
			"- **Boundary**: Do not modify reviewer handling",
			"- **Verify**: src/hooks/__tests__/subagent-stop.test.ts:testPlanEval",
			"",
			"## Success Criteria",
			"- [ ] `bun vitest run` -- pass",
		].join("\n");
		const warnings = validatePlanHeuristics(plan);
		expect(warnings.filter((w) => /consumer/i.test(w))).toEqual([]);
	});
});

// --- Level 3: plan-evaluator SubagentStop handling ---

describe("plan-evaluator SubagentStop", () => {
	it("allows qult-plan-evaluator with PASS and high scores", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-plan-evaluator",
			last_assistant_message:
				"Plan: PASS\nScore: Feasibility=5 Completeness=4 Clarity=4\n\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("blocks qult-plan-evaluator with REVISE verdict", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-plan-evaluator",
				last_assistant_message:
					"Plan: REVISE\nScore: Feasibility=2 Completeness=3 Clarity=4\n\n- [critical] Task 1 — references non-existent file\nFix: check file path",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("REVISE");
	});

	it("blocks qult-plan-evaluator with PASS but low aggregate score", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-plan-evaluator",
				last_assistant_message:
					"Plan: PASS\nScore: Feasibility=3 Completeness=3 Clarity=3\n\n- [medium] Task 2 — vague Change\nFix: be specific",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below threshold");
	});

	it("blocks qult-plan-evaluator with malformed output", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-plan-evaluator",
				last_assistant_message: "The plan looks good, I recommend proceeding.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("allows qult-plan-evaluator with borderline score (exactly at threshold)", async () => {
		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-plan-evaluator",
			last_assistant_message:
				"Plan: PASS\nScore: Feasibility=4 Completeness=3 Clarity=3\n\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("parses plan-evaluator scores with colon format", async () => {
		const { parseDimensionScores } = await import("../subagent-stop/index.ts");
		const output = "Score: Feasibility: 4, Completeness: 3, Clarity: 5";
		const scores = parseDimensionScores(output, ["Feasibility", "Completeness", "Clarity"]);
		expect(scores).toEqual({ Feasibility: 4, Completeness: 3, Clarity: 5 });
	});
});

describe("score distribution bias detection", () => {
	it("warns on identical scores across all 6 dimensions", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=4 Accuracy=4\nNo issues found.",
		});
		await handler({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		await handler({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=4\nNo issues found.",
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("scored identically");
		expect(stderr).toContain("template answers");
	});

	it("warns on low variance scores (max-min < 2)", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=4 Accuracy=5\nNo issues found.",
		});
		await handler({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		await handler({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=5\nNo issues found.",
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("low variance");
	});

	it("does not warn on well-distributed scores", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const handler = (await import("../subagent-stop/index.ts")).default;
		await handler({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=3\nNo issues found.",
		});
		await handler({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=5\nNo issues found.",
		});
		await handler({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=4\nNo issues found.",
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("identically");
		expect(stderr).not.toContain("low variance");
	});
});
