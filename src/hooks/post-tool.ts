import { existsSync } from "node:fs";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { loadGates, runGateGroup } from "../gates/index.js";
import {
	type PendingFixes,
	clearPendingFixes,
	formatPendingFixes,
	parseGateOutput,
	writePendingFixes,
} from "./pending-fixes.js";
import { readStateJSON, writeStateJSON } from "./state.js";
import { openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { insertQualityEvent } from "../store/quality-events.js";
import {
	isGitCommit,
	isTestCommand,
	isSourceFile,
	guessTestFile,
	extractTestFailures,
	countAssertions,
	extractCommandBase,
} from "./detect.js";

// Re-export for backward compat (tests, etc.)
export { isGitCommit, isTestCommand } from "./detect.js";

/**
 * PostToolUse handler: detection + DIRECTIVE injection.
 * Cannot block — uses DIRECTIVE to prompt Claude to fix issues.
 */
export async function postToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd || !ev.tool_name) return;

	const SKIP = new Set(["Read", "Grep", "Glob", "Agent"]);
	if (SKIP.has(ev.tool_name)) return;

	const items: DirectiveItem[] = [];
	const toolInput = (ev.tool_input ?? {}) as Record<string, unknown>;
	const toolResponse = (ev.tool_response ?? {}) as Record<string, unknown>;

	if (ev.tool_name === "Edit" || ev.tool_name === "Write") {
		await handleEditWrite(ev.cwd, toolInput, items, signal);
	} else if (ev.tool_name === "Bash") {
		await handleBash(ev.cwd, toolInput, toolResponse, items, signal);
	}

	emitDirectives("PostToolUse", items);
}

// ── Edit/Write handler ──────────────────────────────────────────────

async function handleEditWrite(
	cwd: string,
	toolInput: Record<string, unknown>,
	items: DirectiveItem[],
	signal: AbortSignal,
): Promise<void> {
	const filePath = (toolInput.file_path as string) ?? "";
	if (!filePath) return;
	if (!isSourceFile(filePath)) return;

	const gates = loadGates(cwd);
	if (!gates || Object.keys(gates.on_write).length === 0) return;

	const results = runGateGroup(cwd, gates.on_write, filePath);
	const failures = results.filter((r) => !r.passed);

	recordGateEvents(cwd, "on_write", results);

	if (failures.length > 0) {
		const fixes: PendingFixes = {
			files: {},
			updated_at: new Date().toISOString(),
		};

		for (const f of failures) {
			const entries = parseGateOutput(f.output, f.name);
			if (entries.length > 0) {
				const fileEntry = fixes.files[filePath] ?? {};
				if (f.name.includes("lint") || f.name === "lint") {
					fileEntry.lint = [...(fileEntry.lint ?? []), ...entries];
				} else {
					fileEntry.type = [...(fileEntry.type ?? []), ...entries];
				}
				fixes.files[filePath] = fileEntry;
			}
		}

		writePendingFixes(cwd, fixes);

		const formatted = formatPendingFixes(fixes);
		const summary = formatted || failures.map((f) => `${f.name}: ${f.output.slice(0, 200)}`).join("\n");

		items.push({
			level: "DIRECTIVE",
			message: `Fix the following lint/type errors in the file you just edited before continuing:\n${summary}`,
			spiritVsLetter: true,
		});
	} else {
		clearPendingFixes(cwd);
	}

	// Test adjacency check
	const testFile = guessTestFile(filePath);
	if (testFile && !existsSync(testFile)) {
		items.push({
			level: "WARNING",
			message: `No test file found for ${filePath}. Consider creating ${testFile}.`,
		});
	}
}

// ── Bash handler ────────────────────────────────────────────────────

async function handleBash(
	cwd: string,
	toolInput: Record<string, unknown>,
	toolResponse: Record<string, unknown>,
	items: DirectiveItem[],
	signal: AbortSignal,
): Promise<void> {
	const command = (toolInput.command as string) ?? "";
	const stdout = (toolResponse.stdout as string) ?? "";
	const stderr = (toolResponse.stderr as string) ?? "";
	const exitCode = (toolResponse.exitCode as number) ?? 0;

	if (isGitCommit(stdout)) {
		await handleGitCommit(cwd, items, signal);
		return;
	}

	if (isTestCommand(command)) {
		if (exitCode !== 0) {
			handleTestFailure(cwd, stdout, stderr, items);
			saveLastError(cwd, command, stderr || stdout);
		} else {
			handleTestSuccess(cwd, stdout, items);
			clearLastError(cwd);
		}
		return;
	}

	if (exitCode !== 0 && (stderr || stdout)) {
		saveLastError(cwd, command, stderr || stdout);
		recordErrorEvent(cwd, "error_miss", { command, error: (stderr || stdout).slice(0, 500) });
	} else if (exitCode === 0) {
		handlePotentialResolution(cwd, command, stdout);
	}
}

// ── Git commit gate ─────────────────────────────────────────────────

async function handleGitCommit(
	cwd: string,
	items: DirectiveItem[],
	signal: AbortSignal,
): Promise<void> {
	const gates = loadGates(cwd);
	if (!gates || Object.keys(gates.on_commit).length === 0) return;

	const results = runGateGroup(cwd, gates.on_commit);
	const failures = results.filter((r) => !r.passed);
	recordGateEvents(cwd, "on_commit", results);

	if (failures.length > 0) {
		const summary = failures.map((f) => `${f.name}: ${f.output.slice(0, 300)}`).join("\n");
		items.push({
			level: "DIRECTIVE",
			message: `Commit gate failed. Fix before continuing:\n${summary}`,
			spiritVsLetter: true,
		});
	}

	items.push({
		level: "DIRECTIVE",
		message:
			"Before moving on, verify:\n" +
			"1. Edge cases — List 3 edge cases. Are they handled or tested?\n" +
			"2. Silent failure — Could this produce wrong output without crashing?\n" +
			"3. Simplicity — Is there a simpler approach?\n" +
			"4. Conventions — Does this match project patterns?",
	});
}

// ── Test result handlers ────────────────────────────────────────────

function handleTestFailure(cwd: string, stdout: string, stderr: string, items: DirectiveItem[]): void {
	recordGateEvents(cwd, "test", [{ name: "test", passed: false, output: (stderr || stdout).slice(0, 500), duration: 0 }]);
	const failSummary = extractTestFailures(stdout + "\n" + stderr);
	items.push({
		level: "DIRECTIVE",
		message: `Test failed. Fix the failing tests before continuing:\n${failSummary}`,
	});
}

function handleTestSuccess(cwd: string, stdout: string, items: DirectiveItem[]): void {
	recordGateEvents(cwd, "test", [{ name: "test", passed: true, output: "", duration: 0 }]);
	const assertionCount = countAssertions(stdout);
	if (assertionCount !== null && assertionCount < 2) {
		items.push({
			level: "WARNING",
			message: `Test passed but has only ${assertionCount} assertion(s). Consider adding edge case assertions (minimum 2 recommended).`,
		});
		recordQualityEventSafe(cwd, "assertion_warning", { assertionCount });
	}
}

// ── error_resolution auto-accumulation ──────────────────────────────

const LAST_ERROR_FILE = "last-error.json";

interface LastError {
	command: string;
	error: string;
	timestamp: string;
}

function saveLastError(cwd: string, command: string, error: string): void {
	writeStateJSON(cwd, LAST_ERROR_FILE, {
		command,
		error: error.slice(0, 2000),
		timestamp: new Date().toISOString(),
	});
}

function clearLastError(cwd: string): void {
	writeStateJSON(cwd, LAST_ERROR_FILE, null);
}

function handlePotentialResolution(cwd: string, successCommand: string, _stdout: string): void {
	const lastError = readStateJSON<LastError | null>(cwd, LAST_ERROR_FILE, null);
	if (!lastError) return;

	const errorBase = extractCommandBase(lastError.command);
	const successBase = extractCommandBase(successCommand);
	if (errorBase !== successBase) return;

	const age = Date.now() - new Date(lastError.timestamp).getTime();
	if (age > 10 * 60 * 1000) {
		clearLastError(cwd);
		return;
	}

	recordQualityEventSafe(cwd, "error_hit", {
		error_command: lastError.command,
		error_snippet: lastError.error.slice(0, 500),
		resolution_command: successCommand,
	});

	clearLastError(cwd);
}

// ── Quality event recording (fail-open) ─────────────────────────────

import type { GateResult } from "../gates/index.js";

function recordGateEvents(cwd: string, group: string, results: GateResult[]): void {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		const sessionId = getSessionId();
		for (const r of results) {
			insertQualityEvent(store, project.id, sessionId, r.passed ? "gate_pass" : "gate_fail", {
				group,
				gate: r.name,
				duration: r.duration,
				output: r.output.slice(0, 300),
			});
		}
	} catch { /* fail-open */ }
}

function recordErrorEvent(cwd: string, type: "error_hit" | "error_miss", data: Record<string, unknown>): void {
	recordQualityEventSafe(cwd, type, data);
}

function recordQualityEventSafe(
	cwd: string,
	eventType: import("../types.js").QualityEventType,
	data: Record<string, unknown>,
): void {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		insertQualityEvent(store, project.id, getSessionId(), eventType, data);
	} catch { /* fail-open */ }
}

let _sessionId: string | undefined;
function getSessionId(): string {
	if (!_sessionId) {
		_sessionId = `session-${Date.now()}`;
	}
	return _sessionId;
}
