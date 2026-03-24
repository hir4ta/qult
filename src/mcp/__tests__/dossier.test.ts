import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/index.js";
import { handleDossier } from "../dossier/index.js";
import { parseResult } from "../../__tests__/test-utils.js";

let tmpDir: string;
let store: Store;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "alfred-dossier-test-"));
	store = Store.open(join(tmpDir, "test.db"));
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("dossier init", () => {
	it("creates spec with correct files", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "my-feature",
			description: "Add authentication",
		});
		const data = parseResult(result);
		expect(data.task_slug).toBe("my-feature");
		expect(data.size).toBe("S");
		expect(data.files).toContain("requirements.md");
		expect(existsSync(join(tmpDir, ".alfred", "specs", "my-feature", "requirements.md"))).toBe(
			true,
		);
	});

	it("rejects invalid slug", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "INVALID",
		});
		const data = parseResult(result);
		expect(data.error).toBeDefined();
	});

	it("rejects duplicate init", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "dup-test",
		});
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "dup-test",
		});
		const data = parseResult(result);
		expect(data.error).toContain("already exists");
	});
});

describe("dossier status", () => {
	it("returns inactive when no specs", async () => {
		const result = await handleDossier(store, null, {
			action: "status",
			project_path: tmpDir,
		});
		expect(parseResult(result).active).toBe(false);
	});

	it("returns active spec details", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "my-task",
			description: "test",
		});
		const result = await handleDossier(store, null, {
			action: "status",
			project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.active).toBe(true);
		expect(data.task_slug).toBe("my-task");
		expect(data.requirements).toBeDefined();
	});
});

describe("dossier update", () => {
	it("appends content to spec file", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "upd-test",
		});
		const result = await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "\n## New Section\n",
			mode: "append",
		});
		const data = parseResult(result);
		expect(data.task_slug).toBe("upd-test");
		expect(data.mode).toBe("append");
	});

	it("replaces content in spec file", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "rep-test",
		});
		const result = await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Replaced",
			mode: "replace",
		});
		expect(parseResult(result).mode).toBe("replace");
	});

	it("returns validation_hints when spec has issues", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "val-test",
			size: "S",
		});
		// Write requirements with FRs but no tasks referencing them
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "requirements.md",
			content: "# Requirements\n\nFR-1: Something\nFR-2: Another\n",
			mode: "replace",
		});
		const result = await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1\n\n- [ ] T-1.1: Do something\n\n## Closing Wave\n\n- [ ] Review\n",
			mode: "replace",
		});
		const data = parseResult(result);
		expect(data.validation_hints).toBeDefined();
		expect(data.validation_hints.length).toBeGreaterThan(0);
		expect(data.validation_hints.some((h: string) => h.includes("FR"))).toBe(true);
	});

	it("omits validation_hints when spec is valid", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "valid-test",
			size: "S",
			spec_type: "bugfix",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "bugfix.md",
			content: "# Bugfix\n\n" + "A".repeat(250) + "\n",
			mode: "replace",
		});
		const result = await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1\n\n- [ ] T-1.1: Fix\n\n## Closing Wave\n\n- [ ] Review\n",
			mode: "replace",
		});
		const data = parseResult(result);
		expect(data.validation_hints).toBeUndefined();
	});
});

describe("dossier switch", () => {
	it("switches active task", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "task-a",
		});
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "task-b",
		});
		const result = await handleDossier(store, null, {
			action: "switch",
			project_path: tmpDir,
			task_slug: "task-a",
		});
		expect(parseResult(result).switched).toBe(true);
	});
});

describe("dossier complete", () => {
	it("completes S spec when closing wave all checked", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "done-test",
			description: "small",
			size: "S",
			spec_type: "bugfix",
		});
		// Write bugfix.md with substantive content (validation requires it)
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			task_slug: "done-test",
			file: "bugfix.md",
			content: "# Bugfix\n\n## Bug Summary\nFix the closing wave enforcement issue.\n\n## Severity & Impact\nP1 — workflow gate broken\n\n## Root Cause Analysis\nTemplate lacks IDs.\n\n## Fix Strategy\nAdd IDs and DENY on incomplete.",
			mode: "replace",
		});
		// Check all closing wave items
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			task_slug: "done-test",
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1\n\n- [x] T-1.1 Done\n  _Requirements: FR-1_\n\n## Wave: Closing\n\n- [x] T-C.1 Commit\n- [x] T-C.2 Self-review\n- [x] T-C.3 CLAUDE.md\n- [x] T-C.4 Tests\n- [x] T-C.5 Knowledge",
			mode: "replace",
		});
		const result = await handleDossier(store, null, {
			action: "complete",
			project_path: tmpDir,
			task_slug: "done-test",
		});
		expect(parseResult(result).completed).toBe(true);
	});

	it("denies complete when closing wave has unchecked items", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "deny-close",
			description: "incomplete closing",
			size: "S",
			spec_type: "bugfix",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			task_slug: "deny-close",
			file: "bugfix.md",
			content: "# Bugfix\n\n## Bug Summary\nTest bugfix that causes a crash when users attempt to save their work. The application throws an unhandled exception in the persistence layer.\n\n## Severity & Impact\nP2 — Users lose unsaved work.\n\n## Root Cause Analysis\nThe persistence layer does not validate input before writing to disk, causing a TypeError when null values are encountered.\n\n## Fix Strategy\nAdd null-check validation before the write call and return a descriptive error message to the caller.",
			mode: "replace",
		});
		// Leave closing wave items unchecked
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			task_slug: "deny-close",
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1\n\n- [x] T-1.1 Done\n  _Requirements: FR-1_\n\n## Wave: Closing\n\n- [x] T-C.1 Commit\n- [ ] T-C.2 Self-review\n- [ ] T-C.3 CLAUDE.md\n- [x] T-C.4 Tests\n- [ ] T-C.5 Knowledge",
			mode: "replace",
		});
		const result = await handleDossier(store, null, {
			action: "complete",
			project_path: tmpDir,
			task_slug: "deny-close",
		});
		const data = parseResult(result);
		expect(data.error).toBeDefined();
		expect(data.error).toContain("closing wave gate");
		expect(data.error).toContain("3 unchecked");
	});
});

describe("dossier delete", () => {
	it("preview without confirm", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "del-test",
		});
		const result = await handleDossier(store, null, {
			action: "delete",
			project_path: tmpDir,
			task_slug: "del-test",
		});
		const data = parseResult(result);
		expect(data.warning).toBeDefined();
		expect(data.exists).toBe(true);
	});

	it("deletes with confirm", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "del-test",
		});
		const result = await handleDossier(store, null, {
			action: "delete",
			project_path: tmpDir,
			task_slug: "del-test",
			confirm: true,
		});
		expect(parseResult(result).deleted).toBe(true);
		expect(existsSync(join(tmpDir, ".alfred", "specs", "del-test"))).toBe(false);
	});
});

describe("dossier gate", () => {
	it("sets spec-review gate", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "gate-test",
		});
		const result = await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "set",
			gate_type: "spec-review",
		});
		const data = parseResult(result);
		// Gate set returns confirmation - check it didn't error
		expect(data.error).toBeUndefined();
	});

	it("gets gate status", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "gate-status",
		});
		const result = await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "status",
		});
		const data = parseResult(result);
		expect(data).toBeDefined();
	});

	it("clears gate with reason", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "gate-clear",
		});
		await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "set",
			gate_type: "spec-review",
		});
		const result = await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "clear",
			reason: "code-reviewer: 0 Critical, 0 High findings. Self-review completed.",
		});
		const data = parseResult(result);
		expect(data.cleared).toBe(true);
	});
});

describe("dossier init sizes", () => {
	it("auto-detects S for short description", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "size-s",
			description: "Fix typo",
		});
		expect(parseResult(result).size).toBe("S");
	});

	it("auto-detects M for medium description", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "size-m",
			description: "Add user authentication with JWT tokens, refresh token rotation, session management, and proper error handling for expired tokens. Include rate limiting for login attempts and password reset functionality with email verification.",
		});
		expect(parseResult(result).size).toBe("M");
	});

	it("respects explicit size", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "size-l",
			size: "L",
			description: "test",
		});
		expect(parseResult(result).size).toBe("L");
	});

	it("creates bugfix spec type", async () => {
		const result = await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "bug-fix",
			spec_type: "bugfix",
		});
		const data = parseResult(result);
		expect(data.spec_type).toBe("bugfix");
	});
});

describe("dossier validate", () => {
	it("validates spec structure", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "val-test",
		});
		const result = await handleDossier(store, null, {
			action: "validate",
			project_path: tmpDir,
			task_slug: "val-test",
		});
		const data = parseResult(result);
		expect(data.checks).toBeDefined();
		expect(data.summary).toContain("passed");
	});
});

describe("dossier check", () => {
	it("checks a task by task_id", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-test",
		});
		// Write tasks.md with unchecked tasks
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [ ] T-1.1: First task\n- [ ] T-1.2: Second task\n\n## Closing Wave\n\n- [ ] Review",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-1.1",
		});
		const data = parseResult(result);
		expect(data.status).toBe("checked");
		expect(data.task_id).toBe("T-1.1");
	});

	it("detects already checked task", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-dup",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [x] T-1.1: Already done\n\n## Closing Wave\n\n- [ ] Review",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-1.1",
		});
		const data = parseResult(result);
		expect(data.status).toBe("already_checked");
	});

	it("returns error for missing task_id", async () => {
		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("task_id");
	});

	it("returns error when task_id not found", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-miss",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [ ] T-1.1: Only task\n\n## Closing Wave\n\n- [ ] Review",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-9.9",
		});
		const data = parseResult(result);
		expect(data.error).toContain("not found");
	});

	it("checks Closing Wave item by T-C.N index", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-closing",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [x] T-1.1: Done\n\n## Wave: Closing\n\n- [ ] セルフレビュー実施\n- [ ] CLAUDE.md 更新\n- [ ] テスト確認\n- [ ] ナレッジ蓄積",
			mode: "replace",
		});

		// Check 2nd item (CLAUDE.md update)
		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-C.2",
		});
		const data = parseResult(result);
		expect(data.status).toBe("checked");
		expect(data.task_id).toBe("T-C.2");

		// Check 1st item
		const r2 = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-C.1",
		});
		expect(parseResult(r2).status).toBe("checked");

		// Re-check 2nd → already_checked
		const r3 = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-C.2",
		});
		expect(parseResult(r3).status).toBe("already_checked");
	});

	it("T-C.N out of range returns error", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-closing-oor",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [x] T-1.1: Done\n\n## Closing Wave\n\n- [ ] Review\n- [ ] Tests",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-C.5",
		});
		const data = parseResult(result);
		expect(data.error).toContain("Closing Wave has only 2 item(s)");
	});

	it("case-insensitive task_id matching", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-case",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1 (FR-1)\n\n- [ ] T-1.1: Case test\n\n## Closing Wave\n\n- [ ] Review",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "t-1.1",
		});
		const data = parseResult(result);
		expect(data.status).toBe("checked");
	});

	it("T-N.R as checkbox line (fallback from header format)", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-review-cb",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1: Fix\n\n- [x] T-1.1 Implement fix\n- [ ] T-1.R レビュー + コミット\n\n## Wave: Closing\n\n- [ ] T-C.1 セルフレビュー\n- [ ] T-C.2 テスト確認",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-1.R",
		});
		const data = parseResult(result);
		expect(data.status).toBe("checked");
	});

	it("T-N.R as checkbox line already checked", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "check-review-done",
		});
		await handleDossier(store, null, {
			action: "update",
			project_path: tmpDir,
			file: "tasks.md",
			content: "# Tasks\n\n## Wave 1: Fix\n\n- [x] T-1.1 Implement fix\n- [x] T-1.R レビュー完了\n\n## Wave: Closing\n\n- [ ] T-C.1 レビュー",
			mode: "replace",
		});

		const result = await handleDossier(store, null, {
			action: "check",
			project_path: tmpDir,
			task_id: "T-1.R",
		});
		const data = parseResult(result);
		expect(data.status).toBe("already_checked");
	});
});

// --- Wave Enforcement Tests (#24, #25) ---

describe("wave-enforcement", () => {
	it("#24: blocks complete when Wave 1 tasks are unchecked", async () => {
		await handleDossier(store, null, {
			action: "init", project_path: tmpDir, task_slug: "wave-block",
			size: "S", spec_type: "bugfix",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "wave-block",
			file: "bugfix.md", mode: "replace",
			content: "# Bugfix\n\n## Bug Summary\nTest bugfix for wave enforcement validation. The system fails to check implementation wave tasks before allowing spec completion.\n\n## Severity & Impact\nP0 — Core enforcement broken.\n\n## Root Cause Analysis\ncheckClosingWave only validates Closing section checkboxes, ignoring Wave 1-N tasks entirely.\n\n## Fix Strategy\nAdd checkAllWaveTasks function to validate all waves before completion.",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "wave-block",
			file: "tasks.md", mode: "replace",
			content: "# Tasks\n\n## Wave 1: Core\n\n- [ ] T-1.1 Implement feature\n\n## Wave: Closing\n\n- [x] T-C.1 Self-review\n- [x] T-C.2 CLAUDE.md\n- [x] T-C.3 Tests\n- [x] T-C.4 Knowledge",
		});
		const result = await handleDossier(store, null, {
			action: "complete", project_path: tmpDir, task_slug: "wave-block",
		});
		const data = parseResult(result);
		expect(data.error).toBeDefined();
		expect(data.error).toContain("unchecked task");
	});

	it("#24: allows complete when all Wave tasks are checked", async () => {
		await handleDossier(store, null, {
			action: "init", project_path: tmpDir, task_slug: "wave-pass",
			size: "S", spec_type: "bugfix",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "wave-pass",
			file: "bugfix.md", mode: "replace",
			content: "# Bugfix\n\n## Bug Summary\nTest bugfix for wave enforcement validation. The system fails to check implementation wave tasks before allowing spec completion.\n\n## Severity & Impact\nP0 — Core enforcement broken.\n\n## Root Cause Analysis\ncheckClosingWave only validates Closing section checkboxes.\n\n## Fix Strategy\nAdd checkAllWaveTasks function.",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "wave-pass",
			file: "tasks.md", mode: "replace",
			content: "# Tasks\n\n## Wave 1: Core\n\n- [x] T-1.1 Done\n\n## Wave: Closing\n\n- [x] T-C.1 Self-review\n- [x] T-C.2 CLAUDE.md\n- [x] T-C.3 Tests\n- [x] T-C.4 Knowledge",
		});
		const result = await handleDossier(store, null, {
			action: "complete", project_path: tmpDir, task_slug: "wave-pass",
		});
		const data = parseResult(result);
		expect(data.completed).toBe(true);
	});

	it("#25: blocks gate clear with short reason (<30 chars)", async () => {
		await handleDossier(store, null, {
			action: "init",
			project_path: tmpDir,
			task_slug: "gate-short",
		});
		await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "set",
			gate_type: "wave-review",
			wave: 1,
		});
		const result = await handleDossier(store, null, {
			action: "gate",
			project_path: tmpDir,
			sub_action: "clear",
			reason: "reviewed",
		});
		const data = parseResult(result);
		expect(data.error).toBeDefined();
		expect(data.error).toContain("30 characters");
	});

	it("checkbox: recognizes uppercase [X] as checked", async () => {
		await handleDossier(store, null, {
			action: "init", project_path: tmpDir, task_slug: "upper-x",
			size: "S", spec_type: "bugfix",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "upper-x",
			file: "bugfix.md", mode: "replace",
			content: "# Bugfix\n\n## Bug Summary\nTest uppercase X checkbox recognition. Checkboxes marked with [X] should be treated as checked.\n\n## Severity & Impact\nP1 — Usability issue.\n\n## Root Cause Analysis\nRegex only matches lowercase x.\n\n## Fix Strategy\nUpdate regex to match both x and X.",
		});
		await handleDossier(store, null, {
			action: "update", project_path: tmpDir, task_slug: "upper-x",
			file: "tasks.md", mode: "replace",
			content: "# Tasks\n\n## Wave 1\n\n- [X] T-1.1 Done with uppercase\n\n## Wave: Closing\n\n- [X] T-C.1 Review\n- [X] T-C.2 Docs\n- [X] T-C.3 Tests\n- [X] T-C.4 Knowledge",
		});
		const result = await handleDossier(store, null, {
			action: "complete", project_path: tmpDir, task_slug: "upper-x",
		});
		const data = parseResult(result);
		expect(data.completed).toBe(true);
	});
});
