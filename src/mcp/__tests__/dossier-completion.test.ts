import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dossierCheck, dossierComplete } from "../dossier/lifecycle.js";
import { writeReviewGate, readReviewGate } from "../../hooks/review-gate.js";
import { Store, _setStoreForTest } from "../../store/index.js";
import { insertTestProject, TEST_PROJECT_ID, suppressIO } from "../../__tests__/test-utils.js";

let tmpDir: string;
let store: Store;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "dossier-completion-"));
	store = Store.open(join(tmpDir, "test.db"));
	insertTestProject(store, TEST_PROJECT_ID, tmpDir);
	_setStoreForTest(store);
});

afterEach(() => {
	_setStoreForTest(undefined);
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupSpec(slug: string, tasksJson: object, opts?: { size?: string; specType?: string }) {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
	const specType = opts?.specType ?? "bugfix";
	const state = {
		primary: slug,
		tasks: [{ slug, started_at: "2025-01-01", status: "active", size: opts?.size ?? "S", spec_type: specType }],
	};
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), JSON.stringify(state));
	// Use bugfix type to avoid FR traceability validation requirements.
	writeFileSync(join(specsDir, "bugfix.json"), JSON.stringify({ summary: "Fix bug", severity: "P2", reproduction_steps: ["step"], root_cause: "root", fix_strategy: "fix" }));
	writeFileSync(join(specsDir, "design.md"), "# Design\n\n## Components\nDetails");
	writeFileSync(join(specsDir, "tasks.json"), JSON.stringify(tasksJson, null, 2));
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
	return JSON.parse(result.content[0]!.text);
}

// --- dossierCheck ---

describe("dossierCheck", () => {
	it("marks task as checked", () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "Wave 1", tasks: [
					{ id: "T-1.1", title: "Task A", checked: false },
					{ id: "T-1.2", title: "Task B", checked: false },
				] },
				{ key: "closing", title: "Closing", tasks: [
					{ id: "T-C.1", title: "Self-review", checked: false },
				] },
			],
		};
		setupSpec("check-test", tasks);

		const result = parseResult(dossierCheck(tmpDir, { task_id: "T-1.1" }));
		expect(result.status).toBe("checked");

		// Verify tasks.json was updated.
		const updated = JSON.parse(readFileSync(join(tmpDir, ".alfred", "specs", "check-test", "tasks.json"), "utf-8"));
		const t = updated.waves[0].tasks[0];
		expect(t.checked).toBe(true);
	});

	it("returns already_checked for checked task", () => {
		const tasks = {
			slug: "test",
			waves: [{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task A", checked: true }] },
				{ key: "closing", title: "Closing", tasks: [] }],
		};
		setupSpec("dup-check", tasks);

		const result = parseResult(dossierCheck(tmpDir, { task_id: "T-1.1" }));
		expect(result.status).toBe("already_checked");
	});

	it("returns error for unknown task_id", () => {
		const tasks = {
			slug: "test",
			waves: [{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task", checked: false }] },
				{ key: "closing", title: "Closing", tasks: [] }],
		};
		setupSpec("missing-task", tasks);

		const result = parseResult(dossierCheck(tmpDir, { task_id: "T-99.1" }));
		expect(result.error).toContain("not found");
	});

	it("sets review gate when wave completes", () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "Wave 1", tasks: [
					{ id: "T-1.1", title: "Task A", checked: true },
					{ id: "T-1.2", title: "Task B", checked: false },
				] },
				{ key: "closing", title: "Closing", tasks: [{ id: "T-C.1", title: "Review", checked: false }] },
			],
		};
		setupSpec("gate-check", tasks);

		const io = suppressIO();
		try {
			const result = parseResult(dossierCheck(tmpDir, { task_id: "T-1.2" }));
			expect(result.gate_set).toBe(true);
			expect(result.wave_completion).toBeDefined();
			expect(result.wave_completion[0]).toContain("Wave 1 complete");
		} finally { io.restore(); }

		// Verify gate was written.
		const gate = readReviewGate(tmpDir);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("wave-review");
		expect(gate!.wave).toBe(1);
	});

	it("does NOT set gate for closing wave", () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "Wave 1", tasks: [{ id: "T-1.1", title: "Task", checked: true }] },
				{ key: "closing", title: "Closing", tasks: [{ id: "T-C.1", title: "Review", checked: false }] },
			],
		};
		setupSpec("closing-nogate", tasks);
		// Set wave 1 as already reviewed.
		writeFileSync(
			join(tmpDir, ".alfred", ".state", "wave-progress.json"),
			JSON.stringify({ slug: "closing-nogate", current_wave: 1, waves: { "1": { total: 1, checked: 1, reviewed: true } } }),
		);

		const io = suppressIO();
		try {
			const result = parseResult(dossierCheck(tmpDir, { task_id: "T-C.1" }));
			// Closing wave completes but no gate should be set.
			expect(result.gate_set).toBeUndefined();
		} finally { io.restore(); }

		const gate = readReviewGate(tmpDir);
		expect(gate).toBeNull();
	});

	it("warns about unsatisfied dependencies", () => {
		const tasks = {
			slug: "test",
			waves: [{ key: 1, title: "W1", tasks: [
				{ id: "T-1.1", title: "Setup", checked: false },
				{ id: "T-1.2", title: "Feature", checked: false, depends: ["T-1.1"] },
			] }, { key: "closing", title: "Closing", tasks: [] }],
		};
		setupSpec("dep-warn", tasks);

		const result = parseResult(dossierCheck(tmpDir, { task_id: "T-1.2" }));
		expect(result.dep_warnings).toBeDefined();
		expect(result.dep_warnings[0]).toContain("T-1.1");
	});
});

// --- dossierComplete ---

describe("dossierComplete", () => {
	it("blocks completion when review gate is active", async () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task", checked: true }] },
				{ key: "closing", title: "Closing", tasks: [{ id: "T-C.1", title: "Review", checked: true }] },
			],
		};
		setupSpec("gate-block", tasks);
		writeReviewGate(tmpDir, { gate: "wave-review", slug: "gate-block", wave: 1, reason: "review needed" });

		const result = parseResult(await dossierComplete(tmpDir, store, {}));
		expect(result.error).toContain("review gate active");
	});

	it("blocks completion when tasks are unchecked", async () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task", checked: false }] },
				{ key: "closing", title: "Closing", tasks: [{ id: "T-C.1", title: "Review", checked: true }] },
			],
		};
		setupSpec("unchecked-block", tasks);

		const result = parseResult(await dossierComplete(tmpDir, store, {}));
		expect(result.error).toContain("unchecked task");
	});

	it("blocks completion when closing wave is unchecked", async () => {
		const tasks = {
			slug: "test",
			waves: [
				{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task", checked: true }] },
				{ key: "closing", title: "Closing", tasks: [{ id: "T-C.1", title: "Self-review", checked: false }] },
			],
		};
		setupSpec("closing-block", tasks);

		const result = parseResult(await dossierComplete(tmpDir, store, {}));
		expect(result.error).toContain("Closing");
	});
});
