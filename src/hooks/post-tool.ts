import { extname, resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { runGate } from "../gates/runner.ts";
import { readPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import {
	clearOnCommit,
	getGatedExtensions,
	markGateRan,
	recordChangedFile,
	recordTestPass,
	shouldSkipGate,
} from "../state/session-state.ts";
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

	// Skip qult's own state/config files
	const qultDir = resolve(process.cwd(), ".qult");
	if (file.startsWith(`${qultDir}/`) || file === qultDir) return;

	const gates = loadGates();
	if (!gates?.on_write) return;

	// File extension filter: skip per-file gates for extensions not covered by any gate tool
	const fileExt = extname(file).toLowerCase();
	const gatedExts = getGatedExtensions();

	// Read existing fixes once — compute both "other files" and "had fixes for this file"
	const before = readPendingFixes();
	const existingFixes = before.filter((f) => f.file !== file);
	const newFixes: PendingFix[] = [];
	const messages: string[] = [];

	const sessionId = ev.session_id;

	for (const [name, gate] of Object.entries(gates.on_write)) {
		try {
			// Skip run_once_per_batch gates if already ran in this session
			if (gate.run_once_per_batch && sessionId && shouldSkipGate(name, sessionId)) {
				continue;
			}

			const hasPlaceholder = gate.command.includes("{file}");

			// Skip per-file gates for extensions not covered by any gate tool
			if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt)) {
				continue;
			}
			const result = runGate(name, gate, hasPlaceholder ? file : undefined);

			if (gate.run_once_per_batch && sessionId) {
				markGateRan(name, sessionId);
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

	// Record changed file path for gated-file review threshold
	try {
		recordChangedFile(file);
	} catch {
		/* fail-open */
	}

	if (newFixes.length > 0) {
		respond(`Fix these errors before continuing:\n${messages.join("\n")}`);
	}
}

function handleBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;

	// Detect git commit → reset state + run on_commit gates
	if (/\bgit\s+commit\b/.test(command)) {
		clearOnCommit();

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

	// Detect lint fix command → re-validate pending fixes
	if (
		/\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/.test(
			command,
		)
	) {
		revalidatePendingFixes();
	}

	// Detect test command → record pass
	if (TEST_CMD_RE.test(command)) {
		const output = getToolOutput(ev);
		const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i);
		const isError = exitCodeMatch ? Number(exitCodeMatch[1]) !== 0 : false;

		if (!isError) {
			recordTestPass(command);
		}
	}
}

/** Extract tool output as string from tool_response (official) or tool_output (legacy) */
function getToolOutput(ev: HookEvent): string {
	if (ev.tool_response != null && typeof ev.tool_response === "object") {
		const resp = ev.tool_response as Record<string, unknown>;
		const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
		const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
		return (stdout + stderr).trim();
	}
	if (typeof ev.tool_output === "string") return ev.tool_output;
	return "";
}

/** Re-run on_write gates on files with pending fixes. Clear fixes for files that now pass. */
function revalidatePendingFixes(): void {
	try {
		const fixes = readPendingFixes();
		if (fixes.length === 0) return;

		const gates = loadGates();
		if (!gates?.on_write) return;

		const remaining = fixes.filter((fix) => {
			for (const [name, gate] of Object.entries(gates.on_write!)) {
				const hasPlaceholder = gate.command.includes("{file}");
				if (!hasPlaceholder) continue;
				try {
					const result = runGate(name, gate, fix.file);
					if (!result.passed) return true; // still failing
				} catch {
					return true; // fail-open: keep the fix
				}
			}
			return false; // all gates passed
		});

		writePendingFixes(remaining);
	} catch {
		// fail-open
	}
}
