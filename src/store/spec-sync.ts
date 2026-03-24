import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../embedder/index.js";
import { readActiveState } from "../spec/types.js";
import type { Store } from "./index.js";
import { insertEmbedding } from "./vectors.js";
import { listActiveProjects, updateProjectStatus } from "./project.js";

export interface SpecSyncResult {
	inserted: number;
	updated: number;
	deleted: number;
	embedded: number;
}

const SPEC_FILES = new Set([
	"requirements.md",
	"design.md",
	"research.md",
	"tasks.json",
	"test-specs.json",
	"bugfix.json",
]);

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function syncProjectSpecs(
	store: Store,
	projectId: string,
	projectPath: string,
	embedder?: Embedder | null,
): Promise<SpecSyncResult> {
	const result: SpecSyncResult = { inserted: 0, updated: 0, deleted: 0, embedded: 0 };
	const specsDir = join(projectPath, ".alfred", "specs");
	if (!existsSync(specsDir)) return result;

	// Read active state for task metadata
	let activeTaskMap: Map<string, { status: string; size: string; spec_type: string }> = new Map();
	try {
		const state = readActiveState(projectPath);
		for (const t of state.tasks) {
			activeTaskMap.set(t.slug, {
				status: t.status ?? "active",
				size: t.size ?? "M",
				spec_type: t.spec_type ?? "feature",
			});
		}
	} catch {
		/* no _active.json */
	}

	// Walk spec directories
	const seenIds = new Set<number>();
	let slugDirs: string[];
	try {
		slugDirs = readdirSync(specsDir).filter((d) => {
			try {
				return statSync(join(specsDir, d)).isDirectory() && !d.startsWith("_");
			} catch {
				return false;
			}
		});
	} catch {
		return result;
	}

	const now = new Date().toISOString();

	for (const slug of slugDirs) {
		const slugDir = join(specsDir, slug);
		const taskMeta = activeTaskMap.get(slug);
		const status = taskMeta ? (taskMeta.status === "completed" ? "completed" : "active") : "completed";
		const size = taskMeta?.size ?? "M";
		const specType = taskMeta?.spec_type ?? "feature";

		// Read each spec file
		let files: string[];
		try {
			files = readdirSync(slugDir).filter((f) => SPEC_FILES.has(f));
		} catch {
			continue;
		}

		for (const fileName of files) {
			const filePath = join(slugDir, fileName);
			let content: string;
			try {
				content = readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
			if (!content.trim()) continue;

			const hash = sha256(content);
			const title = extractTitle(content) || `${slug}/${fileName}`;

			// Check existing
			const existing = store.db
				.prepare(
					"SELECT id, content_hash FROM spec_index WHERE project_id = ? AND slug = ? AND file_name = ?",
				)
				.get(projectId, slug, fileName) as { id: number; content_hash: string } | undefined;

			if (existing) {
				seenIds.add(existing.id);
				if (existing.content_hash === hash) continue;

				// Update
				store.db
					.prepare(`
						UPDATE spec_index SET content_hash = ?, title = ?, content = ?,
						size = ?, spec_type = ?, status = ?, updated_at = ?
						WHERE id = ?
					`)
					.run(hash, title, content, size, specType, status, now, existing.id);
				result.updated++;

				// Re-embed if changed
				if (embedder) {
					try {
						const vec = await embedder.embedForStorage(content);
						insertEmbedding(store, "spec", existing.id, embedder.model, vec);
						result.embedded++;
					} catch { /* Voyage error — skip */ }
				}
			} else {
				// Insert
				const ins = store.db
					.prepare(`
						INSERT INTO spec_index
						(project_id, slug, file_name, content_hash, title, content, size, spec_type, status, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`)
					.run(projectId, slug, fileName, hash, title, content, size, specType, status, now, now);
				const id = Number(ins.lastInsertRowid);
				seenIds.add(id);
				result.inserted++;

				// Embed new
				if (embedder) {
					try {
						const vec = await embedder.embedForStorage(content);
						insertEmbedding(store, "spec", id, embedder.model, vec);
						result.embedded++;
					} catch { /* Voyage error — skip */ }
				}
			}
		}
	}

	// Delete orphaned spec_index entries for this project
	const allRows = store.db
		.prepare("SELECT id FROM spec_index WHERE project_id = ?")
		.all(projectId) as Array<{ id: number }>;

	const delSpec = store.db.prepare("DELETE FROM spec_index WHERE id = ?");
	const delEmbed = store.db.prepare("DELETE FROM embeddings WHERE source = 'spec' AND source_id = ?");
	for (const row of allRows) {
		if (!seenIds.has(row.id)) {
			delEmbed.run(row.id);
			delSpec.run(row.id);
			result.deleted++;
		}
	}

	return result;
}

export async function syncAllProjectSpecs(
	store: Store,
	embedder?: Embedder | null,
): Promise<SpecSyncResult> {
	const totals: SpecSyncResult = { inserted: 0, updated: 0, deleted: 0, embedded: 0 };
	const projects = listActiveProjects(store);

	for (const proj of projects) {
		// Check if path still exists
		if (!existsSync(proj.path)) {
			updateProjectStatus(store, proj.id, "missing");
			continue;
		}

		const r = await syncProjectSpecs(store, proj.id, proj.path, embedder);
		totals.inserted += r.inserted;
		totals.updated += r.updated;
		totals.deleted += r.deleted;
		totals.embedded += r.embedded;
	}

	return totals;
}

function extractTitle(content: string): string {
	// Extract first H1 heading
	const match = content.match(/^#\s+(.+)/m);
	return match?.[1]?.trim() ?? "";
}
