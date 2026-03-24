import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	completeTask,
	readActive,
	SpecDir,
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

	// Decision extraction is now handled by the PreCompact agent hook (FR-5/FR-6).
	// The agent hook reads the transcript via Read tool and saves decisions via
	// `alfred hook-internal save-decision` Bash command.

	// Save chapter memory (tasks.json snapshot).
	try {
		const taskSlug = readActive(projectPath);
		const sd = new SpecDir(projectPath, taskSlug);
		if (sd.exists()) {
			let tasksContent = "";
			try { tasksContent = sd.readFile("tasks.json"); } catch { /* no tasks.json */ }
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

	// Auto-complete task if tasks.json indicates all tasks checked.
	try {
		const taskSlug = readActive(projectPath);
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksData = JSON.parse(sd.readFile("tasks.json"));
		const allTasks = [...(tasksData.waves ?? []).flatMap((w: any) => w.tasks), ...(tasksData.closing?.tasks ?? [])];
		if (allTasks.length > 0 && allTasks.every((t: any) => t.checked)) {
			doAutoComplete(projectPath, taskSlug);
		}
	} catch {
		/* fail-open */
	}

}

function doAutoComplete(projectPath: string, taskSlug: string): void {
	completeTask(projectPath, taskSlug);
	notifyUser("auto-completed task '%s'", taskSlug);
}
