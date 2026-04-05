import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-audit-log-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const AUDIT_LOG_PATH = join(STATE_DIR, "audit-log.json");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
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
		writeFileSync(
			AUDIT_LOG_PATH,
			JSON.stringify([
				{ action: "test", reason: "existing entry", timestamp: "2026-01-01T00:00:00Z" },
			]),
		);

		appendAuditLog(TEST_DIR, {
			action: "clear_pending_fixes",
			reason: "False positive from linter",
			timestamp: "2026-01-02T00:00:00Z",
		});

		const log = readAuditLog(TEST_DIR);
		expect(log).toHaveLength(2);
	});

	it("trims to 200 entries", () => {
		const existing = Array.from({ length: 200 }, (_, i) => ({
			action: "test",
			reason: `entry ${i}`,
			timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
		}));
		writeFileSync(AUDIT_LOG_PATH, JSON.stringify(existing));

		appendAuditLog(TEST_DIR, {
			action: "new",
			reason: "new entry that should cause trim",
			timestamp: "2026-02-01T00:00:00Z",
		});

		const log = readAuditLog(TEST_DIR);
		expect(log).toHaveLength(200);
		expect(log[log.length - 1]!.action).toBe("new");
	});
});

describe("readAuditLog", () => {
	it("returns empty array when file missing", () => {
		const log = readAuditLog(TEST_DIR);
		expect(log).toEqual([]);
	});

	it("returns empty array on corrupt file", () => {
		writeFileSync(AUDIT_LOG_PATH, "not json {{{");
		const log = readAuditLog(TEST_DIR);
		expect(log).toEqual([]);
	});
});
