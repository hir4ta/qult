import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../index.js";
import { syncProjectSpecs } from "../spec-sync.js";
import { insertTestProject } from "../../__tests__/test-utils.js";

describe("syncProjectSpecs", () => {
	let tmpDir: string;
	let store: Store;
	const PROJECT_ID = "sync-test-project";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "spec-sync-"));
		store = Store.open(join(tmpDir, "test.db"));
		insertTestProject(store, PROJECT_ID, tmpDir);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("indexes new spec files", async () => {
		// Create spec directory
		const specDir = join(tmpDir, ".alfred", "specs", "my-feature");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# Requirements\n\nFR-1: Test");
		writeFileSync(join(specDir, "design.md"), "# Design\n\nArchitecture overview");

		// Create _active.md
		const specsRoot = join(tmpDir, ".alfred", "specs");
		writeFileSync(
			join(specsRoot, "_active.md"),
			"primary: my-feature\ntasks:\n  - slug: my-feature\n    size: M\n    spec_type: feature\n    status: active\n",
		);

		const result = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(result.inserted).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.deleted).toBe(0);

		// Verify DB entries
		const rows = store.db
			.prepare("SELECT slug, file_name, status FROM spec_index WHERE project_id = ? ORDER BY file_name")
			.all(PROJECT_ID) as Array<{ slug: string; file_name: string; status: string }>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ slug: "my-feature", file_name: "design.md", status: "active" });
		expect(rows[1]).toMatchObject({ slug: "my-feature", file_name: "requirements.md", status: "active" });
	});

	it("skips unchanged files on re-sync", async () => {
		const specDir = join(tmpDir, ".alfred", "specs", "my-feature");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# Requirements");
		writeFileSync(
			join(tmpDir, ".alfred", "specs", "_active.md"),
			"primary: my-feature\ntasks:\n  - slug: my-feature\n",
		);

		const r1 = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(r1.inserted).toBe(1);

		const r2 = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(r2.inserted).toBe(0);
		expect(r2.updated).toBe(0);
	});

	it("updates changed files", async () => {
		const specDir = join(tmpDir, ".alfred", "specs", "my-feature");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# Requirements v1");
		writeFileSync(
			join(tmpDir, ".alfred", "specs", "_active.md"),
			"primary: my-feature\ntasks:\n  - slug: my-feature\n",
		);

		await syncProjectSpecs(store, PROJECT_ID, tmpDir);

		// Modify file
		writeFileSync(join(specDir, "requirements.md"), "# Requirements v2");
		const r2 = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(r2.updated).toBe(1);
	});

	it("deletes orphaned records when spec directory is removed", async () => {
		const specDir = join(tmpDir, ".alfred", "specs", "my-feature");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# Requirements");
		writeFileSync(
			join(tmpDir, ".alfred", "specs", "_active.md"),
			"primary: my-feature\ntasks:\n  - slug: my-feature\n",
		);

		await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(store.db.prepare("SELECT COUNT(*) as c FROM spec_index").get()).toMatchObject({ c: 1 });

		// Remove spec directory
		rmSync(specDir, { recursive: true });
		const r2 = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(r2.deleted).toBe(1);
		expect(store.db.prepare("SELECT COUNT(*) as c FROM spec_index").get()).toMatchObject({ c: 0 });
	});

	it("marks completed specs correctly", async () => {
		// Create spec dir but do NOT list in _active.md (simulates completed spec)
		const specDir = join(tmpDir, ".alfred", "specs", "old-feature");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# Old Requirements");

		// Empty active state (or no active.md)
		mkdirSync(join(tmpDir, ".alfred", "specs"), { recursive: true });

		const result = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(result.inserted).toBe(1);

		const row = store.db
			.prepare("SELECT status FROM spec_index WHERE slug = 'old-feature'")
			.get() as { status: string };
		expect(row.status).toBe("completed");
	});

	it("returns empty result when no .alfred/specs directory", async () => {
		const result = await syncProjectSpecs(store, PROJECT_ID, tmpDir);
		expect(result).toMatchObject({ inserted: 0, updated: 0, deleted: 0, embedded: 0 });
	});
});
