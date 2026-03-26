import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runGate } from "../gates/runner.ts";
import { writePendingFixes } from "../state/pending-fixes.ts";
import type { GatesConfig, HookEvent, HookResponse, PendingFix } from "../types.ts";

/** PostToolUse: lint/type gate after Edit/Write, test gate after git commit */
export default async function postTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;
	if (!tool) return;

	if (tool === "Edit" || tool === "Write") {
		await handleEditWrite(ev);
	} else if (tool === "Bash") {
		await handleBash(ev);
	}
}

async function handleEditWrite(ev: HookEvent): Promise<void> {
	const file = ev.tool_input?.file_path as string | undefined;
	if (!file) return;

	const gates = loadGates();
	if (!gates?.on_write) return;

	const fixes: PendingFix[] = [];
	const messages: string[] = [];

	for (const [name, gate] of Object.entries(gates.on_write)) {
		const hasPlaceholder = gate.command.includes("{file}");
		const result = runGate(name, gate, hasPlaceholder ? file : undefined);

		if (!result.passed) {
			fixes.push({ file, errors: [result.output], gate: name });
			messages.push(`[${name}] ${result.output.slice(0, 200)}`);
		}
	}

	if (fixes.length > 0) {
		writePendingFixes(fixes);
		respond(`Fix these errors before continuing:\n${messages.join("\n")}`);
	} else {
		// Clear fixes on success
		writePendingFixes([]);
	}
}

async function handleBash(ev: HookEvent): Promise<void> {
	const command = ev.tool_input?.command as string | undefined;
	if (!command) return;

	// Detect git commit
	if (/\bgit\s+commit\b/.test(command)) {
		const gates = loadGates();
		if (!gates?.on_commit) return;

		const messages: string[] = [];
		for (const [name, gate] of Object.entries(gates.on_commit)) {
			const result = runGate(name, gate);
			if (!result.passed) {
				messages.push(`[${name}] ${result.output.slice(0, 200)}`);
			}
		}

		if (messages.length > 0) {
			respond(`Tests failed after commit:\n${messages.join("\n")}`);
		}
	}
}

function loadGates(): GatesConfig | null {
	try {
		const path = join(process.cwd(), ".alfred", "gates.json");
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function respond(context: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}
