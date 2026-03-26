import type { HookEvent } from "../types.ts";

const EVENT_MAP: Record<string, () => Promise<{ default: (ev: HookEvent) => Promise<void> }>> = {
	"post-tool": () => import("./post-tool.ts"),
	"pre-tool": () => import("./pre-tool.ts"),
	"user-prompt": () => import("./user-prompt.ts"),
	"session-start": () => import("./session-start.ts"),
	stop: () => import("./stop.ts"),
	"pre-compact": () => import("./pre-compact.ts"),
	"permission-request": () => import("./permission-request.ts"),
};

export async function dispatch(event: string): Promise<void> {
	const loader = EVENT_MAP[event];
	if (!loader) {
		process.stderr.write(`Unknown hook event: ${event}\n`);
		process.exit(1);
	}

	const MAX_INPUT = 5_000_000; // 5MB
	let input = "";
	for await (const chunk of Bun.stdin.stream()) {
		input += new TextDecoder().decode(chunk);
		if (input.length > MAX_INPUT) return; // fail-open: input too large
	}

	let ev: HookEvent;
	try {
		ev = JSON.parse(input);
	} catch {
		// fail-open: invalid JSON → do nothing
		return;
	}

	try {
		const handler = await loader();
		await handler.default(ev);
	} catch {
		// fail-open: handler error → do nothing
	}
}
