/**
 * Task pace management — shared between PostToolUse and PreToolUse.
 * Extracted to avoid circular dependency (pre-tool → post-tool).
 */
import { readStateJSON, writeStateJSON } from "./state.js";

const PACE_FILE = "session-pace.json";

export interface SessionPace {
	started_at: string;
	last_commit_at: string;
	tool_calls_since_commit: number;
	files_changed_since_commit: string[];
	lines_changed_since_commit: number;
}

const EMPTY_PACE: SessionPace = {
	started_at: "",
	last_commit_at: "",
	tool_calls_since_commit: 0,
	files_changed_since_commit: [],
	lines_changed_since_commit: 0,
};

export function readPace(cwd: string): SessionPace | null {
	return readStateJSON<SessionPace | null>(cwd, PACE_FILE, null);
}

export function writePace(cwd: string, pace: SessionPace): void {
	writeStateJSON(cwd, PACE_FILE, pace);
}

export function updatePace(cwd: string, toolName: string, toolInput: Record<string, unknown>): void {
	try {
		const pace = readStateJSON<SessionPace>(cwd, PACE_FILE, { ...EMPTY_PACE });
		if (!pace.started_at) pace.started_at = new Date().toISOString();
		pace.tool_calls_since_commit++;

		if (toolName === "Edit" || toolName === "Write") {
			const fp = (toolInput.file_path as string) ?? "";
			if (fp && !pace.files_changed_since_commit.includes(fp)) {
				pace.files_changed_since_commit.push(fp);
			}
			// For Edit: count new_string lines (the actual change). For Write: count content lines.
			const newStr = (toolInput.new_string as string) ?? "";
			const oldStr = (toolInput.old_string as string) ?? "";
			if (newStr) {
				const delta = Math.abs(newStr.split("\n").length - oldStr.split("\n").length);
				pace.lines_changed_since_commit += Math.max(delta, newStr.split("\n").length);
			} else {
				const content = (toolInput.content as string) ?? "";
				pace.lines_changed_since_commit += content.split("\n").length;
			}
		}
		writeStateJSON(cwd, PACE_FILE, pace);
	} catch {
		/* fail-open */
	}
}

export function resetPaceOnCommit(cwd: string): void {
	try {
		const pace = readStateJSON<SessionPace>(cwd, PACE_FILE, { ...EMPTY_PACE });
		pace.last_commit_at = new Date().toISOString();
		pace.tool_calls_since_commit = 0;
		pace.files_changed_since_commit = [];
		pace.lines_changed_since_commit = 0;
		writeStateJSON(cwd, PACE_FILE, pace);
	} catch {
		/* fail-open */
	}
}

export function checkPaceRedThreshold(cwd: string): boolean {
	try {
		const pace = readPace(cwd);
		if (!pace?.started_at) return false;

		const ref = pace.last_commit_at || pace.started_at;
		const mins = (Date.now() - new Date(ref).getTime()) / 60000;
		const files = pace.files_changed_since_commit.length;
		const lines = pace.lines_changed_since_commit;

		// Red: 35min AND (10 files OR 500 lines) — compound condition
		return mins >= 35 && (files >= 10 || lines >= 500);
	} catch {
		return false;
	}
}
