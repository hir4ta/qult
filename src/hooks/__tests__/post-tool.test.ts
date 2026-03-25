/**
 * Detection helper tests — pure functions from detect.ts (no DB dependency).
 */
import { describe, expect, it } from "vitest";
import {
	isGitCommit,
	isTestCommand,
	isSourceFile,
	guessTestFile,
	extractTestFailures,
	countAssertions,
	extractCommandBase,
} from "../detect.js";

describe("isGitCommit", () => {
	it("detects standard git commit output", () => {
		expect(isGitCommit("[main abc1234] feat: add foo")).toBe(true);
	});

	it("detects commit with stats (plural)", () => {
		expect(isGitCommit("3 files changed, 5 insertions(+), 2 deletions(-)")).toBe(true);
	});

	it("returns false for singular file changed (ambiguous)", () => {
		// "1 file changed" doesn't match "files changed" — this is intentional
		// (could be unrelated output)
		expect(isGitCommit("1 file changed, 5 insertions(+)")).toBe(false);
	});

	it("detects merge commits", () => {
		expect(isGitCommit("Merge made by the 'ort' strategy.")).toBe(true);
	});

	it("detects fast-forward", () => {
		expect(isGitCommit("Fast-forward")).toBe(true);
	});

	it("detects rebase", () => {
		expect(isGitCommit("Successfully rebased and updated refs/heads/main")).toBe(true);
	});

	it("detects cherry-pick", () => {
		expect(isGitCommit("cherry-picked from commit abc1234")).toBe(true);
	});

	it("returns false for empty", () => {
		expect(isGitCommit("")).toBe(false);
	});

	it("returns false for regular output", () => {
		expect(isGitCommit("Hello world")).toBe(false);
	});
});

describe("isTestCommand", () => {
	// Direct runners
	it("detects vitest", () => expect(isTestCommand("vitest run")).toBe(true));
	it("detects jest", () => expect(isTestCommand("jest --coverage")).toBe(true));
	it("detects pytest", () => expect(isTestCommand("pytest -v tests/")).toBe(true));
	it("detects go test", () => expect(isTestCommand("go test ./...")).toBe(true));
	it("detects cargo test", () => expect(isTestCommand("cargo test")).toBe(true));
	it("detects mocha", () => expect(isTestCommand("mocha tests/")).toBe(true));
	it("detects bun test", () => expect(isTestCommand("bun test")).toBe(true));
	it("detects deno test", () => expect(isTestCommand("deno test")).toBe(true));

	// Package manager wrappers
	it("detects npm test", () => expect(isTestCommand("npm test")).toBe(true));
	it("detects npm run test", () => expect(isTestCommand("npm run test")).toBe(true));
	it("detects yarn test", () => expect(isTestCommand("yarn test")).toBe(true));
	it("detects pnpm test", () => expect(isTestCommand("pnpm test")).toBe(true));

	// Task runner wrappers
	it("detects task test", () => expect(isTestCommand("task test")).toBe(true));
	it("detects make test", () => expect(isTestCommand("make test")).toBe(true));

	// Wrapper prefixes
	it("detects npx vitest", () => expect(isTestCommand("npx vitest run")).toBe(true));
	it("detects bunx jest", () => expect(isTestCommand("bunx jest --watch")).toBe(true));

	// E2E
	it("detects playwright test", () => expect(isTestCommand("playwright test")).toBe(true));
	it("detects cypress run", () => expect(isTestCommand("cypress run")).toBe(true));

	// Negatives
	it("returns false for empty", () => expect(isTestCommand("")).toBe(false));
	it("returns false for regular commands", () => expect(isTestCommand("ls -la")).toBe(false));
	it("returns false for build commands", () => expect(isTestCommand("npm run build")).toBe(false));
});

describe("isSourceFile", () => {
	it("accepts .ts files", () => expect(isSourceFile("src/foo.ts")).toBe(true));
	it("accepts .py files", () => expect(isSourceFile("lib/bar.py")).toBe(true));
	it("rejects test files", () => expect(isSourceFile("src/foo.test.ts")).toBe(false));
	it("rejects spec files", () => expect(isSourceFile("src/foo.spec.ts")).toBe(false));
	it("rejects config files", () => expect(isSourceFile("vitest.config.ts")).toBe(false));
	it("rejects json files", () => expect(isSourceFile("package.json")).toBe(false));
	it("rejects lock files", () => expect(isSourceFile("bun.lockb")).toBe(false));
});

describe("guessTestFile", () => {
	it("guesses .test.ts for .ts", () => expect(guessTestFile("src/foo.ts")).toBe("src/foo.test.ts"));
	it("guesses .test.py for .py", () => expect(guessTestFile("lib/bar.py")).toBe("lib/bar.test.py"));
	it("returns null for test files", () => expect(guessTestFile("src/foo.test.ts")).toBe(null));
	it("returns null for non-source", () => expect(guessTestFile("readme.md")).toBe(null));
});

describe("extractTestFailures", () => {
	it("extracts FAIL lines", () => {
		const output = "  FAIL src/foo.test.ts\n  ✓ passing test\n  ✗ failing test";
		const result = extractTestFailures(output);
		expect(result).toContain("FAIL");
	});

	it("extracts assertion errors", () => {
		const output = "AssertionError: expected 1 to be 2";
		expect(extractTestFailures(output)).toContain("AssertionError");
	});

	it("falls back to raw output when no patterns match", () => {
		const output = "some random error output";
		expect(extractTestFailures(output).length).toBeGreaterThan(0);
	});
});

describe("countAssertions", () => {
	it("detects assertion count", () => {
		expect(countAssertions("5 assertions passed")).toBe(5);
	});

	it("returns null for unknown format", () => {
		expect(countAssertions("all tests passed")).toBe(null);
	});
});

describe("extractCommandBase", () => {
	it("extracts first meaningful command", () => {
		expect(extractCommandBase("vitest run --watch")).toBe("vitest");
	});

	it("skips npx prefix", () => {
		expect(extractCommandBase("npx vitest")).toBe("vitest");
	});

	it("skips env vars", () => {
		expect(extractCommandBase("NODE_ENV=test vitest")).toBe("vitest");
	});
});
