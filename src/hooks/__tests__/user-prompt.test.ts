import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorkedSlug, resetWorkedSlugs } from "../state.js";
import { checkSpecRequired, classifyIntent } from "../user-prompt.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "user-prompt-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupAlfred(): void {
	mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
}

function setupSpec(opts: { size?: string }): void {
	setupAlfred();
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(specsDir, { recursive: true });
	const state = {
		primary: "test-task",
		tasks: [{
			slug: "test-task",
			started_at: "2026-01-01T00:00:00Z",
			...(opts.size ? { size: opts.size } : {}),
		}],
	};
	writeFileSync(join(specsDir, "_active.json"), JSON.stringify(state));
}

describe("classifyIntent", () => {
	// EN keywords
	it('classifies "implement login" as implement', () => {
		expect(classifyIntent("implement login feature")).toBe("implement");
	});

	it('classifies "fix the bug" as bugfix', () => {
		expect(classifyIntent("fix the bug in auth")).toBe("bugfix");
	});

	it('classifies "review code" as review', () => {
		expect(classifyIntent("review the code changes")).toBe("review");
	});

	it('classifies "write tests" as tdd', () => {
		expect(classifyIntent("write tests for the API")).toBe("tdd");
	});

	it('classifies "research patterns" as research', () => {
		expect(classifyIntent("research design patterns for this")).toBe("research");
	});

	// JP keywords
	it("classifies Japanese implement intent", () => {
		expect(classifyIntent("ログイン機能を実装してください")).toBe("implement");
	});

	it("classifies Japanese bugfix intent", () => {
		expect(classifyIntent("バグを修正して")).toBe("bugfix");
	});

	it("classifies Japanese review intent", () => {
		expect(classifyIntent("コードをレビューして")).toBe("review");
	});

	// Edge cases
	it("returns null for unrelated prompt", () => {
		expect(classifyIntent("hello world")).toBeNull();
	});

	it("save-knowledge suppresses research when both match", () => {
		expect(classifyIntent("save this research note")).toBe("save-knowledge");
	});
});

describe("checkSpecRequired", () => {
	it("returns DIRECTIVE when no spec and implement intent", () => {
		setupAlfred();
		const result = checkSpecRequired(tmpDir, "implement");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("DIRECTIVE");
	});

	it("returns DIRECTIVE when no spec and bugfix intent", () => {
		setupAlfred();
		const result = checkSpecRequired(tmpDir, "bugfix");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("DIRECTIVE");
	});

	it("returns DIRECTIVE when no spec and tdd intent", () => {
		setupAlfred();
		const result = checkSpecRequired(tmpDir, "tdd");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("DIRECTIVE");
	});

	it("returns null for review intent (no spec required)", () => {
		setupAlfred();
		expect(checkSpecRequired(tmpDir, "review")).toBeNull();
	});

	it("returns null for research intent (no spec required)", () => {
		setupAlfred();
		expect(checkSpecRequired(tmpDir, "research")).toBeNull();
	});

	it("returns WARNING when spec exists (parallel dev guard)", () => {
		setupSpec({ size: "M" });
		const result = checkSpecRequired(tmpDir, "implement");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("WARNING");
		expect(result!.message).toContain("test-task");
	});

	it("returns null when S spec (exempt from approval gate) but WARNING for parallel dev", () => {
		setupSpec({ size: "S" });
		const result = checkSpecRequired(tmpDir, "implement");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("WARNING");
		expect(result!.message).toContain("test-task");
		expect(result!.message).toContain("AskUserQuestion");
	});

	it("returns WARNING when active spec exists and implement intent (parallel dev guard)", () => {
		setupSpec({ size: "S" });
		const result = checkSpecRequired(tmpDir, "bugfix");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("WARNING");
		expect(result!.message).toContain("test-task");
	});

	it("returns null when active spec exists and non-implement intent", () => {
		setupSpec({ size: "S" });
		expect(checkSpecRequired(tmpDir, "review")).toBeNull();
		expect(checkSpecRequired(tmpDir, "research")).toBeNull();
	});

	it("suppresses WARNING when slug is already in worked-slugs (confirmed working)", () => {
		setupSpec({ size: "S" });
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
		resetWorkedSlugs(tmpDir);
		addWorkedSlug(tmpDir, "test-task");
		expect(checkSpecRequired(tmpDir, "implement")).toBeNull();
	});

	it("returns null when no .alfred/ directory", () => {
		expect(checkSpecRequired(tmpDir, "implement")).toBeNull();
	});

	it("returns DIRECTIVE level (mandatory proposal)", () => {
		setupAlfred();
		const result = checkSpecRequired(tmpDir, "implement");
		expect(result).not.toBeNull();
		expect(result!.level).toBe("DIRECTIVE");
	});
});
