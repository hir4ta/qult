import { execSync } from "node:child_process";
import { basename } from "node:path";
import { flushAll } from "../state/flush.ts";
import { setMetricsContext } from "../state/metrics.ts";
import { setFixesSessionScope } from "../state/pending-fixes.ts";
import { resetBudget, setStateSessionScope } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { setCurrentEvent } from "./respond.ts";

/** Resolve git branch and user once per process (cached). */
let _gitContext: { branch: string; user: string } | null = null;
function getGitContext(cwd: string): { branch: string; user: string } {
	if (_gitContext) return _gitContext;
	try {
		const branch = execSync("git branch --show-current", {
			cwd,
			encoding: "utf-8",
			timeout: 2000,
		}).trim();
		const user =
			execSync("git config user.name", { cwd, encoding: "utf-8", timeout: 2000 }).trim() ||
			process.env.USER ||
			"";
		_gitContext = { branch, user };
	} catch {
		_gitContext = { branch: "", user: process.env.USER || "" };
	}
	return _gitContext;
}

/**
 * Hook classification: enforcement hooks use exit 2 (DENY/block),
 * advisory hooks inject context or log to stderr (fail-open).
 *
 * "Every component in a harness encodes an assumption about what the model
 * can't do on its own, and those assumptions are worth stress testing."
 * — Anthropic, Harness Design for Long-Running Apps (2026-03-24)
 */
export const HOOK_CLASS: Record<string, "enforcement" | "advisory"> = {
	"pre-tool": "enforcement", // DENY: pending-fixes, pace red, commit gates
	"post-tool": "enforcement", // Indirect: populates pending-fixes → pre-tool DENY
	stop: "enforcement", // block: pending-fixes, incomplete plan, no review
	"permission-request": "enforcement", // DENY: malformed plan on ExitPlanMode
	"config-change": "enforcement", // DENY: prevents hook deletion
	"subagent-stop": "enforcement", // block: incomplete reviewer output
	"session-start": "advisory", // respond: error trends
	"user-prompt": "advisory", // respond: plan template
	"subagent-start": "advisory", // respond: quality rules
	"post-tool-failure": "advisory", // respond: /clear suggestion
	"pre-compact": "advisory", // stderr: pending-fixes reminder
	"post-compact": "advisory", // stderr: structured handoff after compaction
};

const EVENT_MAP: Record<string, () => Promise<{ default: (ev: HookEvent) => Promise<void> }>> = {
	"post-tool": () => import("./post-tool.ts"),
	"pre-tool": () => import("./pre-tool.ts"),
	"user-prompt": () => import("./user-prompt.ts"),
	"session-start": () => import("./session-start.ts"),
	stop: () => import("./stop.ts"),
	"pre-compact": () => import("./pre-compact.ts"),
	"post-compact": () => import("./post-compact.ts"),
	"permission-request": () => import("./permission-request.ts"),
	"subagent-start": () => import("./subagent-start.ts"),
	"subagent-stop": () => import("./subagent-stop.ts"),
	"post-tool-failure": () => import("./post-tool-failure.ts"),
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
		input = await Bun.stdin.text();
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
		resetBudget(ev.session_id);
	}

	const debug = !!process.env.QULT_DEBUG;
	setCurrentEvent(event);
	const cwd = ev.cwd || process.cwd();
	const git = getGitContext(cwd);
	setMetricsContext({
		sessionId: ev.session_id,
		projectId: basename(cwd),
		branch: git.branch,
		user: git.user,
	});
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
