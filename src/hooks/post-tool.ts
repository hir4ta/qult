import { extractReviewFindings, saveKnowledgeEntries } from "../mcp/knowledge-extractor.js";
import { updateTaskStatus } from "../spec/status.js";
import { effectiveStatus, readActive, readActiveState, SpecDir } from "../spec/types.js";
import { openDefaultCached } from "../store/index.js";
import { getPromotionCandidates, promoteSubType } from "../store/knowledge.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { notifyUser } from "./dispatcher.js";

import { isSpecFilePath } from "./spec-guard.js";
import { addWorkedSlug, readStateJSON, readWaveProgress, writeStateJSON, writeWaveProgress } from "./state.js";
import { readReviewGate, writeReviewGate } from "./review-gate.js";

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

	// Track worked slug + auto-transition for Edit/Write.
	if ((ev.tool_name === "Edit" || ev.tool_name === "Write") && ev.tool_input) {
		const input = ev.tool_input as Record<string, unknown>;
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		try {
			const slug = readActive(ev.cwd!);
			addWorkedSlug(ev.cwd!, slug);

			// Auto-transition pending → in-progress on first source edit (.alfred/ excluded).
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

	// Extract knowledge from review agent findings + mark re-reviewed flag.
	if (ev.tool_name === "Agent" && ev.tool_response) {
		extractReviewKnowledge(ev.cwd!, ev.tool_response);
		markReReviewedIfFixMode(ev.cwd!, ev.tool_response);
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

	// On Bash success: detect git commit → living spec + wave completion + knowledge.
	if (response.exitCode === 0) {
		const stdout = response.stdout ?? "";

		if (isGitCommit(stdout) && !signal.aborted) {
			trackFirstCommit(ev.cwd!, stdout);

			// Living Spec auto-append: track new source files in design.md.
			try {
				const { handleLivingSpec } = await import("./living-spec.js");
				handleLivingSpec(ev.cwd!);
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

			// Auto-promote eligible knowledge (pattern→rule at 15+ hits).
			saveKnowledgeOnCommit(ev.cwd!);
		}
	}
}

/**
 * Detect git commit from Bash stdout.
 */
export function isGitCommit(stdout: string): boolean {
	if (!stdout) return false;
	return (
		/\[[\w./-]+ [0-9a-f]+\]/.test(stdout) ||
		(stdout.includes("files changed") &&
			(stdout.includes("insertion") || stdout.includes("deletion")))
	);
}

/**
 * Detect wave completion after git commit.
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

function trackFirstCommit(projectPath: string, stdout: string): void {
	try {
		const slug = readActive(projectPath);
		const stateFile = `first-commit-${slug}.json`;
		const existing = readStateJSON<{ slug?: string } | null>(projectPath, stateFile, null);
		if (existing?.slug) return;

		const hashMatch = stdout.match(/\[[\w./-]+ ([0-9a-f]+)\]/);
		const commit = hashMatch?.[1] ?? "unknown";

		writeStateJSON(projectPath, stateFile, { slug, commit, timestamp: new Date().toISOString() });
	} catch { /* no active spec */ }
}

function saveKnowledgeOnCommit(projectPath: string): void {
	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	try {
		const candidates = getPromotionCandidates(store);
		for (const c of candidates) {
			promoteSubType(store, c.id, "rule");
			notifyUser("auto-promoted knowledge '%s' to rule (%d hits)", c.title, c.hitCount);
		}
	} catch { /* fail-open */ }
}

function extractReviewKnowledge(projectPath: string, toolResponse: unknown): void {
	try {
		const lang = process.env.ALFRED_LANG || "en";
		let taskSlug = "";
		try { taskSlug = readActive(projectPath); } catch { taskSlug = "unknown"; }

		const findings = extractReviewFindings(toolResponse, taskSlug, lang);
		if (findings.length === 0) return;

		const store = openDefaultCached();
		const saved = saveKnowledgeEntries(store, projectPath, findings, "pattern");
		if (saved > 0) {
			notifyUser("extracted %d pattern(s) from review findings", saved);
		}
	} catch { /* fail-open */ }
}

function markReReviewedIfFixMode(projectPath: string, toolResponse: unknown): void {
	try {
		const gate = readReviewGate(projectPath);
		if (!gate?.fix_mode || gate.re_reviewed) return;

		const text = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
		const structuralPatterns = [
			/\bfinding/i, /\bverdict/i, /\breview\s+summary/i,
			/PASS\s+(WITH\s+)?WARNING/i, /NEEDS\s+FIX/i,
			/\breview\b.*\bcomplete/i, /\d+\s+critical/i,
		];
		const severityPatterns = [/\bcritical\b/i, /\bhigh\b/i, /\bmedium\b/i, /\blow\b/i];
		const hasStructural = structuralPatterns.some((p) => p.test(text));
		const hasSeverity = severityPatterns.some((p) => p.test(text));
		if (!hasStructural || !hasSeverity) return;

		gate.re_reviewed = true;
		gate.re_reviewed_at = new Date().toISOString();
		writeStateJSON(projectPath, "review-gate.json", gate);
		notifyUser("re-review detected — gate clear is now allowed");
	} catch { /* fail-open */ }
}
