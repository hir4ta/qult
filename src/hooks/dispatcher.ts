import { join } from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { flushAll } from "../state/flush.ts";
import { setFixesSessionScope } from "../state/pending-fixes.ts";
import { setStateSessionScope } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { lazyInit } from "./lazy-init.ts";
import { setCurrentEvent } from "./respond.ts";

/**
 * Hook classification: enforcement hooks use exit 2 (DENY/block),
 * advisory hooks inject context or log to stderr (fail-open).
 */
export const HOOK_CLASS: Record<string, "enforcement" | "advisory"> = {
	"pre-tool": "enforcement", // DENY: pending-fixes, commit gates
	"post-tool": "enforcement", // Indirect: populates pending-fixes → pre-tool DENY
	stop: "enforcement", // block: pending-fixes, incomplete plan, no review
	"subagent-stop": "enforcement", // block: incomplete reviewer output
	"task-completed": "advisory", // plan task Verify execution
	"session-start": "advisory", // initialize state directory
	"post-compact": "advisory", // re-inject state summary after compaction
};

const EVENT_MAP: Record<string, () => Promise<{ default: (ev: HookEvent) => Promise<void> }>> = {
	"post-tool": () => import("./post-tool.ts"),
	"pre-tool": () => import("./pre-tool.ts"),
	stop: () => import("./stop.ts"),
	"subagent-stop": () => import("./subagent-stop/index.ts"),
	"task-completed": () => import("./task-completed.ts"),
	"session-start": () => import("./session-start.ts"),
	"post-compact": () => import("./post-compact.ts"),
};

let _lastWrittenSessionId: string | undefined;

export async function dispatch(event: string): Promise<void> {
	const loader = EVENT_MAP[event];
	if (!loader) {
		process.stderr.write(`Unknown hook event: ${event}\n`);
		process.exit(1);
	}

	let input: string;
	try {
		input = await new Promise<string>((resolve, reject) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => {
				data += chunk;
			});
			process.stdin.on("end", () => resolve(data));
			process.stdin.on("error", reject);
		});
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
		setStateSessionScope(ev.session_id);
		setFixesSessionScope(ev.session_id);
		if (ev.session_id !== _lastWrittenSessionId) {
			try {
				atomicWriteJson(join(process.cwd(), ".qult", ".state", "latest-session.json"), {
					session_id: ev.session_id,
					updated_at: new Date().toISOString(),
				});
				_lastWrittenSessionId = ev.session_id;
			} catch {
				/* fail-open */
			}
		}
	}

	lazyInit();

	const debug = !!process.env.QULT_DEBUG;
	setCurrentEvent(event);
	try {
		if (debug) process.stderr.write(`[qult:debug] event=${event} input=${input.length}b\n`);
		const start = Date.now();
		const handler = await loader();
		await handler.default(ev);
		if (debug) process.stderr.write(`[qult:debug] ${event} done in ${Date.now() - start}ms\n`);
	} catch (err) {
		if (err instanceof Error && !err.message.startsWith("process.exit")) {
			process.stderr.write(`[qult] ${event}: ${err.message}\n`);
		}
	} finally {
		try {
			flushAll();
		} catch {
			/* fail-open */
		}
		setCurrentEvent("unknown");
	}
}
