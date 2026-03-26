import { resetBudget } from "../state/context-budget.ts";
import type { HookEvent } from "../types.ts";

const EVENT_MAP: Record<string, () => Promise<{ default: (ev: HookEvent) => Promise<void> }>> = {
	"post-tool": () => import("./post-tool.ts"),
	"pre-tool": () => import("./pre-tool.ts"),
	"user-prompt": () => import("./user-prompt.ts"),
	"session-start": () => import("./session-start.ts"),
	stop: () => import("./stop.ts"),
	"pre-compact": () => import("./pre-compact.ts"),
	"post-compact": () => import("./post-compact.ts"),
	"permission-request": () => import("./permission-request.ts"),
	"task-completed": () => import("./task-completed.ts"),
	"subagent-start": () => import("./subagent-start.ts"),
	"subagent-stop": () => import("./subagent-stop.ts"),
	"post-tool-failure": () => import("./post-tool-failure.ts"),
	"session-end": () => import("./session-end.ts"),
	"config-change": () => import("./config-change.ts"),
};

export async function dispatch(event: string): Promise<void> {
	const loader = EVENT_MAP[event];
	if (!loader) {
		process.stderr.write(`Unknown hook event: ${event}\n`);
		process.exit(1);
	}

	let input: string;
	try {
		const { readFileSync } = require("node:fs");
		input = readFileSync("/dev/stdin", "utf-8");
	} catch {
		return; // fail-open: stdin read error
	}
	if (!input || input.length > 5_000_000) return; // fail-open

	let ev: HookEvent;
	try {
		ev = JSON.parse(input);
	} catch {
		return; // fail-open: invalid JSON
	}

	if (ev.session_id) {
		resetBudget(ev.session_id);
	}

	try {
		const handler = await loader();
		await handler.default(ev);
	} catch (err) {
		if (err instanceof Error && !err.message.startsWith("process.exit")) {
			process.stderr.write(`[alfred] ${event}: ${err.message}\n`);
		}
	}
}
