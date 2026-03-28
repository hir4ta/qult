import { readFileSync } from "node:fs";
import { getCalibrated } from "../state/calibration.ts";
import { recordAction, recordPlanCompliance } from "../state/metrics.ts";
import { getActivePlan, TASK_RE } from "../state/plan-status.ts";
import { readLastPlanEvaluation } from "../state/session-state.ts";
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

// Template field patterns for compliance scoring
const CONTEXT_SECTION_RE = /^##\s*Context/im;
const CHANGE_FIELD_RE = /^\s*-\s+\*{0,2}Change\*{0,2}:/m;
const BOUNDARY_FIELD_RE = /^\s*-\s+\*{0,2}Boundary\*{0,2}:/m;

export interface ComplianceScore {
	hasContext: number; // 0 or 10
	hasTasks: number; // 0 or 10
	fileRate: number; // 0-10 proportional
	changeRate: number; // 0-10 proportional
	boundaryRate: number; // 0-10 proportional
	verifyRate: number; // 0-10 proportional
	hasCriteria: number; // 0 or 15
	criteriaConcreteRate: number; // 0-25 proportional
	total: number; // 0-100
}

/** Score plan template compliance (0-100). */
export function scorePlanCompliance(content: string): ComplianceScore {
	const hasContext = CONTEXT_SECTION_RE.test(content) ? 10 : 0;
	const taskSections = splitTaskSections(content);
	const hasTasks = taskSections.length > 0 ? 10 : 0;

	let fileCount = 0;
	let changeCount = 0;
	let boundaryCount = 0;
	let verifyCount = 0;
	for (const s of taskSections) {
		if (FILE_FIELD_RE.test(s.body)) fileCount++;
		if (CHANGE_FIELD_RE.test(s.body)) changeCount++;
		if (BOUNDARY_FIELD_RE.test(s.body)) boundaryCount++;
		if (VERIFY_FIELD_RE.test(s.body)) verifyCount++;
	}
	const n = taskSections.length || 1;
	const fileRate = Math.round((fileCount / n) * 10);
	const changeRate = Math.round((changeCount / n) * 10);
	const boundaryRate = Math.round((boundaryCount / n) * 10);
	const verifyRate = Math.round((verifyCount / n) * 10);

	let hasCriteria = 0;
	let criteriaConcreteRate = 0;
	if (SUCCESS_CRITERIA_RE.test(content)) {
		hasCriteria = 15;
		const match = SUCCESS_CRITERIA_RE.exec(content);
		const criteriaSection = match ? content.slice(match.index + match[0].length) : "";
		const criteriaEnd = criteriaSection.search(/^##\s/m);
		const criteriaBlock =
			criteriaEnd >= 0 ? criteriaSection.slice(0, criteriaEnd) : criteriaSection;
		const criteriaLines = criteriaBlock.split("\n").filter((l) => /^\s*-\s+\[/.test(l));
		if (criteriaLines.length > 0) {
			const concreteCount = criteriaLines.filter((l) => isConcreteCriterion(l)).length;
			criteriaConcreteRate = Math.round((concreteCount / criteriaLines.length) * 25);
		}
	}

	const total =
		hasContext +
		hasTasks +
		fileRate +
		changeRate +
		boundaryRate +
		verifyRate +
		hasCriteria +
		criteriaConcreteRate;
	return {
		hasContext,
		hasTasks,
		fileRate,
		changeRate,
		boundaryRate,
		verifyRate,
		hasCriteria,
		criteriaConcreteRate,
		total,
	};
}

/** Check if a criterion line is concrete (whitelist approach). */
export function isConcreteCriterion(line: string): boolean {
	if (CONCRETE_CRITERION_RE.test(line)) return true; // backtick command or file extension
	if (/\b\w+\(\)/.test(line)) return true; // function reference
	if (/https?:\/\//.test(line)) return true; // URL endpoint
	if (
		/\b\d+\b/.test(line) &&
		/\b[\w/]+\.(ts|js|py|go|rs|tsx|jsx|rb|java|sh|json|yaml|yml|toml)\b/.test(line)
	)
		return true; // number + file extension
	return false;
}

/** Check if plan is small (≤ calibrated task threshold). */
function isSmallPlan(content: string): boolean {
	const taskSections = splitTaskSections(content);
	const planTaskThreshold = getCalibrated("plan_task_threshold", 3);
	return taskSections.length <= planTaskThreshold;
}

/** PermissionRequest: Validate plan structure on ExitPlanMode */
export default async function permissionRequest(ev: HookEvent): Promise<void> {
	if (ev.tool?.name !== "ExitPlanMode") return;

	const plan = getActivePlan();
	if (!plan) return; // fail-open

	const content = readFileSync(plan.path, "utf-8");

	// Score template compliance before validation (recorded regardless of pass/fail)
	try {
		const compliance = scorePlanCompliance(content);
		recordPlanCompliance(compliance.total, {
			context: compliance.hasContext,
			tasks: compliance.hasTasks,
			file: compliance.fileRate,
			change: compliance.changeRate,
			boundary: compliance.boundaryRate,
			verify: compliance.verifyRate,
			criteria: compliance.hasCriteria,
			criteria_concrete: compliance.criteriaConcreteRate,
		});
	} catch {
		/* fail-open */
	}

	const problems = validatePlanStructure(content);

	if (problems.length > 0) {
		deny(`Plan structure issues:\n${problems.join("\n")}`);
	}

	// Large plans: require independent plan evaluation
	if (!isSmallPlan(content)) {
		if (!readLastPlanEvaluation()) {
			deny(
				"Large plan requires content evaluation. Run /qult:plan-review before exiting plan mode.",
			);
		}
	} else {
		process.stderr.write(
			"[qult] Tip: Run /qult:plan-review for an independent plan quality check.\n",
		);
	}

	// Plan validation passed — record success (deny case is recorded by respond.ts)
	try {
		recordAction("permission-request", "respond", "plan approved");
	} catch {
		/* fail-open */
	}
}

function validatePlanStructure(content: string): string[] {
	const problems: string[] = [];
	const taskSections = splitTaskSections(content);
	const small = isSmallPlan(content);

	// Large plans: check Success Criteria
	if (!small) {
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
			// Whitelist check: if ALL criteria lack concrete elements, DENY
			const nonVague = criteriaLines.filter((l) => !VAGUE_CRITERIA_RE.test(l));
			if (nonVague.length > 0 && !nonVague.some((l) => isConcreteCriterion(l))) {
				problems.push(
					"- Success Criteria lack concrete elements. Include backtick commands, specific file paths, function references, or measurable numbers",
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
		if (!small) {
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
