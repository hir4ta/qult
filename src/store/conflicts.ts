import type { Store } from "./index.js";
import { getKnowledgeByIDs } from "./knowledge.js";
import { getProject } from "./project.js";
import { pairwiseSimilarity } from "./vectors.js";

export interface ConflictEntry {
	id: number;
	title: string;
	projectId: string;
	projectName: string;
}

export interface ConflictResult {
	conflicts: Array<{
		knowledgeA: ConflictEntry;
		knowledgeB: ConflictEntry;
		similarity: number;
		conflictType: "potential_contradiction" | "potential_duplicate";
	}>;
	truncated: boolean;
}

/**
 * Detect knowledge conflicts across projects.
 * Uses pairwiseSimilarity with crossProjectOnly + classifyConflict polarity.
 */
export function detectCrossProjectConflicts(
	store: Store,
	opts?: { limit?: number; maxEmbeddings?: number },
): ConflictResult {
	const limit = opts?.limit ?? 20;
	const maxEmbeddings = opts?.maxEmbeddings ?? 500;

	const pairs = pairwiseSimilarity(store, {
		limit: maxEmbeddings,
		minScore: 0.70,
		crossProjectOnly: true,
		subType: "decision",
	});

	const truncated = pairs.length >= maxEmbeddings;

	if (pairs.length === 0) return { conflicts: [], truncated };

	// Hydrate knowledge entries
	const allIds = [...new Set(pairs.flatMap((p) => [p.idA, p.idB]))];
	const hydrated = getKnowledgeByIDs(store, allIds);
	const docMap = new Map(hydrated.map((d) => [d.id, d]));

	const conflicts: ConflictResult["conflicts"] = [];
	for (const pair of pairs) {
		const a = docMap.get(pair.idA);
		const b = docMap.get(pair.idB);
		if (!a || !b) continue;

		const conflictType = classifyConflictPolarity(a.content, b.content);
		const projA = getProject(store, a.projectId);
		const projB = getProject(store, b.projectId);

		conflicts.push({
			knowledgeA: {
				id: a.id,
				title: a.title,
				projectId: a.projectId,
				projectName: projA?.name ?? "",
			},
			knowledgeB: {
				id: b.id,
				title: b.title,
				projectId: b.projectId,
				projectName: projB?.name ?? "",
			},
			similarity: Math.round(pair.score * 1000) / 1000,
			conflictType,
		});
	}

	conflicts.sort((a, b) => b.similarity - a.similarity);
	return {
		conflicts: conflicts.slice(0, limit),
		truncated,
	};
}

const CONTRADICTION_PAIRS: [string, string][] = [
	["always", "never"],
	["must", "must not"],
	["use", "avoid"],
	["enable", "disable"],
	["allow", "deny"],
	["required", "optional"],
	["do", "don't"],
	["add", "remove"],
	["include", "exclude"],
];

function classifyConflictPolarity(
	contentA: string,
	contentB: string,
): "potential_contradiction" | "potential_duplicate" {
	const lowerA = contentA.toLowerCase();
	const lowerB = contentB.toLowerCase();

	for (const [pos, neg] of CONTRADICTION_PAIRS) {
		if (
			(lowerA.includes(pos) && lowerB.includes(neg)) ||
			(lowerA.includes(neg) && lowerB.includes(pos))
		) {
			return "potential_contradiction";
		}
	}
	return "potential_duplicate";
}
