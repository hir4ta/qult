import { readFileSync } from "node:fs";
import { getActivePlan } from "../state/plan-status.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

// Task header: ### Task N: name [status]
const TASK_HEADER_RE = /^###\s+Task\s+\d+:/m;
// Field patterns (with or without bold)
const FILE_FIELD_RE = /^\s*-\s+\*{0,2}File\*{0,2}:/m;
const VERIFY_FIELD_RE = /^\s*-\s+\*{0,2}Verify\*{0,2}:/m;
// Verify field must contain a specific file path or command, not just generic text
const VERIFY_SPECIFIC_RE =
	/^\s*-\s+\*{0,2}Verify\*{0,2}:\s*\S+.*\.(ts|js|py|go|rs|test|spec|json|toml|yaml|yml|sh)\b/m;
const REVIEW_GATE_RE = /review.*gate/i;

/** PermissionRequest: Validate plan structure on ExitPlanMode */
export default async function permissionRequest(ev: HookEvent): Promise<void> {
	if (ev.tool?.name !== "ExitPlanMode") return;

	const plan = getActivePlan();
	if (!plan) return; // fail-open

	const content = readFileSync(plan.path, "utf-8");
	const problems = validatePlanStructure(content);

	if (problems.length > 0) {
		deny(`Plan structure issues:\n${problems.join("\n")}`);
	}
}

function validatePlanStructure(content: string): string[] {
	const problems: string[] = [];

	// Check Review Gates
	if (!REVIEW_GATE_RE.test(content)) {
		problems.push("- Missing Review Gates section");
	}

	// Check each task has File and Verify fields
	const taskSections = splitTaskSections(content);
	for (const section of taskSections) {
		if (!FILE_FIELD_RE.test(section.body)) {
			problems.push(`- Task "${section.name}": missing File field`);
		}
		if (!VERIFY_FIELD_RE.test(section.body)) {
			problems.push(`- Task "${section.name}": missing Verify field`);
		} else if (!VERIFY_SPECIFIC_RE.test(section.body)) {
			problems.push(
				`- Task "${section.name}": Verify field must reference a specific file or command (e.g., "Verify: bun vitest run src/__tests__/foo.test.ts")`,
			);
		}
	}

	return problems;
}

interface TaskSection {
	name: string;
	body: string;
}

function splitTaskSections(content: string): TaskSection[] {
	const sections: TaskSection[] = [];
	const lines = content.split("\n");
	let current: TaskSection | null = null;

	for (const line of lines) {
		const match = line.match(TASK_HEADER_RE);
		if (match) {
			if (current) sections.push(current);
			// Extract task name from "### Task N: name [status]"
			const nameMatch = line.match(/^###\s+Task\s+\d+:\s*(.+?)(?:\s*\[.+\])?\s*$/);
			current = { name: nameMatch?.[1]?.trim() ?? "unknown", body: "" };
		} else if (current) {
			// Stop at next ## heading
			if (/^##\s/.test(line)) {
				sections.push(current);
				current = null;
			} else {
				current.body += `${line}\n`;
			}
		}
	}
	if (current) sections.push(current);

	return sections;
}
