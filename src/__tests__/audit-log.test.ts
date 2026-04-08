import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureSession, setProjectPath, setSessionScope, useTestDb } from "../state/db.ts";

const TEST_DIR = "/tmp/.tmp-audit-log-test";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
});

afterEach(() => {
	closeDb();
});

import { appendAuditLog, readAuditLog } from "../state/audit-log.ts";

describe("appendAuditLog", () => {
	it("appends entry to audit log", () => {
		appendAuditLog(TEST_DIR, {
			action: "disable_gate",
			reason: "Gate is broken for this session",
			gate_name: "lint",
			timestamp: "2026-01-01T00:00:00Z",
		});

		const log = readAuditLog(TEST_DIR);
		expect(log).toHaveLength(1);
		expect(log[0]!.action).toBe("disable_gate");
		expect(log[0]!.reason).toBe("Gate is broken for this session");
	});

	it("appends to existing audit log", () => {
		appendAuditLog(TEST_DIR, {
			action: "test",
			reason: "existing entry",
			timestamp: "2026-01-01T00:00:00Z",
		});

		appendAuditLog(TEST_DIR, {
			action: "clear_pending_fixes",
			reason: "False positive from linter",
			timestamp: "2026-01-02T00:00:00Z",
		});

		const log = readAuditLog(TEST_DIR);
		expect(log).toHaveLength(2);
	});

	it("trims to 200 entries", () => {
		for (let i = 0; i < 200; i++) {
			appendAuditLog(TEST_DIR, {
				action: "test",
				reason: `entry ${i}`,
				timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
			});
		}

		appendAuditLog(TEST_DIR, {
			action: "new",
			reason: "new entry that should cause trim",
			timestamp: "2026-02-01T00:00:00Z",
		});

		const log = readAuditLog(TEST_DIR);
		expect(log).toHaveLength(200);
		expect(log[0]!.action).toBe("new");
	});
});

describe("readAuditLog", () => {
	it("returns empty array when no entries", () => {
		const log = readAuditLog(TEST_DIR);
		expect(log).toEqual([]);
	});
});
