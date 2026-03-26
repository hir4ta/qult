/**
 * Self-reflection templates — task-type-specific, graduated depth.
 *
 * Research: Reflexion paper shows test execution feedback + reflection = 91% (vs 80% baseline).
 * Static checklists without verification produce "hollow reflection."
 */
import type { DirectiveItem } from "./directives.js";

export type TaskType = "bug_fix" | "new_feature" | "refactor" | "unknown";
export type ReflectionDepth = "light" | "standard" | "deep";

export interface ReflectionTemplate {
	prompts: string[];
	proveIt?: string;
	falsification?: string;
}

// ===== Task type classification =====

const BUG_FIX_SIGNALS =
	/\bfix(?:e[sd])?\b|\bbug\b|\bhotfix\b|\bpatch\b|\bresolve[sd]?\b|\bcorrect\b/i;
const REFACTOR_SIGNALS =
	/\brefactor\b|\brestructure\b|\brename\b|\bextract\b|\bsimplify\b|\bclean\s?up\b|\bmove\b|\breorganize\b/i;

export function classifyTaskType(changedFiles: string[]): TaskType {
	const combined = changedFiles.join(" ");
	if (BUG_FIX_SIGNALS.test(combined)) return "bug_fix";
	if (REFACTOR_SIGNALS.test(combined)) return "refactor";
	if (changedFiles.some((f) => !f.includes("test") && !f.includes("spec"))) return "new_feature";
	return "unknown";
}

// ===== Depth graduation =====

export function determineDepth(
	linesChanged: number,
	filesModified: number,
	hasNewFiles: boolean,
): ReflectionDepth {
	if (filesModified <= 1 && linesChanged <= 10 && !hasNewFiles) return "light";
	if (filesModified >= 5 || hasNewFiles) return "deep";
	return "standard";
}

// ===== Templates =====

const TEMPLATES: Record<TaskType, Record<ReflectionDepth, ReflectionTemplate>> = {
	bug_fix: {
		light: {
			prompts: ["Run the failing test. Does it pass now?"],
		},
		standard: {
			prompts: [
				"What is the ROOT CAUSE? (not just the symptom you patched)",
				"Search the codebase for the same pattern — are there other instances of this bug?",
				"Run the failing test to prove the fix works. Paste the output.",
				"Add a regression test for the exact scenario that triggered the bug.",
			],
			proveIt: "For each claim above, cite a specific file:line or test result.",
		},
		deep: {
			prompts: [
				"What is the ROOT CAUSE? Explain in one sentence.",
				"Search for the same pattern — are there other instances?",
				"Run the failing test AND adjacent tests. Paste output.",
				"Add regression test for the exact trigger scenario.",
				"What are the boundary conditions near this fix? Test one above and below.",
			],
			proveIt: "For each claim, cite specific file:line or test result.",
			falsification:
				"Now argue your fix is WRONG. What input would break it? " +
				"Name the function, the input, and expected vs actual output.",
		},
	},
	new_feature: {
		light: {
			prompts: ["Quick check: could this produce wrong output without crashing?"],
		},
		standard: {
			prompts: [
				"Test with 0 items, 1 item, and many items.",
				"Could this produce wrong output without crashing? How would you know?",
				"Is there a simpler approach you haven't considered?",
				"Run the test suite. Paste the output summary.",
			],
			proveIt: "For each edge case, write a test input + expected output.",
		},
		deep: {
			prompts: [
				"Trace the call chain from entry point to your new code. Any missing error handlers?",
				"Test with 0, 1, and many items.",
				"Could this fail silently? What's the observable output?",
				"Does your naming follow patterns in adjacent files? Grep to verify.",
				"Run the full test suite. Paste results.",
			],
			proveIt: "For each edge case, write a concrete test input + expected output and run it.",
			falsification:
				"Argue your implementation is WRONG. Find the strongest counter-argument. " +
				"Name the function, input, and expected vs actual.",
		},
	},
	refactor: {
		light: {
			prompts: ["Run the test suite. Any failures = refactor broke something."],
		},
		standard: {
			prompts: [
				"Is the behavior IDENTICAL? Run the full test suite to prove it.",
				"Did you change any public API signatures? Grep for all callers.",
				"Did your refactor leave any dead code? Check for unused imports.",
			],
			proveIt: "Paste test suite output showing all tests pass.",
		},
		deep: {
			prompts: [
				"Run the full test suite. Any failures = refactor broke behavior.",
				"Did you change any exported function signatures? Grep for all callers and verify.",
				"Pick 3 specific inputs. Trace through old and new code. Same outputs?",
				"Search for dead code: unused imports, unexported functions in touched files.",
			],
			proveIt: "Paste test output. For any changed signatures, show all updated callers.",
			falsification:
				"What's the most likely way this refactor silently changed behavior? " +
				"Name the function and a specific input that could differ.",
		},
	},
	unknown: {
		light: {
			prompts: ["Any edge cases or silent failures possible?"],
		},
		standard: {
			prompts: [
				"List 3 edge cases. Are they handled or tested?",
				"Could this produce wrong output without crashing?",
				"Is there a simpler approach?",
				"Does this follow the project's established patterns?",
			],
		},
		deep: {
			prompts: [
				"List 3 edge cases. Write a test for each.",
				"Could this produce wrong output without crashing? How would you know?",
				"Is there a simpler approach?",
				"Does this follow project patterns? Grep to verify.",
			],
			falsification: "Argue this implementation is WRONG. Find the strongest counter-argument.",
		},
	},
};

export function getReflectionTemplate(
	taskType: TaskType,
	depth: ReflectionDepth,
): ReflectionTemplate {
	return TEMPLATES[taskType][depth];
}

// ===== Build directive =====

export function buildReflectionDirective(
	taskType: TaskType,
	depth: ReflectionDepth,
	knowledgeHints?: string[],
): DirectiveItem {
	const template = TEMPLATES[taskType][depth];
	const parts: string[] = [];

	parts.push("Before moving on, verify:");
	for (let i = 0; i < template.prompts.length; i++) {
		parts.push(`${i + 1}. ${template.prompts[i]}`);
	}

	if (template.proveIt) {
		parts.push(`\n${template.proveIt}`);
	}

	if (template.falsification) {
		parts.push(`\n${template.falsification}`);
	}

	if (knowledgeHints && knowledgeHints.length > 0) {
		parts.push(`\nHistory: ${knowledgeHints.join("; ")}`);
	}

	return {
		level: depth === "deep" ? "DIRECTIVE" : depth === "standard" ? "DIRECTIVE" : "CONTEXT",
		message: parts.join("\n"),
	};
}
