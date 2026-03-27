import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../doctor.ts";

const TEST_HOME = join(import.meta.dirname, ".tmp-doctor-test-home");
const TEST_PROJECT = join(import.meta.dirname, ".tmp-doctor-test-project");
const originalCwd = process.cwd();
const originalHome = process.env.HOME;

/** Set up a fully valid qult environment (init-equivalent) */
function setupValidEnv(): void {
	// ~/.claude/settings.json with 12 hooks
	const claudeDir = join(TEST_HOME, ".claude");
	mkdirSync(claudeDir, { recursive: true });

	const { QULT_HOOKS } = require("../../src/init.ts");
	const hooks: Record<string, unknown> = {};
	for (const event of Object.keys(QULT_HOOKS)) {
		hooks[event] = QULT_HOOKS[event];
	}
	writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks }));

	// skill
	mkdirSync(join(claudeDir, "skills", "qult-review"), { recursive: true });
	writeFileSync(join(claudeDir, "skills", "qult-review", "SKILL.md"), "# review skill");

	// agent
	mkdirSync(join(claudeDir, "agents"), { recursive: true });
	writeFileSync(join(claudeDir, "agents", "qult-reviewer.md"), "# reviewer agent");

	// rules
	mkdirSync(join(claudeDir, "rules"), { recursive: true });
	writeFileSync(join(claudeDir, "rules", "qult-quality.md"), "# quality rules");

	// .qult/gates.json with on_write
	const qultDir = join(TEST_PROJECT, ".qult");
	mkdirSync(join(qultDir, ".state"), { recursive: true });
	writeFileSync(
		join(qultDir, "gates.json"),
		JSON.stringify({
			on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
		}),
	);
}

beforeEach(() => {
	mkdirSync(TEST_HOME, { recursive: true });
	mkdirSync(TEST_PROJECT, { recursive: true });
	process.env.HOME = TEST_HOME;
	process.chdir(TEST_PROJECT);
});

afterEach(() => {
	process.env.HOME = originalHome;
	process.chdir(originalCwd);
	rmSync(TEST_HOME, { recursive: true, force: true });
	rmSync(TEST_PROJECT, { recursive: true, force: true });
});

function findCheck(results: CheckResult[], name: string): CheckResult | undefined {
	return results.find((r) => r.name === name);
}

describe("doctor: check 1 — Bun version", () => {
	it("returns ok when Bun >= 1.3", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "bun");
		expect(check).toBeDefined();
		// We're running in Bun, so this should pass
		expect(check!.status).toBe("ok");
	});
});

describe("doctor: check 2 — hooks registered", () => {
	it("returns ok when all 12 hooks are registered", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "hooks");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
		expect(check!.message).toContain("12/12");
	});

	it("returns fail when hooks are missing", async () => {
		setupValidEnv();
		// Overwrite with partial hooks
		const claudeDir = join(TEST_HOME, ".claude");
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "hooks");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 3 — skill exists", () => {
	it("returns ok when skill file exists", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "skill");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
	});

	it("returns fail when skill file is missing", async () => {
		setupValidEnv();
		rmSync(join(TEST_HOME, ".claude", "skills"), { recursive: true, force: true });

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "skill");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 4 — agent exists", () => {
	it("returns ok when agent file exists", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "agent");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
	});

	it("returns fail when agent file is missing", async () => {
		setupValidEnv();
		rmSync(join(TEST_HOME, ".claude", "agents"), { recursive: true, force: true });

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "agent");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 5 — rules exists", () => {
	it("returns ok when rules file exists", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "rules");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
	});

	it("returns fail when rules file is missing", async () => {
		setupValidEnv();
		rmSync(join(TEST_HOME, ".claude", "rules"), { recursive: true, force: true });

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "rules");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 6 — gates.json", () => {
	it("returns ok when gates.json exists with on_write gates", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "gates");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
	});

	it("returns fail when gates.json is missing", async () => {
		setupValidEnv();
		rmSync(join(TEST_PROJECT, ".qult", "gates.json"));

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "gates");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});

	it("returns fail when gates.json has no on_write gates", async () => {
		setupValidEnv();
		writeFileSync(join(TEST_PROJECT, ".qult", "gates.json"), JSON.stringify({ on_write: {} }));

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "gates");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 7 — .qult/.state/ exists", () => {
	it("returns ok when state directory exists", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "state");
		expect(check).toBeDefined();
		expect(check!.status).toBe("ok");
	});

	it("returns fail when state directory is missing", async () => {
		setupValidEnv();
		rmSync(join(TEST_PROJECT, ".qult", ".state"), { recursive: true, force: true });

		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "state");
		expect(check).toBeDefined();
		expect(check!.status).toBe("fail");
	});
});

describe("doctor: check 8 — qult in PATH", () => {
	it("returns ok or warn for qult PATH check", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const check = findCheck(results, "path");
		expect(check).toBeDefined();
		// In dev it may not be in PATH — warn is acceptable
		expect(["ok", "warn"]).toContain(check!.status);
	});
});

describe("doctor: overall", () => {
	it("returns 8 check results", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		expect(results).toHaveLength(8);
	});

	it("all checks pass with valid setup", async () => {
		setupValidEnv();
		const { runChecks } = await import("../doctor.ts");
		const results = runChecks();
		const failures = results.filter((r) => r.status === "fail");
		// Only PATH check might not be ok (warn is acceptable)
		const realFailures = failures.filter((r) => r.name !== "path");
		expect(realFailures).toHaveLength(0);
	});
});

describe("doctor --fix repairs corrupted state", () => {
	it("resets corrupt JSON files to valid defaults", async () => {
		setupValidEnv();

		// Write corrupt JSON to state files
		const stateDir = join(TEST_PROJECT, ".qult", ".state");
		writeFileSync(join(stateDir, "pending-fixes.json"), "{broken json");
		writeFileSync(join(stateDir, "session-state.json"), "not json at all");
		writeFileSync(join(stateDir, "metrics.json"), "{{{{");

		// Import and run repair
		const { repairState } = await import("../doctor.ts");
		const repaired = repairState();

		expect(repaired.length).toBeGreaterThanOrEqual(3);

		// Verify files are now valid JSON
		for (const file of ["pending-fixes.json", "session-state.json", "metrics.json"]) {
			const content = readFileSync(join(stateDir, file), "utf-8");
			expect(() => JSON.parse(content)).not.toThrow();
		}
	});

	it("does nothing when state is healthy", async () => {
		setupValidEnv();

		// Write valid state
		const stateDir = join(TEST_PROJECT, ".qult", ".state");
		writeFileSync(join(stateDir, "pending-fixes.json"), "[]");
		writeFileSync(join(stateDir, "metrics.json"), "[]");

		const { repairState } = await import("../doctor.ts");
		const repaired = repairState();

		expect(repaired.length).toBe(0);
	});
});
