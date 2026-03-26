/**
 * Knowledge garbage collection — active lifecycle management.
 *
 * 3-tier lifecycle: Active (enabled=1) → Dormant (enabled=0) → Delete.
 * Runs at SessionStart to keep the knowledge DB clean and relevant.
 *
 * Research: FadeMem shows aggressive forgetting improves retrieval quality
 * (82.1% retention at 55% storage > 78.4% at 100%).
 */
import type { KnowledgeType } from "../types.js";
import type { Store } from "./index.js";

export interface GCConfig {
	/** Days without access before marking dormant */
	dormantDays: Record<KnowledgeType, number>;
	/** Days in dormant state before deletion */
	deleteDays: Record<KnowledgeType, number>;
	/** Maximum entries per project per type */
	hardCaps: Record<KnowledgeType, number>;
}

export const DEFAULT_GC_CONFIG: GCConfig = {
	dormantDays: {
		error_resolution: 45,
		fix_pattern: 60,
		convention: 365, // conventions are slow-changing
		decision: 90,
	},
	deleteDays: {
		error_resolution: 90,
		fix_pattern: 120,
		convention: 365,
		decision: 180,
	},
	hardCaps: {
		error_resolution: 500,
		fix_pattern: 300,
		convention: 100,
		decision: 200,
	},
};

export interface GCResult {
	dormanted: number;
	deleted: number;
	capEnforced: number;
}

/**
 * Run garbage collection for a project's knowledge entries.
 */
export function gc(
	store: Store,
	projectId: string,
	config: GCConfig = DEFAULT_GC_CONFIG,
): GCResult {
	const result: GCResult = { dormanted: 0, deleted: 0, capEnforced: 0 };

	const types: KnowledgeType[] = ["error_resolution", "fix_pattern", "convention", "decision"];

	for (const type of types) {
		const dormantDays = config.dormantDays[type];
		const deleteDays = config.deleteDays[type];
		const cap = config.hardCaps[type];

		// 1. Move stale active entries to dormant
		//    Criteria: enabled, hit_count < 2, not accessed in dormantDays
		const dormanted = store.db
			.prepare(`
				UPDATE knowledge_index SET enabled = 0, updated_at = datetime('now')
				WHERE project_id = ? AND type = ? AND enabled = 1 AND hit_count < 2
				AND COALESCE(NULLIF(last_accessed, ''), updated_at) < datetime('now', ?)
			`)
			.run(projectId, type, `-${dormantDays} days`);
		result.dormanted += dormanted.changes;

		// 2. Delete long-dormant entries
		const toDelete = store.db
			.prepare(`
				SELECT id FROM knowledge_index
				WHERE project_id = ? AND type = ? AND enabled = 0
				AND updated_at < datetime('now', ?)
			`)
			.all(projectId, type, `-${deleteDays} days`) as Array<{ id: number }>;

		for (const row of toDelete) {
			store.db
				.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?")
				.run(row.id);
			store.db.prepare("DELETE FROM knowledge_index WHERE id = ?").run(row.id);
			result.deleted++;
		}

		// 3. Enforce hard cap (keep top N by utility_score + updated_at)
		const overCap = store.db
			.prepare(`
				SELECT id FROM knowledge_index
				WHERE project_id = ? AND type = ? AND enabled = 1
				ORDER BY utility_score DESC, updated_at DESC
				LIMIT -1 OFFSET ?
			`)
			.all(projectId, type, cap) as Array<{ id: number }>;

		for (const row of overCap) {
			store.db
				.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?")
				.run(row.id);
			store.db.prepare("DELETE FROM knowledge_index WHERE id = ?").run(row.id);
			result.capEnforced++;
		}
	}

	return result;
}

/**
 * Update utility score based on injection outcome.
 * Uses Laplace smoothing: (success + 1) / (success + failure + 2).
 */
export function updateUtility(store: Store, id: number, success: boolean): void {
	const col = success ? "success_count" : "failure_count";
	store.db
		.prepare(`
			UPDATE knowledge_index
			SET ${col} = ${col} + 1,
				utility_score = CAST((success_count + ${success ? 1 : 0} + 1) AS REAL) /
				                (success_count + ${success ? 1 : 0} + failure_count + ${success ? 0 : 1} + 2),
				updated_at = datetime('now')
			WHERE id = ?
		`)
		.run(id);
}

/**
 * Compute utility score from counts (for testing).
 */
export function computeUtilityScore(success: number, failure: number): number {
	return (success + 1) / (success + failure + 2);
}
