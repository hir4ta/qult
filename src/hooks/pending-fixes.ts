/**
 * Pending fixes management — tracks unresolved lint/type errors.
 *
 * PostToolUse writes errors after gate failures.
 * PreToolUse reads to decide whether to DENY Edit/Write.
 */
import { readStateJSON, writeStateJSON } from "./state.js";

export interface PendingFixEntry {
	line?: number;
	rule?: string;
	message: string;
}

export interface PendingFixes {
	files: Record<string, { lint?: PendingFixEntry[]; type?: PendingFixEntry[] }>;
	updated_at: string;
}

const FILE_NAME = "pending-fixes.json";
const EMPTY: PendingFixes = { files: {}, updated_at: "" };

export function readPendingFixes(cwd: string): PendingFixes {
	return readStateJSON<PendingFixes>(cwd, FILE_NAME, EMPTY);
}

export function writePendingFixes(cwd: string, fixes: PendingFixes): void {
	writeStateJSON(cwd, FILE_NAME, fixes);
}

export function clearPendingFixes(cwd: string): void {
	writeStateJSON(cwd, FILE_NAME, EMPTY);
}

export function hasPendingFixes(cwd: string): boolean {
	const fixes = readPendingFixes(cwd);
	return Object.keys(fixes.files).length > 0;
}

/**
 * Format pending fixes as a human-readable string for DIRECTIVE/DENY messages.
 */
export function formatPendingFixes(fixes: PendingFixes): string {
	const lines: string[] = [];
	for (const [file, checks] of Object.entries(fixes.files)) {
		for (const entry of checks.lint ?? []) {
			const loc = entry.line ? `:${entry.line}` : "";
			const rule = entry.rule ? ` (${entry.rule})` : "";
			lines.push(`- ${file}${loc}${rule}: ${entry.message}`);
		}
		for (const entry of checks.type ?? []) {
			const loc = entry.line ? `:${entry.line}` : "";
			lines.push(`- ${file}${loc}: ${entry.message}`);
		}
	}
	return lines.join("\n");
}

/**
 * Parse gate output into PendingFixEntry list.
 * Handles common lint/type output formats.
 */
export function parseGateOutput(output: string, gateName: string): PendingFixEntry[] {
	if (!output.trim()) return [];
	const entries: PendingFixEntry[] = [];

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Common format: file:line:col: message (rule)
		const match = trimmed.match(/^[^:]+:(\d+)(?::\d+)?[:\s]+(.+?)(?:\s+\(([^)]+)\))?\s*$/);
		if (match) {
			entries.push({
				line: Number.parseInt(match[1]!, 10),
				message: match[2]!.trim(),
				rule: match[3] ?? gateName,
			});
			continue;
		}

		// tsc format: file(line,col): error TSxxxx: message
		const tscMatch = trimmed.match(/^[^(]+\((\d+),\d+\):\s*error\s+\S+:\s*(.+)$/);
		if (tscMatch) {
			entries.push({
				line: Number.parseInt(tscMatch[1]!, 10),
				message: tscMatch[2]!.trim(),
				rule: "typecheck",
			});
			continue;
		}

		// Fallback: just the line text (limit length)
		if (trimmed.length > 10 && !trimmed.startsWith("✖") && !trimmed.startsWith("Found")) {
			entries.push({ message: trimmed.slice(0, 200) });
		}
	}

	return entries.slice(0, 20); // cap at 20 entries
}
