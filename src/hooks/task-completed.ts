import { spawnSync } from "node:child_process";
import { loadGates } from "../gates/load.ts";
import { getActivePlan, parseVerifyField } from "../state/plan-status.ts";
import { incrementEscalation, recordTaskVerifyResult } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { analyzeTestQuality, formatTestQualityWarnings } from "./detectors/test-quality-check.ts";

const TEST_RUNNER_RE: [RegExp, (file: string, testName: string) => string[]][] = [
	[/\bvitest\b/, (f, t) => ["vitest", "run", f, "-t", t]],
	[/\bjest\b/, (f, t) => ["jest", f, "-t", t]],
	[/\bpytest\b/, (f, t) => ["pytest", f, "-k", t]],
	[/\bgo\s+test\b/, (f, _t) => ["go", "test", `./${f}`]],
	[/\bcargo\s+test\b/, (_f, t) => ["cargo", "test", t]],
	[/\bmocha\b/, (f, t) => ["mocha", f, "--grep", t]],
];

const VERIFY_TIMEOUT = 15_000;

/** Only allow safe characters in shell arguments (alphanumeric, path separators, dots, hyphens, underscores, @). */
const SAFE_SHELL_ARG_RE = /^[a-zA-Z0-9_/.@-]+$/;

/** TaskCompleted: verify plan task's Verify field by running the specified test. */
export default async function taskCompleted(ev: HookEvent): Promise<void> {
	const subject = ev.task_subject;
	if (!subject) return;

	const plan = getActivePlan();
	if (!plan) return;

	// Match task: prefer task number, then exact name match (no substring fallback)
	const taskNumMatch = subject.match(/\bTask\s+(\d+)\b/i);
	const task = taskNumMatch
		? plan.tasks.find((t) => t.taskNumber === Number(taskNumMatch[1]))
		: plan.tasks.find((t) => t.name === subject);
	if (!task?.verify) return;

	const parsed = parseVerifyField(task.verify);
	if (!parsed) return;

	// Reject arguments containing shell metacharacters
	if (!SAFE_SHELL_ARG_RE.test(parsed.file) || !SAFE_SHELL_ARG_RE.test(parsed.testName)) return;

	// Detect test runner from on_commit gates
	const argsBuilder = detectTestRunner();
	if (!argsBuilder) return; // fail-open: no test runner detected

	const args = argsBuilder(parsed.file, parsed.testName);

	const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;

	try {
		const result = spawnSync(args[0]!, args.slice(1), {
			cwd: process.cwd(),
			timeout: VERIFY_TIMEOUT,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`,
			},
		});
		const passed = result.status === 0;
		try {
			recordTaskVerifyResult(taskKey, passed);
		} catch {
			/* fail-open */
		}
	} catch {
		// spawnSync itself threw (e.g. command not found) — fail-open
	}

	// L3: Verify test quality check — warn on shallow tests (fail-open, non-blocking)
	try {
		checkVerifyTestQuality(parsed.file, parsed.testName, taskKey);
	} catch {
		/* fail-open */
	}
}

/** Check that the Verify test file contains meaningful assertions and no test smells.
 *  Uses the comprehensive test-quality-check detector. Warns to stderr if issues found. */
export function checkVerifyTestQuality(testFile: string, _testName: string, taskKey: string): void {
	const result = analyzeTestQuality(testFile);
	if (!result) return;

	const warnings = formatTestQualityWarnings(testFile, result, taskKey);
	if (warnings.length > 0) {
		incrementEscalation("test_quality_warning_count");
		for (const w of warnings) {
			process.stderr.write(`[qult] Test quality: ${w}\n`);
		}
	}
}

/** Detect test runner from on_commit gate commands. Returns args builder or null. */
function detectTestRunner(): ((file: string, testName: string) => string[]) | null {
	try {
		const gates = loadGates();
		if (!gates?.on_commit) return null;

		for (const gate of Object.values(gates.on_commit)) {
			for (const [pattern, builder] of TEST_RUNNER_RE) {
				if (pattern.test(gate.command)) {
					return builder;
				}
			}
		}
	} catch {
		// fail-open
	}
	return null;
}
