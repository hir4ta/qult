import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditLog, readAuditLog } from "../state/audit-log.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-audit-log-"));
	mkdirSync(join(tmpRoot, ".qult"), { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("appendAuditLog", () => {
	it("appends entry to audit log", () => {
		appendAuditLog({
			action: "disable_gate",
			reason: "Gate is broken for this session",
			gate_name: "lint",
			timestamp: "2026-01-01T00:00:00Z",
		});

		const log = readAuditLog();
		expect(log).toHaveLength(1);
		expect(log[0]!.action).toBe("disable_gate");
		expect(log[0]!.reason).toBe("Gate is broken for this session");
	});

	it("appends to existing audit log (most recent first)", () => {
		appendAuditLog({
			action: "test",
			reason: "first entry",
			timestamp: "2026-01-01T00:00:00Z",
		});
		appendAuditLog({
			action: "clear_pending_fixes",
			reason: "second entry",
			timestamp: "2026-01-02T00:00:00Z",
		});
		const log = readAuditLog();
		expect(log).toHaveLength(2);
		expect(log[0]!.action).toBe("clear_pending_fixes"); // most recent first
		expect(log[1]!.action).toBe("test");
	});

	it("trims to 200 entries", () => {
		for (let i = 0; i < 250; i++) {
			appendAuditLog({
				action: "test",
				reason: `entry ${i}`,
				timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
			});
		}

		appendAuditLog({
			action: "new",
			reason: "new entry after trim threshold",
			timestamp: "2026-02-01T00:00:00Z",
		});

		const log = readAuditLog();
		expect(log).toHaveLength(200);
		expect(log[0]!.action).toBe("new");
	});
});

describe("readAuditLog", () => {
	it("returns empty array when file does not exist", () => {
		const log = readAuditLog();
		expect(log).toEqual([]);
	});
});
