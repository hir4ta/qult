import { loadConfig } from "../../config.ts";

// --- Level 1: Structural validation ---

const TASK_HEADER_G = /^### Task \d+[\s:-]/gim;
const TASK_BLOCK_RE = /^### Task (\d+)[\s:-]+.*$/gim;
const FIELD_RES: Record<string, RegExp> = {
	File: /^\s*-\s*\*\*File\*\*/m,
	Change: /^\s*-\s*\*\*Change\*\*/m,
	Boundary: /^\s*-\s*\*\*Boundary\*\*/m,
	Verify: /^\s*-\s*\*\*Verify\*\*/m,
};

/** Extract the content between ## Tasks and the next ## section (or end of file). */
function extractTasksContent(content: string): string | null {
	const tasksIdx = content.search(/^## Tasks/m);
	if (tasksIdx < 0) return null;

	const tasksSection = content.slice(tasksIdx);
	const firstNewline = tasksSection.indexOf("\n");
	if (firstNewline < 0) return tasksSection;

	const afterHeader = tasksSection.slice(firstNewline);
	const nextSectionIdx = afterHeader.search(/^## /m);
	if (nextSectionIdx < 0) return tasksSection;

	return tasksSection.slice(0, firstNewline + nextSectionIdx);
}

/** Level 1: Validate plan structure. Returns error messages (empty = pass). */
export function validatePlanStructure(content: string): string[] {
	const errors: string[] = [];

	if (!/^## Context/m.test(content)) {
		errors.push("Missing required section: ## Context");
	}

	if (!/^## Tasks/m.test(content)) {
		errors.push("Missing required section: ## Tasks");
		return errors; // can't check tasks without section
	}

	const taskCount = (content.match(TASK_HEADER_G) ?? []).length;
	if (taskCount === 0) {
		errors.push("## Tasks section has no task entries (### Task N:)");
	} else if (taskCount > 15) {
		errors.push(`Too many tasks (${taskCount}). Maximum is 15. Split into smaller plans.`);
	}

	// Extract individual task blocks and check fields
	const tasksContent = extractTasksContent(content);
	if (!tasksContent) return errors;

	const taskHeaders = [...tasksContent.matchAll(TASK_BLOCK_RE)];
	for (let i = 0; i < taskHeaders.length; i++) {
		const start = taskHeaders[i]!.index!;
		const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1]!.index! : tasksContent.length;
		const block = tasksContent.slice(start, end);
		const taskNum = taskHeaders[i]![1];

		for (const [field, re] of Object.entries(FIELD_RES)) {
			if (!re.test(block)) {
				errors.push(`Task ${taskNum}: missing required field **${field}**`);
			}
		}
	}

	if (!/^## Success Criteria/m.test(content)) {
		errors.push("Missing required section: ## Success Criteria");
	} else {
		const scStart = content.search(/^## Success Criteria/m);
		const scContent = content.slice(scStart);
		if (!/`.+`/.test(scContent)) {
			errors.push("Success Criteria must contain at least one backtick-wrapped command");
		}
	}

	return errors;
}

// --- Level 2: Heuristic validation ---

const VAGUE_VERBS_RE =
	/^(improve|update|fix|refactor|clean\s*up|enhance|optimize|modify|adjust|change)\b/i;
/** Accept: file.ext:function, TestXxx (Go), test_xxx (Python), or path-like strings */
const VERIFY_FORMAT_RE = /\S+\.\w+\s*:\s*\S+|\bTest[A-Z]\w+\b|\btest_\w+\b|[\w/]+\.\w+/;

export const PLAN_EVAL_DIMENSIONS = ["Feasibility", "Completeness", "Clarity"];

/** Level 2: Heuristic plan quality checks. Returns warning messages (empty = pass). */
export function validatePlanHeuristics(content: string): string[] {
	const warnings: string[] = [];

	const tasksContent = extractTasksContent(content);
	if (!tasksContent) return warnings;

	const taskHeaders = [...tasksContent.matchAll(TASK_BLOCK_RE)];
	const taskBlocks: { num: string; block: string }[] = [];

	for (let i = 0; i < taskHeaders.length; i++) {
		const start = taskHeaders[i]!.index!;
		const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1]!.index! : tasksContent.length;
		taskBlocks.push({ num: taskHeaders[i]![1]!, block: tasksContent.slice(start, end) });
	}

	// Collect all File fields across all tasks for consumer check
	const registryFiles = loadConfig().plan_eval.registry_files;
	const allFiles: string[] = [];
	for (const { block } of taskBlocks) {
		const fileMatch = block.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
		if (fileMatch) allFiles.push(fileMatch[1]!);
	}
	const allFilesJoined = allFiles.join(" ");

	for (const { num, block } of taskBlocks) {
		// Check vague Change
		const changeMatch = block.match(/^\s*-\s*\*\*Change\*\*:\s*(.+)$/m);
		if (changeMatch) {
			const changeValue = changeMatch[1]!.trim();
			if (VAGUE_VERBS_RE.test(changeValue)) {
				// Count words after the vague verb
				const words = changeValue.split(/\s+/);
				if (words.length < 8) {
					warnings.push(
						`Task ${num}: Change field is too vague ("${changeValue}"). Be specific about what to do.`,
					);
				}
			}
		}

		// Check Verify format (expected: file.ext:functionName)
		const verifyMatch = block.match(/^\s*-\s*\*\*Verify\*\*:\s*(.+)$/m);
		if (verifyMatch) {
			const verifyValue = verifyMatch[1]!.trim();
			if (!VERIFY_FORMAT_RE.test(verifyValue)) {
				warnings.push(
					`Task ${num}: Verify field should reference a test file:function (got "${verifyValue}")`,
				);
			}
		}

		// Check registry file consumer coverage (skip if no registry files configured)
		const fileMatch = block.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
		if (fileMatch && registryFiles.length > 0) {
			const fileValue = fileMatch[1]!;
			for (const registry of registryFiles) {
				if (fileValue.includes(registry)) {
					// Check if any OTHER task references a consumer file (not the same registry)
					const hasConsumer = allFilesJoined
						.split(/[\s,]+/)
						.some(
							(f) =>
								!f.includes(registry) &&
								(f.includes("test") ||
									f.includes("spec") ||
									f.includes("doctor") ||
									f.includes("hook") ||
									f.includes("cli")),
						);
					if (!hasConsumer) {
						warnings.push(
							`Task ${num}: File references registry file "${registry}" but no consumer file (test, hook, etc.) found in plan`,
						);
					}
				}
			}
		}
	}

	return warnings;
}
