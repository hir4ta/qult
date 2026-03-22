import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncate } from "../mcp/helpers.js";
import { readActive, readActiveState, SpecDir } from "../spec/types.js";
import { openDefaultCached } from "../store/index.js";
import {
	countKnowledge,
	deleteOrphanKnowledge,
	getRecentDecisions,
	upsertKnowledge,
} from "../store/knowledge.js";
import { resolveOrRegisterProject } from "../store/project.js";
import type { KnowledgeRow } from "../types.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { extractSection, notifyUser } from "./dispatcher.js";
import { resetWorkedSlugs, writeStateJSON } from "./state.js";

export async function sessionStart(ev: HookEvent, _signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// Reset session-scoped state (for Stop hook scoping + spec-prompt).
	if (existsSync(join(ev.cwd, ".alfred"))) {
		resetWorkedSlugs(ev.cwd);
		writeStateJSON(ev.cwd, "spec-prompt.json", {});
	}

	let store;
	try {
		store = openDefaultCached();
	} catch (err) {
		notifyUser("warning: store open failed: %s", err);
		return;
	}

	// Run independent operations (fail-open, synchronous — Node.js single-threaded).
	try {
		syncKnowledgeIndex(store, ev.cwd);
	} catch (err) {
		notifyUser("warning: knowledge sync failed: %s", err);
	}

	// Suggest /alfred:init if steering docs are missing.
	const steeringDir = join(ev.cwd, ".alfred", "steering");
	if (!existsSync(join(steeringDir, "product.md"))) {
		notifyUser(
			"tip: run `/alfred:init` to set up project steering docs, templates, and knowledge index",
		);
	}

	// Suggest ledger reflect when knowledge base has grown.
	suggestLedgerReflect(store);

	// Collect all directive items for single emit (NFR-4).
	const items: DirectiveItem[] = [];

	// FR-5: 1% rule — fires regardless of active spec, only needs .alfred/.
	if (existsSync(join(ev.cwd, ".alfred"))) {
		items.push({
			level: "CONTEXT",
			message:
				"If there is even a small chance an alfred skill applies to this task, invoke it.",
		});
	}

	// Spec context + decision replay (returns items, does not emit).
	items.push(...buildSpecContextItems(ev.cwd, ev.source ?? "", store));

	if (items.length > 0) {
		emitDirectives("SessionStart", items);
	}
}

function syncKnowledgeIndex(
	store: ReturnType<typeof openDefaultCached>,
	projectPath: string,
): void {
	const knowledgeDir = join(projectPath, ".alfred", "knowledge");
	const proj = resolveOrRegisterProject(store, projectPath);
	let synced = 0;
	const validFilePaths = new Set<string>();

	// Walk decisions/, patterns/, rules/ subdirectories for JSON files.
	for (const typeDir of ["decisions", "patterns", "rules"]) {
		const dir = join(knowledgeDir, typeDir);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			continue;
		}

		for (const file of files) {
			try {
				const raw = readFileSync(join(dir, file), "utf-8");
				const entry = JSON.parse(raw) as { id?: string; title?: string; createdAt?: string; author?: string };
				const filePath = `${typeDir}/${file}`;
				validFilePaths.add(filePath);
				const subType =
					typeDir === "decisions" ? "decision" : typeDir === "patterns" ? "pattern" : "rule";
				const row: KnowledgeRow = {
					id: 0,
					projectId: proj.id,
					filePath,
					contentHash: "",
					title: entry.title ?? entry.id ?? file.replace(".json", ""),
					content: raw,
					subType,
					branch: proj.branch,
					author: entry.author ?? "",
					createdAt: entry.createdAt ?? "",
					updatedAt: "",
					hitCount: 0,
					lastAccessed: "",
					enabled: true,
				};
				const { changed } = upsertKnowledge(store, row);
				if (changed) synced++;
			} catch {}
		}
	}

	// Legacy: also sync any .md files at root level (backward compat, will be removed later).
	try {
		const mdFiles = readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
		for (const file of mdFiles) {
			try {
				validFilePaths.add(file);
				const content = readFileSync(join(knowledgeDir, file), "utf-8");
				const { frontmatter, body } = parseFrontmatter(content);
				const row: KnowledgeRow = {
					id: 0,
					projectId: proj.id,
					filePath: file,
					contentHash: "",
					title: frontmatter.id ?? file.replace(".md", ""),
					content: body,
					subType:
						frontmatter.type === "decision"
							? "decision"
							: frontmatter.type === "pattern"
								? "pattern"
								: frontmatter.type === "rule"
									? "rule"
									: "snapshot",
					branch: proj.branch,
					author: "",
					createdAt: frontmatter.created_at ?? "",
					updatedAt: "",
					hitCount: 0,
					lastAccessed: "",
					enabled: true,
				};
				const { changed } = upsertKnowledge(store, row);
				if (changed) synced++;
			} catch {}
		}
	} catch {
		/* no legacy files */
	}

	// Clean orphan entries: DB is a derived index; entries without source files are stale.
	try {
		const deleted = deleteOrphanKnowledge(store, proj.id, proj.branch, validFilePaths);
		if (deleted > 0) {
			notifyUser("cleaned %d orphan knowledge entries from index", deleted);
		}
	} catch (err) {
		notifyUser("warning: orphan knowledge cleanup failed: %s", err);
	}

	if (synced > 0) {
		notifyUser("synced %d knowledge files to index", synced);
	}
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const fm: Record<string, string> = {};
	if (!content.startsWith("---")) return { frontmatter: fm, body: content };

	const end = content.indexOf("---", 3);
	if (end === -1) return { frontmatter: fm, body: content };

	const fmBlock = content.slice(3, end).trim();
	for (const line of fmBlock.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			fm[key] = val;
		}
	}
	return { frontmatter: fm, body: content.slice(end + 3).trim() };
}

function suggestLedgerReflect(store: ReturnType<typeof openDefaultCached>): void {
	try {
		const count = countKnowledge(store, "");
		if (count < 20) return;
		notifyUser(
			"knowledge health: %d memories. Consider `ledger action=reflect` for a health report.",
			count,
		);
	} catch {
		/* ignore */
	}
}

function buildSpecContextItems(
	projectPath: string,
	source: string,
	store: ReturnType<typeof openDefaultCached>,
): DirectiveItem[] {
	let taskSlug: string;
	try {
		taskSlug = readActive(projectPath);
	} catch {
		return [];
	}

	// Skip completed tasks.
	try {
		const state = readActiveState(projectPath);
		const task = state.tasks.find((t) => t.slug === taskSlug);
		if (task?.status === "completed") return [];
	} catch {
		/* ignore */
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (!sd.exists()) return [];

	let buf = `\n--- Alfred Protocol: Active Task '${taskSlug}' ---\n`;

	const isCompact = source === "compact";
	const proj = resolveOrRegisterProject(store, projectPath);
	const memoryCount = countKnowledge(store, proj.id);

	if (isCompact || memoryCount <= 5) {
		// Full context recovery: inject all spec files.
		buf += isCompact ? "Post-compact recovery:\n\n" : "(Full context — new project)\n\n";
		for (const section of sd.allSections()) {
			if (section.content.trim()) {
				buf += `### ${section.file}\n${section.content}\n\n`;
			}
		}
	} else {
		// Lightweight: tasks.md only (progress + next steps).
		try {
			const tasks = sd.readFile("tasks.md");
			buf += `### tasks.md\n${tasks}\n\n`;
		} catch { /* no tasks.md */ }
		if (memoryCount <= 20) {
			try {
				const req = sd.readFile("requirements.md");
				const goal = extractSection(req, "## Goal");
				if (goal) buf += `\nGoal: ${goal}\n`;
			} catch { /* ignore */ }
		}
	}

	buf += "--- End Alfred Protocol ---\n";

	const decisionItems = injectRecentDecisions(store, projectPath);
	const items: DirectiveItem[] = [{ level: "CONTEXT", message: buf }, ...decisionItems];
	notifyUser(
		"injected context for task '%s' (memories: %d, decisions: %d)",
		taskSlug,
		memoryCount,
		decisionItems.length,
	);
	return items;
}

/**
 * FR-9: Search for recent decision-type knowledge entries and return as CONTEXT items.
 * Only fires when an active spec exists. Scoped to current project.
 */
function injectRecentDecisions(
	store: ReturnType<typeof openDefaultCached>,
	projectPath: string,
): DirectiveItem[] {
	// Guard: only inject if active spec exists.
	try {
		readActive(projectPath);
	} catch {
		return [];
	}

	const proj = resolveOrRegisterProject(store, projectPath);
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

	try {
		const rows = getRecentDecisions(store, proj.id, sevenDaysAgo, 5);
		if (rows.length === 0) return [];

		const lines = rows.map((r) => `- ${r.title}: ${truncate(r.content, 150)}`);
		return [
			{
				level: "CONTEXT",
				message: `Recent decisions (last 7 days):\n${lines.join("\n")}`,
			},
		];
	} catch {
		return [];
	}
}
