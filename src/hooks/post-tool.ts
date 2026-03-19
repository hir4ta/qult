import { extractReviewFindings, saveKnowledgeEntries } from "../mcp/knowledge-extractor.js";
import { truncate } from "../mcp/helpers.js";
import { updateTaskStatus } from "../spec/status.js";
import { effectiveStatus, readActive, readActiveState, SpecDir } from "../spec/types.js";
import { detectKnowledgeConflicts, searchKnowledgeFTS } from "../store/fts.js";
import { openDefaultCached } from "../store/index.js";
import { getPromotionCandidates, promoteSubType } from "../store/knowledge.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { notifyUser } from "./dispatcher.js";

import { isSpecFilePath } from "./spec-guard.js";
import { addWorkedSlug, parseWaveProgress, readStateText, readWaveProgress, writeStateText, writeWaveProgress } from "./state.js";
import { writeReviewGate } from "./review-gate.js";

function readExploreCount(cwd: string): number {
	return parseInt(readStateText(cwd, "explore-count", "0"), 10) || 0;
}

function writeExploreCount(cwd: string, n: number): void {
	writeStateText(cwd, "explore-count", String(n));
}

export async function postToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd || !ev.tool_name) return;

	const items: DirectiveItem[] = [];

	// Exploration detection (persisted across short-lived hook processes via .alfred/.state/).
	if (ev.tool_name === "Read" || ev.tool_name === "Grep" || ev.tool_name === "Glob") {
		// Skip explore tracking entirely when active spec exists (FR-9).
		let hasActiveSpec = false;
		try { readActive(ev.cwd); hasActiveSpec = true; } catch { /* no active spec */ }

		if (!hasActiveSpec) {
			const count = readExploreCount(ev.cwd) + 1;
			writeExploreCount(ev.cwd, count);
			if (count >= 5) {
				items.push({
					level: "WARNING",
					message: `5+ consecutive ${ev.tool_name} calls without a spec. Consider \`/alfred:survey\` to reverse-engineer a spec from the code.`,
				});
				writeExploreCount(ev.cwd, 0);
			}
		}

		// Archive nudge: suggest /alfred:archive for large reference files.
		if (ev.tool_name === "Read" && ev.tool_input) {
			const input = ev.tool_input as Record<string, unknown>;
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			if (isArchivableFile(filePath)) {
				items.push({
					level: "CONTEXT",
					message: `Large reference file detected (${filePath.split("/").pop()}). Consider \`/alfred:archive\` to ingest it as structured knowledge.`,
				});
			}
		}

		emitDirectives("PostToolUse", items);
		return;
	}
	writeExploreCount(ev.cwd, 0);

	if (ev.tool_name === "Bash" && !signal.aborted) {
		await handleBashResult(ev, items, signal);

		// Harvest nudge: suggest /alfred:harvest after PR merge.
		const bashResponse = ev.tool_response as { stdout?: string } | undefined;
		const bashStdout = bashResponse?.stdout ?? "";
		if (isPRMerge(bashStdout)) {
			items.push({
				level: "CONTEXT",
				message: "PR merged. Consider `/alfred:harvest` to extract review insights as permanent knowledge.",
			});
		}
	}

	// Track worked slug + auto-transition for Edit/Write.
	if ((ev.tool_name === "Edit" || ev.tool_name === "Write") && ev.tool_input) {
		const input = ev.tool_input as Record<string, unknown>;
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
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

	// On Bash success: check for git commit → living-spec, drift, wave completion.
	if (response.exitCode === 0) {
		const stdout = response.stdout ?? "";

		if (isGitCommit(stdout) && !signal.aborted) {
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

			// FR-7: Proactive conflict warning after git commit.
			await checkKnowledgeConflicts(items);

			// Wave completion detection: check tasks.md after commit.
			try {
				const slug = readActive(ev.cwd!);
				const sd = new SpecDir(ev.cwd!, slug);
				const tasksContent = sd.readFile("tasks.md");
				const waveItems = detectWaveCompletion(ev.cwd!, slug, tasksContent);
				items.push(...waveItems);
			} catch {
				/* no active spec or tasks.md */
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
 * Detect wave completion after tasks.md update.
 * When all tasks in a wave are checked: emit DIRECTIVE + set review gate.
 */
export function detectWaveCompletion(
	projectPath: string,
	taskSlug: string,
	tasksContent: string,
): DirectiveItem[] {
	const items: DirectiveItem[] = [];
	try {
		const progress = parseWaveProgress(tasksContent, taskSlug);
		const prev = readWaveProgress(projectPath);

		for (const [key, state] of Object.entries(progress.waves)) {
			// Closing Wave now also gets review-gate enforcement (FR-1: closing-wave-enforcement).
			if (state.total === 0 || state.checked < state.total) continue; // not complete

			// Check if this wave was already reviewed (from prev state or current).
			const prevWave = prev?.waves[key];
			if (prevWave?.reviewed) {
				state.reviewed = true;
				continue;
			}

			// Wave just completed — emit DIRECTIVE, set gate, and stop at first newly-completed wave.
			items.push({
				level: "DIRECTIVE",
				message: `Wave ${key} complete (${state.checked}/${state.total} tasks). You MUST now: 1) Commit your changes, 2) Run self-review (delegate to alfred:code-reviewer or /alfred:inspect), 3) Save any learnings via \`ledger save\`. Then clear the gate with \`dossier action=gate sub_action=clear reason="..."\`.`,
			});

			// FR-14: Auto-transition in-progress → review on wave completion.
			try {
				updateTaskStatus(projectPath, taskSlug, "review", "auto:wave-complete");
			} catch { /* transition error — may already be in review */ }

			writeReviewGate(projectPath, {
				gate: "wave-review",
				slug: taskSlug,
				wave: parseInt(key, 10) || 0,
				reason: `Wave ${key} self-review required`,
			});
			break; // One wave at a time — review this wave before proceeding.
		}

		// Persist progress (tracking).
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

/** Detect PR merge from gh CLI output. */
function isPRMerge(stdout: string): boolean {
	if (!stdout) return false;
	return /✓ Merged|Pull request #\d+ merged|already merged/.test(stdout);
}

/** Detect large reference files suitable for /alfred:archive. */
function isArchivableFile(filePath: string): boolean {
	if (!filePath) return false;
	const ext = filePath.toLowerCase().split(".").pop() ?? "";
	return ["pdf", "csv", "tsv", "xlsx", "docx", "txt"].includes(ext);
}

/**
 * FR-7: Check for knowledge conflicts and emit warnings.
 */
async function checkKnowledgeConflicts(items: DirectiveItem[]): Promise<void> {
	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	try {
		// Use limit=500 (not default 1000) to stay within 5s PostToolUse timeout budget.
		const conflicts = detectKnowledgeConflicts(store, 0.7, 500);
		if (conflicts.length === 0) return;

		// Include contradictions (>= 0.70) and high-similarity duplicates (>= 0.90).
		const significant = conflicts.filter(
			(c) => c.type === "potential_contradiction" || c.similarity >= 0.9,
		);

		for (const conflict of significant.slice(0, 3)) {
			const typeLabel = conflict.type === "potential_contradiction" ? "CONTRADICTION" : "DUPLICATE";
			items.push({
				level: "WARNING",
				message: `Knowledge ${typeLabel} detected (${Math.round(conflict.similarity * 100)}% similar): "${conflict.a.title}" vs "${conflict.b.title}". Consider resolving via \`ledger action=reflect\`.`,
			});
		}
	} catch {
		/* conflict detection failure is non-fatal */
	}
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

		// Check tasks.md: all checkboxes checked → completion signal.
		const sd = new SpecDir(projectPath, slug);
		let tasksContent: string;
		try {
			tasksContent = sd.readFile("tasks.md");
		} catch {
			return;
		}
		const allSteps = tasksContent.match(/^- \[[ x]\] .+$/gm);
		const allChecked =
			allSteps && allSteps.length > 0 && allSteps.every((s) => s.startsWith("- [x]"));

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
