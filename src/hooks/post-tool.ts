import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { runGate } from "../gates/runner.ts";
import { clearFailCount, recordFailure } from "../state/fail-count.ts";
import { clearBatch, markRan, shouldSkip } from "../state/gate-batch.ts";
import { clearReview } from "../state/last-review.ts";
import { clearTestPass, recordTestPass } from "../state/last-test-pass.ts";
import { readPace, writePace } from "../state/pace.ts";
import { readPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan, parseVerifyFields } from "../state/plan-status.ts";
import type { HookEvent, PendingFix } from "../types.ts";
import { respond } from "./respond.ts";

const TEST_CMD_RE = /\b(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;

/** PostToolUse: lint/type gate after Edit/Write, test gate after git commit */
export default async function postTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;
	if (!tool) return;

	if (tool === "Edit" || tool === "Write") {
		handleEditWrite(ev);
	} else if (tool === "Bash") {
		handleBash(ev);
	}
}

function handleEditWrite(ev: HookEvent): void {
	const rawFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
	if (!rawFile) return;
	const file = resolve(rawFile);

	const gates = loadGates();
	if (!gates?.on_write) return;

	// Read existing fixes for OTHER files
	const existingFixes = readPendingFixes().filter((f) => f.file !== file);
	const newFixes: PendingFix[] = [];
	const messages: string[] = [];

	const sessionId = ev.session_id;

	for (const [name, gate] of Object.entries(gates.on_write)) {
		try {
			// Skip run_once_per_batch gates if already ran in this session
			if (gate.run_once_per_batch && sessionId && shouldSkip(name, sessionId)) {
				continue;
			}

			const hasPlaceholder = gate.command.includes("{file}");
			const result = runGate(name, gate, hasPlaceholder ? file : undefined);

			if (gate.run_once_per_batch && sessionId) {
				markRan(name, sessionId);
			}

			if (!result.passed) {
				newFixes.push({ file, errors: [result.output], gate: name });
				messages.push(`[${name}] ${result.output.slice(0, 200)}`);
			}
		} catch {
			// fail-open: gate execution error
		}
	}

	writePendingFixes([...existingFixes, ...newFixes]);

	if (newFixes.length > 0) {
		respond(`Fix these errors before continuing:\n${messages.join("\n")}`);
	}

	// Update pace tracking
	updatePace();
}

function handleBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;

	// Detect git commit → reset pace + run on_commit gates
	if (/\bgit\s+commit\b/.test(command)) {
		writePace({ last_commit_at: new Date().toISOString(), changed_files: 0, tool_calls: 0 });
		clearFailCount();
		clearBatch();
		clearTestPass();
		clearReview();

		const gates = loadGates();
		if (!gates?.on_commit) return;

		const messages: string[] = [];
		for (const [name, gate] of Object.entries(gates.on_commit)) {
			try {
				const result = runGate(name, gate);
				if (!result.passed) {
					messages.push(`[${name}] ${result.output.slice(0, 200)}`);
				}
			} catch {
				// fail-open
			}
		}

		if (messages.length > 0) {
			respond(`Tests failed after commit:\n${messages.join("\n")}`);
		}
		return;
	}

	// Detect Bash failure → track consecutive failures
	const output = getToolOutput(ev);
	const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i);
	const isError = exitCodeMatch ? Number(exitCodeMatch[1]) !== 0 : false;

	if (isError) {
		const signature = output.slice(0, 200);
		const count = recordFailure(signature);
		if (count >= 2) {
			respond(
				"Same error 2 times in a row. Consider running /clear and trying a different approach.",
			);
		}
	} else if (output.length > 0) {
		clearFailCount();
	}

	// Detect test command → record pass + verify against Plan's Verify fields
	if (TEST_CMD_RE.test(command)) {
		if (!isError) {
			recordTestPass(command);
		}
		checkVerifyFields(output);
	}
}

function checkVerifyFields(output: string): void {
	try {
		const plan = getActivePlan();
		if (!plan) return;

		const content = readFileSync(plan.path, "utf-8");
		const verifies = parseVerifyFields(content);
		if (verifies.length === 0) return;

		const messages: string[] = [];
		for (const v of verifies) {
			if (!v.testFunction) continue;
			if (output.includes(v.testFunction)) {
				messages.push(`[pass] Task "${v.taskName}" — ${v.testFunction} found in test output`);
			} else {
				messages.push(`[miss] Task "${v.taskName}" — ${v.testFunction} not found in test output`);
			}
		}

		if (messages.length > 0) {
			respond(`Plan verify check:\n${messages.join("\n")}`);
		}
	} catch {
		// fail-open
	}
}

/** Extract tool output as string from tool_response (official) or tool_output (legacy) */
function getToolOutput(ev: HookEvent): string {
	// Official schema: tool_response is { stdout, stderr, ... } for Bash
	if (ev.tool_response != null && typeof ev.tool_response === "object") {
		const resp = ev.tool_response as Record<string, unknown>;
		const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
		const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
		return (stdout + stderr).trim();
	}
	// Legacy fallback
	if (typeof ev.tool_output === "string") return ev.tool_output;
	return "";
}

function updatePace(): void {
	try {
		const pace = readPace() ?? {
			last_commit_at: new Date().toISOString(),
			changed_files: 0,
			tool_calls: 0,
		};
		pace.changed_files++;
		pace.tool_calls++;
		writePace(pace);
	} catch {
		// fail-open
	}
}
