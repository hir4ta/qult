import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SubagentStart: inject quality rules and state into subagent context */
export default async function subagentStart(_ev: HookEvent): Promise<void> {
	const lines: string[] = [];

	// Core quality rules
	lines.push(
		"Quality rules: Each task should change 1 file, under 15 lines. Verify with tests. Commit after each working increment.",
	);

	// Pending fixes warning
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const fileList = fixes.map((f) => f.file).join(", ");
		lines.push(
			`WARNING: There are pending lint/type fixes: ${fileList}. Do not edit other files until these are resolved.`,
		);
	}

	// Project-specific rules from alfred-quality.md
	const rulesContent = loadRulesFile();
	if (rulesContent) {
		lines.push(`Project rules:\n${rulesContent}`);
	}

	if (lines.length > 0) {
		respond(lines.join("\n\n"));
	}
}

function loadRulesFile(): string | null {
	try {
		// Check project-local first, then global
		const candidates = [
			join(process.cwd(), ".claude", "rules", "alfred-quality.md"),
			join(process.env.HOME ?? "", ".claude", "rules", "alfred-quality.md"),
		];
		for (const path of candidates) {
			if (existsSync(path)) {
				return readFileSync(path, "utf-8").trim();
			}
		}
		return null;
	} catch {
		return null;
	}
}
