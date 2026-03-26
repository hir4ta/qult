/**
 * Detection helpers — pure functions, no DB dependency.
 * Extracted so they can be tested under vitest (no bun:sqlite).
 */

/**
 * Detect git commit from Bash stdout.
 */
export function isGitCommit(stdout: string): boolean {
	if (!stdout) return false;
	return (
		/\[[\w./-]+ [0-9a-f]+\]/.test(stdout) ||
		(stdout.includes("files changed") &&
			(stdout.includes("insertion") || stdout.includes("deletion"))) ||
		/Merge made by the/.test(stdout) ||
		/Fast-forward/.test(stdout) ||
		/Successfully rebased/.test(stdout) ||
		/cherry-picked/i.test(stdout)
	);
}

/**
 * Detect test commands — comprehensive coverage of test runners and wrappers.
 */
export function isTestCommand(command: string): boolean {
	if (!command) return false;

	// Direct test runners
	if (
		/\b(?:vitest|jest|mocha|ava|tap|nyc|c8|cypress\s+run|playwright\s+test|pytest|python\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|dotnet\s+test|rspec|minitest|phpunit|mix\s+test|dart\s+test|flutter\s+test|swift\s+test|deno\s+test|bun\s+test)\b/.test(
			command,
		)
	) {
		return true;
	}

	// Package manager test commands
	if (/\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test(?:\s|$|:)/.test(command)) {
		return true;
	}

	// Task runner test targets
	if (/\b(?:task|make|rake|gradle|mvn|ant|bazel)\s+test(?:\s|$)/.test(command)) {
		return true;
	}

	// Wrapper prefixes
	if (
		/\b(?:npx|bunx|pnpx)\s+(?:vitest|jest|mocha|ava|tap|c8|nyc|playwright|cypress)\b/.test(command)
	) {
		return true;
	}

	return false;
}

/**
 * Check if a file path looks like source code (not config/lock/etc).
 */
export function isSourceFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mts", "mjs", "py", "go", "rs"]);
	if (!SOURCE_EXTS.has(ext)) return false;
	if (/\.(test|spec)\.[^.]+$/.test(filePath)) return false;
	if (/\b(config|\.config)\b/.test(filePath)) return false;
	return true;
}

/**
 * Guess the test file path for a source file.
 */
export function guessTestFile(filePath: string): string | null {
	const match = filePath.match(/^(.+)\.(ts|tsx|js|jsx|mts|py|go|rs)$/);
	if (!match) return null;
	const [, base, ext] = match;
	if (!base || !ext) return null;
	if (/\.(test|spec)$/.test(base)) return null;
	return `${base}.test.${ext}`;
}

/**
 * Extract test failure summary from output.
 */
export function extractTestFailures(output: string): string {
	const lines = output.split("\n");
	const failures: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (
			/^\s*(FAIL|✗|×|✕)\s/.test(trimmed) ||
			/AssertionError|Expected|Received|toBe|toEqual/.test(trimmed) ||
			/Error:/.test(trimmed)
		) {
			failures.push(trimmed);
		}
	}

	return failures.slice(0, 10).join("\n") || output.slice(0, 500);
}

/**
 * Count assertions from test output.
 * Returns null if can't determine.
 */
export function countAssertions(stdout: string): number | null {
	const assertMatch = stdout.match(/(\d+)\s+assertion/i);
	if (assertMatch) return Number.parseInt(assertMatch[1]!, 10);

	const expectMatch = stdout.match(/(\d+)\s+expect/i);
	if (expectMatch) return Number.parseInt(expectMatch[1]!, 10);

	return null;
}

/**
 * Extract base command name for matching error → resolution pairs.
 */
export function extractCommandBase(command: string): string {
	const parts = command.trim().split(/\s+/);
	for (const part of parts) {
		if (part.includes("=") || part === "npx" || part === "bunx" || part === "env") continue;
		return part;
	}
	return parts[0] ?? command;
}

/**
 * Detect plan files (.claude/plans/*.md or plan*.md).
 */
export function isPlanFile(filePath: string): boolean {
	return /\.claude\/plans\/.*\.md$/.test(filePath) || /\/plan[^/]*\.md$/i.test(filePath);
}

/**
 * Extract commit message from git commit stdout (only if >50 chars).
 */
export interface PlanValidation {
	hasPhases: boolean;
	phaseCount: number;
	phasesWithCriteria: number;
	hasTestPlan: boolean;
}

export function validatePlanStructure(content: string): PlanValidation {
	const phases = (content.match(/^###?\s+Phase\s+\d/gim) || []).length;
	const criteria = (content.match(/acceptance\s+criteria/gi) || []).length;
	const testPlan = /test\s+plan/i.test(content);
	return {
		hasPhases: phases > 0,
		phaseCount: phases,
		phasesWithCriteria: Math.min(criteria, phases),
		hasTestPlan: testPlan,
	};
}

// ===== Plan Criteria Extraction =====

export interface PlanPhase {
	name: string;
	files: string[];
	criteria: string[];
}

/**
 * Extract structured plan criteria for drift detection.
 * Parses phases, file lists, and acceptance criteria from plan markdown.
 */
export function extractPlanCriteria(content: string): PlanPhase[] {
	const phases: PlanPhase[] = [];
	const sections = content.split(/^###?\s+Phase\s+\d+\s*[:.]\s*/gim);

	// First section is preamble, skip it
	const phaseHeaders = content.match(/^###?\s+Phase\s+\d+\s*[:.]\s*(.*)/gim) || [];

	for (let i = 0; i < phaseHeaders.length; i++) {
		const header = phaseHeaders[i]!;
		const name = header.replace(/^###?\s+/, "").trim();
		const body = sections[i + 1] ?? "";

		// Extract file paths (lines containing file-like patterns)
		const files: string[] = [];
		const fileMatches = body.match(/[`"]?([\w/.]+\.\w{1,5})[`"]?/g) || [];
		for (const m of fileMatches) {
			const clean = m.replace(/[`"]/g, "");
			if (clean.includes("/") && clean.includes(".")) {
				files.push(clean);
			}
		}

		// Extract acceptance criteria (bulleted items after "Acceptance Criteria" heading)
		// Handles both plain "Acceptance Criteria:" and bold "**Acceptance Criteria**:"
		const criteria: string[] = [];
		const criteriaMatch = body.match(
			/\*?\*?acceptance\s+criteria\*?\*?\s*:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i,
		);
		if (criteriaMatch) {
			const items = criteriaMatch[1]!.match(/[-*]\s+(.+)/g) || [];
			for (const item of items) {
				criteria.push(item.replace(/^[-*]\s+/, "").trim());
			}
		}

		phases.push({ name, files: [...new Set(files)], criteria });
	}

	return phases;
}

export function extractCommitMessage(stdout: string): string | null {
	const match = stdout.match(/\[[\w./-]+ [0-9a-f]+\]\s+(.+)/);
	if (match?.[1] && match[1].length > 50) return match[1];
	return null;
}
