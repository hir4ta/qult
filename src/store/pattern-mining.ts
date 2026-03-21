import type { Store } from "./index.js";
import { getKnowledgeByIDs } from "./knowledge.js";
import { getProject } from "./project.js";
import { pairwiseSimilarity } from "./vectors.js";

export interface MiningResult {
	commonPatterns: Array<{
		pattern: string;
		projects: string[];
		similarity: number;
		entryIds: number[];
	}>;
	truncated: boolean;
}

/**
 * Detect common patterns across 3+ projects.
 * Requires Voyage API (vector embeddings). Returns partial results on timeout.
 */
export function mineCommonPatterns(
	store: Store,
	opts?: { timeoutMs?: number; maxEmbeddings?: number },
): MiningResult {
	const timeoutMs = opts?.timeoutMs ?? 30000;
	const maxEmbeddings = opts?.maxEmbeddings ?? 500;
	const startTime = Date.now();

	const pairs = pairwiseSimilarity(store, {
		limit: maxEmbeddings,
		minScore: 0.80,
		crossProjectOnly: true,
		subType: "pattern",
	});

	const truncated = pairs.length >= maxEmbeddings;

	if (pairs.length === 0) return { commonPatterns: [], truncated };

	// Build adjacency graph of similar patterns
	const graph = new Map<number, Set<number>>();
	const projectMap = new Map<number, string>(); // id → projectId

	for (const pair of pairs) {
		if (Date.now() - startTime > timeoutMs) {
			return { commonPatterns: [], truncated: true };
		}

		if (!graph.has(pair.idA)) graph.set(pair.idA, new Set());
		if (!graph.has(pair.idB)) graph.set(pair.idB, new Set());
		graph.get(pair.idA)!.add(pair.idB);
		graph.get(pair.idB)!.add(pair.idA);
		if (pair.projectIdA) projectMap.set(pair.idA, pair.projectIdA);
		if (pair.projectIdB) projectMap.set(pair.idB, pair.projectIdB);
	}

	// Find clusters (connected components) spanning 3+ projects
	const visited = new Set<number>();
	const clusters: Array<{ ids: number[]; projects: Set<string> }> = [];

	for (const nodeId of graph.keys()) {
		if (visited.has(nodeId)) continue;
		if (Date.now() - startTime > timeoutMs) break;

		const cluster: number[] = [];
		const clusterProjects = new Set<string>();
		const queue = [nodeId];

		while (queue.length > 0) {
			const id = queue.pop()!;
			if (visited.has(id)) continue;
			visited.add(id);
			cluster.push(id);
			const projId = projectMap.get(id);
			if (projId) clusterProjects.add(projId);

			for (const neighbor of graph.get(id) ?? []) {
				if (!visited.has(neighbor)) queue.push(neighbor);
			}
		}

		if (clusterProjects.size >= 3) {
			clusters.push({ ids: cluster, projects: clusterProjects });
		}
	}

	if (clusters.length === 0) return { commonPatterns: [], truncated };

	// Hydrate and build results
	const allIds = clusters.flatMap((c) => c.ids);
	const hydrated = getKnowledgeByIDs(store, allIds);
	const docMap = new Map(hydrated.map((d) => [d.id, d]));

	const commonPatterns: MiningResult["commonPatterns"] = [];
	for (const cluster of clusters) {
		const representative = docMap.get(cluster.ids[0]!);
		if (!representative) continue;

		const projectNames: string[] = [];
		for (const projId of cluster.projects) {
			const proj = getProject(store, projId);
			if (proj) projectNames.push(proj.name);
		}

		commonPatterns.push({
			pattern: representative.title,
			projects: projectNames,
			similarity: 0.80, // minimum threshold
			entryIds: cluster.ids,
		});
	}

	return { commonPatterns, truncated };
}
