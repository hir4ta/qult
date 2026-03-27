import { readFileSync } from "node:fs";
import { getActivePlan, TASK_RE } from "../state/plan-status.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

// Field patterns (with or without bold)
const FILE_FIELD_RE = /^\s*-\s+\*{0,2}File\*{0,2}:/m;
const VERIFY_FIELD_RE = /^\s*-\s+\*{0,2}Verify\*{0,2}:/m;
// Detect file paths in Change field for granularity check (require path separator or src/)
const FILE_PATH_RE = /(?:^|[\s/])[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java)\b/g;
// Verify field must contain a specific file path or command, not just generic text
const VERIFY_SPECIFIC_RE =
	/^\s*-\s+\*{0,2}Verify\*{0,2}:\s*\S+.*\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|c|cpp|h|test|spec|json|toml|yaml|yml|sh)\b/m;
const SUCCESS_CRITERIA_RE = /success\s*criteria/i;
// A concrete criterion references a command (backticks) or file path
const CONCRETE_CRITERION_RE = /`[^`]+`|\.(ts|js|py|go|rs|tsx|jsx|rb|java|sh)\b/;
// Generic/vague criteria that should be rejected
const VAGUE_CRITERIA_RE =
	/^\s*-\s+\[.\]\s*(tests?\s+pass|all\s+tests|code\s+works|it\s+works|everything\s+works|no\s+errors|lints?\s+clean|builds?\s+succeeds?)\s*$/i;

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
	const taskSections = splitTaskSections(content);
	const isSmallPlan = taskSections.length <= 3;

	// Large plans: check Success Criteria
	if (!isSmallPlan) {
		if (!SUCCESS_CRITERIA_RE.test(content)) {
			problems.push("- Missing Success Criteria section");
		} else {
			// Extract criteria lines (checkboxes after Success Criteria heading)
			const match = SUCCESS_CRITERIA_RE.exec(content);
			const criteriaSection = match ? content.slice(match.index + match[0].length) : "";
			const criteriaEnd = criteriaSection.search(/^##\s/m);
			const criteriaBlock =
				criteriaEnd >= 0 ? criteriaSection.slice(0, criteriaEnd) : criteriaSection;
			const criteriaLines = criteriaBlock.split("\n").filter((l) => /^\s*-\s+\[/.test(l));
			if (criteriaLines.length === 0 || !criteriaLines.some((l) => CONCRETE_CRITERION_RE.test(l))) {
				problems.push(
					"- Success Criteria must include concrete, testable conditions (commands in backticks or specific file references)",
				);
			}
			// Reject vague criteria: "tests pass", "code works", etc.
			const vagueLines = criteriaLines.filter((l) => VAGUE_CRITERIA_RE.test(l));
			if (vagueLines.length > 0) {
				problems.push(
					"- Success Criteria too vague. Replace generic items like 'tests pass' with behavioral descriptions (e.g., '`bun vitest run src/__tests__/auth.test.ts` — login returns JWT token')",
				);
			}
		}

		// Review Gates: no longer required — review is enforced mechanically by stop.ts and pre-tool.ts
	}

	// Large plans: advisory warning for very large plans (not a hard block)
	if (taskSections.length > 8) {
		process.stderr.write(
			"[qult] Warning: Plan has 8+ tasks. Consider splitting into multiple sessions (1 feature per session).\n",
		);
	}

	// Check each task has required fields
	for (const section of taskSections) {
		if (!isSmallPlan) {
			// Large plans: require File field
			if (!FILE_FIELD_RE.test(section.body)) {
				problems.push(
					`- Task "${section.name}": missing File field (specify which file to change)`,
				);
			}
			// Large plans: check task granularity — warn if Change references 3+ distinct files
			const changeMatch = section.body.match(/^\s*-\s+\*{0,2}Change\*{0,2}:\s*(.+)/m);
			if (changeMatch) {
				const files = changeMatch[1]!.match(FILE_PATH_RE);
				if (files && new Set(files).size > 2) {
					problems.push(
						`- Task "${section.name}": touches ${new Set(files).size} files — split into smaller tasks (1-2 files each)`,
					);
				}
			}
			// Large plans: require Verify field with specificity
			if (!VERIFY_FIELD_RE.test(section.body)) {
				problems.push(`- Task "${section.name}": missing Verify field`);
			} else if (!VERIFY_SPECIFIC_RE.test(section.body)) {
				problems.push(
					`- Task "${section.name}": Verify field must reference a specific file or command (e.g., "Verify: src/__tests__/foo.test.ts:testFunction")`,
				);
			}
		} else if (VERIFY_FIELD_RE.test(section.body) && !VERIFY_SPECIFIC_RE.test(section.body)) {
			// Small plans: Verify field optional, but if present must be specific
			problems.push(
				`- Task "${section.name}": Verify field must reference a specific file or command`,
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
		const match = line.match(TASK_RE);
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
