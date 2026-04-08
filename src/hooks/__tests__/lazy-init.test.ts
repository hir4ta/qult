import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeDb,
	ensureSession,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../../state/db.ts";
import { resetAllCaches } from "../../state/flush.ts";
import { readPendingFixes, writePendingFixes } from "../../state/pending-fixes.ts";
import { lazyInit, resetLazyInit } from "../lazy-init.ts";

const TEST_DIR = "/tmp/.tmp-lazy-init-test";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	resetLazyInit();
});

afterEach(() => {
	closeDb();
});

describe("lazyInit", () => {
	it("clears pending-fixes on first call", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err"], gate: "lint" }]);
		resetAllCaches();
		lazyInit();
		resetAllCaches();
		expect(readPendingFixes()).toEqual([]);
	});

	it("is idempotent — second call is a no-op", () => {
		lazyInit();
		// Write fixes after first init
		writePendingFixes([{ file: "a.ts", errors: ["err"], gate: "lint" }]);
		// Second call should not clear them
		lazyInit();
		expect(readPendingFixes()).toHaveLength(1);
	});
});
