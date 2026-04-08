import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeDb,
	DEFAULT_SESSION_ID,
	ensureSession,
	findLatestSessionId,
	getDb,
	getProjectId,
	getSessionId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";

describe("db", () => {
	beforeEach(() => {
		useTestDb();
	});

	afterEach(() => {
		closeDb();
	});

	describe("getDb / useTestDb", () => {
		it("returns a usable database", () => {
			const db = getDb();
			const row = db.prepare("SELECT 1 as n").get() as { n: number };
			expect(row.n).toBe(1);
		});

		it("returns the same instance on repeated calls", () => {
			const db1 = getDb();
			const db2 = getDb();
			expect(db1).toBe(db2);
		});

		it("creates all tables", () => {
			const db = getDb();
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			const names = tables.map((t) => t.name);
			expect(names).toContain("projects");
			expect(names).toContain("sessions");
			expect(names).toContain("pending_fixes");
			expect(names).toContain("changed_files");
			expect(names).toContain("disabled_gates");
			expect(names).toContain("ran_gates");
			expect(names).toContain("task_verify_results");
			expect(names).toContain("gate_failure_counts");
			expect(names).toContain("review_scores");
			expect(names).toContain("review_stage_scores");
			expect(names).toContain("plan_eval_scores");
			expect(names).toContain("gate_configs");
			expect(names).toContain("project_configs");
			expect(names).toContain("global_configs");
			expect(names).toContain("audit_log");
			expect(names).toContain("session_metrics");
			expect(names).toContain("calibration");
			expect(names).toContain("review_findings");
		});
	});

	describe("project resolution", () => {
		it("creates project on first getProjectId call", () => {
			setProjectPath("/tmp/test-project");
			const id = getProjectId();
			expect(id).toBeGreaterThan(0);
		});

		it("returns same id for same path", () => {
			setProjectPath("/tmp/test-project");
			const id1 = getProjectId();
			const id2 = getProjectId();
			expect(id1).toBe(id2);
		});

		it("returns different ids for different paths", () => {
			setProjectPath("/tmp/project-a");
			const idA = getProjectId();
			setProjectPath("/tmp/project-b");
			const idB = getProjectId();
			expect(idA).not.toBe(idB);
		});
	});

	describe("session resolution", () => {
		it("defaults to __default__ session ID", () => {
			expect(getSessionId()).toBe(DEFAULT_SESSION_ID);
		});

		it("updates session ID via setSessionScope", () => {
			setSessionScope("abc-123");
			expect(getSessionId()).toBe("abc-123");
		});

		it("rejects path-traversal characters", () => {
			setSessionScope("abc-123");
			setSessionScope("../evil");
			expect(getSessionId()).toBe("abc-123");
		});

		it("accepts dots, hyphens, underscores, colons", () => {
			setSessionScope("sess.2024-01:abc_def");
			expect(getSessionId()).toBe("sess.2024-01:abc_def");
		});

		it("ensureSession creates session row", () => {
			setProjectPath("/tmp/test-project");
			setSessionScope("test-session-1");
			ensureSession();

			const db = getDb();
			const row = db
				.prepare("SELECT id, project_id FROM sessions WHERE id = ?")
				.get("test-session-1") as {
				id: string;
				project_id: number;
			} | null;
			expect(row).not.toBeNull();
			expect(row!.id).toBe("test-session-1");
			expect(row!.project_id).toBe(getProjectId());
		});

		it("ensureSession is idempotent", () => {
			setProjectPath("/tmp/test-project");
			setSessionScope("test-session-1");
			ensureSession();
			ensureSession();

			const db = getDb();
			const count = db
				.prepare("SELECT count(*) as n FROM sessions WHERE id = ?")
				.get("test-session-1") as {
				n: number;
			};
			expect(count.n).toBe(1);
		});
	});

	describe("findLatestSessionId", () => {
		it("returns null when no sessions exist", () => {
			setProjectPath("/tmp/empty-project");
			expect(findLatestSessionId()).toBeNull();
		});

		it("returns the most recent session", () => {
			setProjectPath("/tmp/test-project");
			const projectId = getProjectId();
			const db = getDb();

			db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(
				"old-session",
				projectId,
				"2024-01-01T00:00:00.000Z",
			);
			db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(
				"new-session",
				projectId,
				"2024-12-31T23:59:59.999Z",
			);

			expect(findLatestSessionId()).toBe("new-session");
		});

		it("scopes to current project", () => {
			setProjectPath("/tmp/project-a");
			const projectA = getProjectId();
			setProjectPath("/tmp/project-b");
			const projectB = getProjectId();

			const db = getDb();
			db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(
				"session-a",
				projectA,
				"2024-12-31T23:59:59.999Z",
			);
			db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(
				"session-b",
				projectB,
				"2024-01-01T00:00:00.000Z",
			);

			expect(findLatestSessionId()).toBe("session-b");
		});
	});

	describe("closeDb", () => {
		it("resets session ID to default", () => {
			setSessionScope("my-session");
			closeDb();
			expect(getSessionId()).toBe(DEFAULT_SESSION_ID);
		});

		it("allows re-opening after close", () => {
			closeDb();
			useTestDb();
			const db = getDb();
			const row = db.prepare("SELECT 1 as n").get() as { n: number };
			expect(row.n).toBe(1);
		});
	});

	describe("schema constraints", () => {
		it("pending_fixes UNIQUE(session_id, file, gate) prevents duplicates", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			db.prepare(
				"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
			).run("s1", "a.ts", "lint", "[]");
			expect(() => {
				db.prepare(
					"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
				).run("s1", "a.ts", "lint", "[]");
			}).toThrow();
		});

		it("review_scores UNIQUE(session_id, iteration) prevents duplicates", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			db.prepare(
				"INSERT INTO review_scores (session_id, iteration, aggregate_score) VALUES (?, ?, ?)",
			).run("s1", 1, 30);
			expect(() => {
				db.prepare(
					"INSERT INTO review_scores (session_id, iteration, aggregate_score) VALUES (?, ?, ?)",
				).run("s1", 1, 35);
			}).toThrow();
		});

		it("review_stage_scores UNIQUE(session_id, stage, dimension) prevents duplicates", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			db.prepare(
				"INSERT INTO review_stage_scores (session_id, stage, dimension, score) VALUES (?, ?, ?, ?)",
			).run("s1", "Spec", "Completeness", 5);
			expect(() => {
				db.prepare(
					"INSERT INTO review_stage_scores (session_id, stage, dimension, score) VALUES (?, ?, ?, ?)",
				).run("s1", "Spec", "Completeness", 4);
			}).toThrow();
		});

		it("audit_log has no CASCADE on session delete", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			const projectId = getProjectId();
			db.prepare(
				"INSERT INTO audit_log (project_id, session_id, action, reason) VALUES (?, ?, ?, ?)",
			).run(projectId, "s1", "disable_gate", "test reason");

			db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");

			const rows = db.prepare("SELECT * FROM audit_log WHERE session_id = ?").all("s1");
			expect(rows).toHaveLength(1);
		});

		it("CASCADE deletes child rows when session is deleted", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			db.prepare(
				"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
			).run("s1", "a.ts", "lint", "[]");
			db.prepare("INSERT INTO changed_files (session_id, file_path) VALUES (?, ?)").run(
				"s1",
				"a.ts",
			);

			db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");

			const fixes = db.prepare("SELECT * FROM pending_fixes WHERE session_id = ?").all("s1");
			const files = db.prepare("SELECT * FROM changed_files WHERE session_id = ?").all("s1");
			expect(fixes).toHaveLength(0);
			expect(files).toHaveLength(0);
		});

		it("gate_failure_counts uses separate file and gate columns", () => {
			setProjectPath("/tmp/test");
			setSessionScope("s1");
			ensureSession();
			const db = getDb();

			db.prepare(
				"INSERT INTO gate_failure_counts (session_id, file, gate, count) VALUES (?, ?, ?, ?)",
			).run("s1", "src/foo.ts", "lint", 3);
			db.prepare(
				"INSERT INTO gate_failure_counts (session_id, file, gate, count) VALUES (?, ?, ?, ?)",
			).run("s1", "src/foo.ts", "typecheck", 1);

			const rows = db
				.prepare("SELECT * FROM gate_failure_counts WHERE session_id = ? AND file = ?")
				.all("s1", "src/foo.ts") as { gate: string; count: number }[];
			expect(rows).toHaveLength(2);
			expect(rows.find((r) => r.gate === "lint")?.count).toBe(3);
		});
	});
});
