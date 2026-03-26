import { resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { runGate } from "../gates/runner.ts";
import { readPace, writePace } from "../state/pace.ts";
import { readPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent, PendingFix } from "../types.ts";
import { respond } from "./respond.ts";

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

	for (const [name, gate] of Object.entries(gates.on_write)) {
		try {
			const hasPlaceholder = gate.command.includes("{file}");
			const result = runGate(name, gate, hasPlaceholder ? file : undefined);

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

	if (/\bgit\s+commit\b/.test(command)) {
		writePace({ last_commit_at: new Date().toISOString(), changed_files: 0, tool_calls: 0 });

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
	}
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
