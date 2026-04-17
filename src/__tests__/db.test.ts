import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";

beforeEach(() => {
	useTestDb();
});

afterEach(() => {
	closeDb();
});

describe("db", () => {
	describe("getDb / useTestDb", () => {
		it("returns a database connection", () => {
			const db = getDb();
			expect(db).toBeDefined();
		});

		it("creates expected tables", () => {
			const db = getDb();
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			const names = tables.map((t) => t.name);
			expect(names).toContain("projects");
			expect(names).toContain("pending_fixes");
			expect(names).toContain("changed_files");
		});

		it("sets schema version", () => {
			const db = getDb();
			const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
			expect(user_version).toBeGreaterThanOrEqual(6);
		});
	});

	describe("project resolution", () => {
		it("creates project on first access", () => {
			setProjectPath("/tmp/test-project");
			const id = getProjectId();
			expect(id).toBeGreaterThan(0);
		});

		it("returns same ID for same path", () => {
			setProjectPath("/tmp/test-project");
			const id1 = getProjectId();
			const id2 = getProjectId();
			expect(id1).toBe(id2);
		});

		it("returns different IDs for different paths", () => {
			setProjectPath("/tmp/project-a");
			const idA = getProjectId();
			setProjectPath("/tmp/project-b");
			const idB = getProjectId();
			expect(idA).not.toBe(idB);
		});
	});

	describe("project state columns", () => {
		it("projects table has state columns", () => {
			const db = getDb();
			const columns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
			const names = columns.map((c) => c.name);
			expect(names).toContain("test_passed_at");
			expect(names).toContain("review_completed_at");
			expect(names).toContain("security_warning_count");
			expect(names).toContain("duplication_warning_count");
		});
	});

	describe("closeDb", () => {
		it("allows re-opening after close", () => {
			closeDb();
			useTestDb();
			const db = getDb();
			const row = db.prepare("SELECT 1 as n").get() as { n: number };
			expect(row.n).toBe(1);
		});
	});

	describe("schema constraints", () => {
		it("pending_fixes UNIQUE(project_id, file, gate) prevents duplicates", () => {
			setProjectPath("/tmp/test");
			const db = getDb();

			db.prepare(
				"INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)",
			).run(getProjectId(), "a.ts", "lint", "[]");
			expect(() => {
				db.prepare(
					"INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)",
				).run(getProjectId(), "a.ts", "lint", "[]");
			}).toThrow();
		});
	});
});
