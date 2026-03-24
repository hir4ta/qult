import { extractReviewFindings, saveKnowledgeEntries } from "../mcp/knowledge-extractor.js";
import { truncate } from "../mcp/helpers.js";
import { updateTaskStatus } from "../spec/status.js";
import { effectiveStatus, readActive, readActiveState, SpecDir } from "../spec/types.js";
import { searchKnowledgeFTS } from "../store/fts.js";
import { openDefaultCached } from "../store/index.js";
import { getPromotionCandidates, promoteSubType } from "../store/knowledge.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { notifyUser } from "./dispatcher.js";

import { isSpecFilePath } from "./spec-guard.js";
import { addWorkedSlug, readStateJSON, readWaveProgress, writeStateJSON, writeWaveProgress } from "./state.js";
import { writeReviewGate } from "./review-gate.js";

export async function postToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd || !ev.tool_name) return;

	const items: DirectiveItem[] = [];

	// Read/Grep/Glob: no post-processing needed.
	if (ev.tool_name === "Read" || ev.tool_name === "Grep" || ev.tool_name === "Glob") {
		return;
	}

	if (ev.tool_name === "Bash" && !signal.aborted) {
		await handleBashResult(ev, items, signal);

	}

	// Track worked slug + auto-check tasks + auto-transition for Edit/Write.
	if ((ev.tool_name === "Edit" || ev.tool_name === "Write") && ev.tool_input) {
		const input = ev.tool_input as Record<string, unknown>;
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		// Auto-check tasks when file matches task description.
		if (filePath) {
			autoCheckTasks(ev.cwd!, filePath, items);
		}
		// Track worked slug for session-scoped Stop hook reminders.
		try {
			const slug = readActive(ev.cwd!);
			addWorkedSlug(ev.cwd!, slug);

			// FR-13: Auto-transition pending → in-progress on first source edit (.alfred/ excluded).
			if (filePath && !isSpecFilePath(ev.cwd!, filePath)) {
				const state = readActiveState(ev.cwd!);
				const task = state.tasks.find((t) => t.slug === slug);
				if (task && effectiveStatus(task.status) === "pending") {
					try {
						updateTaskStatus(ev.cwd!, slug, "in-progress", "auto:first-edit");
					} catch { /* transition error — ignore */ }
				}
			}

			// Nudge: remind to check tasks — only after git commit (wave boundary),
			// NOT after every Edit/Write (causes Claude to stall on large specs, #27).

		} catch { /* no active spec */ }
	}

	// Check spec completion on any tool that might update spec files (Edit, Write, Bash).
	if (["Edit", "Write", "Bash"].includes(ev.tool_name)) {
		checkSpecCompletion(ev.cwd!, items);
	}

	// FR-3: Extract knowledge from review agent findings.
	if (ev.tool_name === "Agent" && ev.tool_response) {
		extractReviewKnowledge(ev.cwd!, ev.tool_response);
	}

	emitDirectives("PostToolUse", items);
}

async function handleBashResult(
	ev: HookEvent,
	items: DirectiveItem[],
	signal: AbortSignal,
): Promise<void> {
	const response = ev.tool_response as
		| { stdout?: string; stderr?: string; exitCode?: number }
		| undefined;
	if (!response) return;

	// On Bash error: search FTS for similar errors + detect test failures.
	if (response.exitCode && response.exitCode !== 0) {
		const errorText = typeof response.stderr === "string" ? response.stderr : "";
		const stdout = response.stdout ?? "";
		if (errorText.length > 10) {
			await searchErrorContext(ev.cwd!, errorText, items);
		}

		// FR-4: Test failure rollback suggestion.
		if (isTestFailure(`${stdout}\n${errorText}`)) {
			items.push({
				level: "WARNING",
				message:
					"Test failure detected. Investigate the root cause before continuing implementation. Consider reverting recent changes with `git stash` or `git diff` to isolate the issue.",
			});
		}
	}

	// On Bash success: auto-check tasks + check for git commit.
	if (response.exitCode === 0) {
		const stdout = response.stdout ?? "";
		// Auto-check tasks from Bash output (command + stdout).
		const commandStr =
			typeof ev.tool_input === "object" && ev.tool_input !== null
				? ((ev.tool_input as { command?: string }).command ?? "")
				: "";
		autoCheckTasks(ev.cwd!, `${stdout}\n${commandStr}`, items);

		if (isGitCommit(stdout) && !signal.aborted) {
			// FR-2 (feedback-metrics): Track first commit for cycle time breakdown.
			trackFirstCommit(ev.cwd!, stdout);

			// Living Spec auto-append: track new source files in design.md.
			let appendedFiles = new Set<string>();
			try {
				const { handleLivingSpec } = await import("./living-spec.js");
				appendedFiles = handleLivingSpec(ev.cwd!);
			} catch {
				/* fail-open */
			}

			// Drift detection: warn about source files not referenced in spec.
			try {
				const { detectDrift } = await import("./drift.js");
				detectDrift(ev.cwd!, appendedFiles, items);
			} catch {
				/* fail-open */
			}

			// Wave completion detection: check tasks.json after commit.
			try {
				const slug = readActive(ev.cwd!);
				const waveItems = detectWaveCompletion(ev.cwd!, slug);
				items.push(...waveItems);
			} catch {
				/* no active spec or tasks.json */
			}

			// Auto-save decisions + session snapshot on git commit (not just PreCompact).
			// This ensures knowledge accumulates even with 1M context (no compact).
			saveKnowledgeOnCommit(ev.cwd!);
		}
	}
}

async function searchErrorContext(
	_projectPath: string,
	errorText: string,
	items: DirectiveItem[],
): Promise<void> {
	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	const query = errorText.slice(0, 200);
	try {
		const docs = searchKnowledgeFTS(store, query, 3);
		if (docs.length > 0) {
			const context = docs.map((d) => `- ${d.title}: ${truncate(d.content, 150)}`).join("\n");
			items.push({
				level: "CONTEXT",
				message: `Related knowledge for this error:\n${context}`,
			});
		}
	} catch {
		/* search failure is non-fatal */
	}
}


/**
 * Auto-check tasks.json tasks when implementation matches task descriptions.
 * Uses file path matching against task.files and task.title.
 */
function autoCheckTasks(projectPath: string, context: string, items: DirectiveItem[]): void {
	try {
		const taskSlug = readActive(projectPath);
		const sd = new SpecDir(projectPath, taskSlug);

		let tasksData: { waves: Array<{ tasks: Array<{ id: string; title: string; checked: boolean; files?: string[] }> }>; closing: { tasks: Array<{ id: string; title: string; checked: boolean; files?: string[] }> } };
		try {
			tasksData = JSON.parse(sd.readFile("tasks.json"));
		} catch {
			return; // no tasks.json
		}

		let changed = false;
		const allWaves = [...tasksData.waves, tasksData.closing];

		for (const wave of allWaves) {
			for (const task of wave.tasks) {
				if (task.checked) continue;
				if (matchTaskDescription(task.title, context) || matchTaskFiles(task.files, context)) {
					task.checked = true;
					changed = true;
				}
			}
		}

		if (changed) {
			sd.writeFile("tasks.json", JSON.stringify(tasksData, null, 2) + "\n");
			// Detect wave completion after auto-check.
			const waveItems = detectWaveCompletion(projectPath, taskSlug);
			items.push(...waveItems);
		}
		// #27 fix: Do NOT emit unchecked count CONTEXT here.
		// Unchecked task nudges caused Claude to stall on large specs (14+ min bake).
	} catch {
		/* fail-open */
	}
}

/**
 * Match a task description against context (stdout/file path).
 * Strategies:
 * 1. Backtick-quoted paths in description matched against context
 * 2. Filename matching (extension-bearing words matched against context)
 */
export function matchTaskDescription(description: string, context: string): boolean {
	if (!context || !description) return false;
	const lowerCtx = context.toLowerCase();

	const backtickPaths = description.match(/`([^`]+\.[a-z]+)`/g);
	if (backtickPaths) {
		for (const quoted of backtickPaths) {
			const path = quoted.slice(1, -1);
			if (lowerCtx.includes(path.toLowerCase())) return true;
		}
	}

	const filenamePattern = /\b([\w.-]+\.[a-z]{1,4})\b/gi;
	const filenames = [...description.matchAll(filenamePattern)]
		.map(m => m[1]!.toLowerCase())
		.filter(f => f.length > 4 && !f.startsWith("."));
	for (const fname of filenames) {
		if (lowerCtx.includes(fname)) return true;
	}

	return false;
}

function matchTaskFiles(files: string[] | undefined, context: string): boolean {
	if (!files || !context) return false;
	const lowerCtx = context.toLowerCase();
	return files.some(f => lowerCtx.includes(f.toLowerCase()));
}

/**
 * Detect wave completion after tasks.json update.
 * JSON-based: reads tasks.json directly.
 */
export function detectWaveCompletion(
	projectPath: string,
	taskSlug: string,
): DirectiveItem[] {
	const items: DirectiveItem[] = [];
	try {
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksData = JSON.parse(sd.readFile("tasks.json"));
		const allWaves = [...(tasksData.waves ?? []), tasksData.closing].filter(Boolean);
		const prev = readWaveProgress(projectPath);

		const progress: { slug: string; current_wave: number; waves: Record<string, { total: number; checked: number; reviewed: boolean }> } = {
			slug: taskSlug, current_wave: 1, waves: {},
		};

		for (const wave of allWaves) {
			const key = String(wave.key);
			const total = wave.tasks.length;
			const checked = wave.tasks.filter((t: { checked: boolean }) => t.checked).length;
			const prevReviewed = prev?.waves[key]?.reviewed ?? false;
			progress.waves[key] = { total, checked, reviewed: prevReviewed };

			if (total === 0 || checked < total) continue;
			if (prevReviewed) continue;

			items.push({
				level: "DIRECTIVE",
				message: `Wave ${key} complete (${checked}/${total} tasks). You MUST now: 1) Commit your changes, 2) Run self-review (delegate to alfred:code-reviewer or /alfred:inspect), 3) Save any learnings via \`ledger save\`. Then clear the gate with \`dossier action=gate sub_action=clear reason="..."\`.`,
			});

			try {
				updateTaskStatus(projectPath, taskSlug, "review", "auto:wave-complete");
			} catch { /* transition error */ }

			writeReviewGate(projectPath, {
				gate: "wave-review",
				slug: taskSlug,
				wave: parseInt(key, 10) || 0,
				reason: `Wave ${key} self-review required`,
			});
			break;
		}

		writeWaveProgress(projectPath, progress);
	} catch {
		/* fail-open */
	}
	return items;
}


/**
 * FR-4: Detect test failure patterns in command output.
 */
export function isTestFailure(output: string): boolean {
	if (!output) return false;
	const patterns = [
		/FAIL(ED|URE)?\b/i, // vitest, jest, generic
		/\d+ failed/i, // generic "N failed"
		/Tests:\s+\d+ failed/, // jest summary
		/✗|✘/, // unicode failure marks
		/AssertionError/i, // assertion errors
		/test.*failed/i, // generic
		/npm ERR!.*test/i, // npm test failure
	];
	return patterns.some((p) => p.test(output));
}

/**
 * Detect git commit from Bash stdout.
 * Checks for common git commit output patterns.
 */
export function isGitCommit(stdout: string): boolean {
	if (!stdout) return false;
	// Common patterns in git commit output.
	return (
		/\[[\w./-]+ [0-9a-f]+\]/.test(stdout) || // [main abc1234], [feature-branch abc1234], etc.
		(stdout.includes("files changed") &&
			(stdout.includes("insertion") || stdout.includes("deletion")))
	);
}

/**
 * Check if active spec should be completed after a git commit.
 * Detects: all Next Steps checked OR session status=completed, but spec still active.
 */
function checkSpecCompletion(projectPath: string, items: DirectiveItem[]): void {
	try {
		const slug = readActive(projectPath);
		const state = readActiveState(projectPath);
		const task = state.tasks.find((t) => t.slug === slug);
		const status = effectiveStatus(task?.status);
		if (!task || status === "done" || status === "cancelled") return;

		// Check tasks.json: all tasks checked → completion signal.
		const sd = new SpecDir(projectPath, slug);
		let allChecked = false;
		try {
			const data = JSON.parse(sd.readFile("tasks.json"));
			const allTasks = [...(data.waves ?? []).flatMap((w: any) => w.tasks), ...(data.closing?.tasks ?? [])];
			allChecked = allTasks.length > 0 && allTasks.every((t: any) => t.checked);
		} catch {
			return; // no tasks.json
		}

		if (allChecked) {
			items.push({
				level: "DIRECTIVE",
				message: `Task '${slug}' appears complete (all tasks checked). MUST call \`dossier action=complete\` to close the spec.`,
			});
		}
	} catch {
		/* no active spec or read failure — skip */
	}
}

/**
 * Save knowledge from spec on git commit — ensures decisions and session
 * snapshots accumulate even without PreCompact (1M context).
 */
function extractReviewKnowledge(projectPath: string, toolResponse: unknown): void {
	try {
		const lang = process.env.ALFRED_LANG || "en";
		let taskSlug = "";
		try {
			taskSlug = readActive(projectPath);
		} catch {
			taskSlug = "unknown";
		}

		const findings = extractReviewFindings(toolResponse, taskSlug, lang);
		if (findings.length === 0) return;

		const store = openDefaultCached();
		const saved = saveKnowledgeEntries(store, projectPath, findings, "pattern");
		if (saved > 0) {
			notifyUser("extracted %d pattern(s) from review findings", saved);
		}
	} catch {
		/* fail-open: review extraction errors don't affect PostToolUse */
	}
}

/**
 * FR-2 (feedback-metrics): Track first commit for active spec.
 * Idempotent — only records once per spec via state file.
 */
function trackFirstCommit(projectPath: string, stdout: string): void {
	try {
		const slug = readActive(projectPath);
		const stateFile = `first-commit-${slug}.json`;
		const existing = readStateJSON<{ slug?: string } | null>(projectPath, stateFile, null);
		if (existing?.slug) return; // Already tracked

		// Parse commit hash from git output: [branch hash]
		const hashMatch = stdout.match(/\[[\w./-]+ ([0-9a-f]+)\]/);
		const commit = hashMatch?.[1] ?? "unknown";

		writeStateJSON(projectPath, stateFile, {
			slug,
			commit,
			timestamp: new Date().toISOString(),
		});
	} catch {
		/* no active spec — skip */
	}
}

function saveKnowledgeOnCommit(projectPath: string): void {
	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	// Auto-promote eligible knowledge (pattern→rule at 15+ hits).
	try {
		const candidates = getPromotionCandidates(store);
		for (const c of candidates) {
			promoteSubType(store, c.id, "rule");
			notifyUser("auto-promoted knowledge '%s' to rule (%d hits)", c.title, c.hitCount);
		}
	} catch {
		/* fail-open */
	}
}
