import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "../spec/audit.js";
import {
	completeTask,
	readActive,
	readActiveState,
	reviewStatusFor,
	SpecDir,
	verifyReviewFile,
} from "../spec/types.js";
import { openDefaultCached } from "../store/index.js";
import { upsertKnowledge } from "../store/knowledge.js";
import { resolveOrRegisterProject } from "../store/project.js";
import type { KnowledgeRow } from "../types.js";
import type { HookEvent } from "./dispatcher.js";
import { notifyUser } from "./dispatcher.js";

export async function preCompact(ev: HookEvent, _signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	const projectPath = ev.cwd;
	const proj = resolveOrRegisterProject(store, projectPath);

	// Extract decisions from transcript if available.
	if (ev.transcript_path) {
		try {
			const transcript = readFileSync(ev.transcript_path, "utf-8");
			const decisions = extractDecisions(transcript);
			if (decisions.length > 0) {
				const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
				for (let idx = 0; idx < decisions.length; idx++) {
					const dec = decisions[idx]!;
					const row: KnowledgeRow = {
						id: 0,
						projectId: proj.id,
						filePath: `decisions/compact/${ts}-${idx}`,
						contentHash: "",
						title: dec.title,
						content: dec.content,
						subType: "decision",
						branch: proj.branch,
						author: "",
						createdAt: "",
						updatedAt: "",
						hitCount: 0,
						lastAccessed: "",
						enabled: true,
					};
					upsertKnowledge(store, row);
				}
				notifyUser("extracted %d decisions from transcript", decisions.length);
			}
		} catch {
			/* transcript read failure is non-fatal */
		}
	}

	// Save chapter memory (tasks.md snapshot).
	try {
		const taskSlug = readActive(projectPath);
		const sd = new SpecDir(projectPath, taskSlug);
		if (sd.exists()) {
			let tasksContent = "";
			try { tasksContent = sd.readFile("tasks.md"); } catch { /* no tasks.md */ }
			if (tasksContent) {
				const title = `${proj.name} > ${taskSlug} > chapter > tasks-state`;
				const row: KnowledgeRow = {
					id: 0,
					projectId: proj.id,
					filePath: `chapters/${taskSlug}/compact-${Date.now()}`,
					contentHash: "",
					title,
					content: tasksContent.slice(0, 2000),
					subType: "snapshot",
					branch: proj.branch,
					author: "",
					createdAt: "",
					updatedAt: "",
					hitCount: 0,
					lastAccessed: "",
					enabled: true,
				};
				upsertKnowledge(store, row);
			}

			// Write pending-compact breadcrumb for SessionStart to pick up.
			const breadcrumb = {
				claude_session_id: process.env.CLAUDE_SESSION_ID ?? "",
				task_slug: taskSlug,
				timestamp: new Date().toISOString(),
			};
			writeFileSync(
				join(projectPath, ".alfred", ".pending-compact.json"),
				JSON.stringify(breadcrumb),
			);
		}
	} catch {
		/* fail-open */
	}

	// Auto-complete task if tasks.md indicates all tasks checked.
	try {
		const taskSlug = readActive(projectPath);
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksFile = sd.readFile("tasks.md");
		if (isTasksCompleted(tasksFile)) {
			// FR-2: Apply approval gate for M+ specs before auto-complete.
			const state2 = readActiveState(projectPath);
			const task2 = state2.tasks.find((t) => t.slug === taskSlug);
			const size = task2?.size ?? "L";
			if (["M", "L"].includes(size)) {
				const reviewStatus = reviewStatusFor(projectPath, taskSlug);
				const verification = verifyReviewFile(projectPath, taskSlug);
				if (reviewStatus !== "approved" || !verification.valid) {
					notifyUser("skipped auto-complete: review not approved for %s spec '%s'", size, taskSlug);
				} else {
					doAutoComplete(projectPath, taskSlug);
				}
			} else {
				doAutoComplete(projectPath, taskSlug);
			}
		}
	} catch {
		/* fail-open */
	}

}

interface Decision {
	title: string;
	content: string;
}

const DECISION_KEYWORDS = [
	"decided",
	"決定した",
	"going with",
	"we'll",
	"chose",
	"chosen",
	"architecture",
	"アーキテクチャ",
	"design choice",
	"decided to",
];

const RATIONALE_SIGNALS = ["because", "since", "reason", "rationale", "なぜなら", "理由"];
const ALTERNATIVE_SIGNALS = ["instead of", "rather than", "alternative", "considered", "代わりに"];
const ARCH_TERMS = ["component", "module", "layer", "service", "interface", "pattern", "migration"];

function extractDecisions(transcript: string): Decision[] {
	const decisions: Decision[] = [];
	const lines = transcript.split("\n");

	for (const line of lines) {
		let entry: {
			type?: string;
			role?: string;
			content?: string;
			message?: { role?: string; content?: string };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		const text =
			typeof entry.content === "string"
				? entry.content
				: typeof entry.message?.content === "string"
					? entry.message.content
					: "";
		if (!text) continue;

		// Only look at assistant messages for decisions.
		const role = entry.role ?? entry.message?.role;
		if (role !== "assistant") continue;

		const lower = text.toLowerCase();

		// Base score from keyword matches.
		let score = 0;
		for (const kw of DECISION_KEYWORDS) {
			if (lower.includes(kw)) {
				score = 0.35;
				break;
			}
		}
		if (score === 0) continue;

		// Bonus signals.
		if (RATIONALE_SIGNALS.some((s) => lower.includes(s))) score += 0.15;
		if (ALTERNATIVE_SIGNALS.some((s) => lower.includes(s))) score += 0.15;
		for (const term of ARCH_TERMS) {
			if (lower.includes(term)) {
				score += 0.05;
				break;
			}
		}

		if (score < 0.4) continue;

		// Extract a title from the first sentence.
		const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? "Decision";
		decisions.push({
			title: firstSentence.slice(0, 100),
			content: text.slice(0, 1000),
		});
	}

	return decisions;
}

function doAutoComplete(projectPath: string, taskSlug: string): void {
	completeTask(projectPath, taskSlug);
	appendAudit(projectPath, {
		action: "spec.complete",
		target: taskSlug,
		detail: "auto-completed during compact",
		user: "auto",
	});
	notifyUser("auto-completed task '%s'", taskSlug);
}

function isTasksCompleted(tasksContent: string): boolean {
	const allSteps = tasksContent.match(/^- \[[ xX]\] .+$/gm);
	if (!allSteps || allSteps.length === 0) return false;
	return allSteps.every((step) => /^- \[[xX]\]/.test(step));
}
