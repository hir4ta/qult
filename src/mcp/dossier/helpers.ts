import { resolve } from "node:path";

/** Truncate at the last newline before maxLen to avoid mid-line cuts. */
export function truncateAtNewline(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	const lastNewline = s.lastIndexOf("\n", maxLen);
	return lastNewline > 0 ? s.slice(0, lastNewline) : s.slice(0, maxLen);
}

export interface DossierParams {
	action: string;
	project_path?: string;
	task_slug?: string;
	task_id?: string;
	description?: string;
	file?: string;
	content?: string;
	mode?: string;
	size?: string;
	spec_type?: string;
	version?: string;
	confirm?: boolean;
	// Gate action params
	sub_action?: string;
	gate_type?: string;
	wave?: number;
	reason?: string;
}

export function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function errorResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
		isError: true as const,
	};
}

export function resolveProjectPath(raw?: string): string {
	if (!raw) return process.cwd();
	const cleaned = resolve(raw);
	return cleaned;
}
