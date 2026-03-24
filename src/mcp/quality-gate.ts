import type { Embedder } from "../embedder/index.js";
import { classifyConflict, searchKnowledgeFTS } from "../store/fts.js";
import type { Store } from "../store/index.js";
import { getKnowledgeByID } from "../store/knowledge.js";
import { vectorSearchKnowledge } from "../store/vectors.js";

// --- Types ---

export interface QualityWarning {
	type: "near_duplicate" | "low_actionability" | "potential_contradiction";
	message: string;
	related?: { id: number; title: string; similarity?: number };
}

export interface SimilarEntry {
	id: number;
	title: string;
	similarity: number;
	label?: "possible_conflict";
}

export interface QualityGateResult {
	warnings: QualityWarning[];
	similarExisting: SimilarEntry[];
	embedding: number[] | null;
}

// --- Thresholds ---

const NEAR_DUPLICATE_THRESHOLD = 0.9;
const SIMILAR_THRESHOLD = 0.85;
const LOW_SIMILAR_THRESHOLD = 0.7;
const EMBEDDING_TIMEOUT_MS = 3000;
const VECTOR_SEARCH_LIMIT = 15;

// --- Actionability patterns (EN + JA) ---

const ACTIONABILITY_PATTERNS = {
	positive: [
		/使う|使用する|採用|推奨|必須|すること|すべき|統一|設定|指定|選択|移行/,
		/\b(use|must|should|prefer|require|adopt|implement|configure|set)\b/i,
	],
	negative: [
		/しない|避ける|禁止|不要|削除/,
		/\b(avoid|never|don't|do not|prohibit|forbid|remove|disable)\b/i,
	],
	conditional: [
		/場合は|ときは|のとき|場合/,
		/\b(when|if|while|where|unless)\b/i,
	],
};

// --- Main quality gate ---

interface QualityGateParams {
	title?: string;
	reasoning?: string;
	pattern?: string;
	text?: string;
}

export async function qualityGate(
	store: Store,
	emb: Embedder | null,
	embeddingText: string,
	entryContent: string,
	subType: string,
	params: QualityGateParams,
): Promise<QualityGateResult> {
	const warnings: QualityWarning[] = [];
	const similarExisting: SimilarEntry[] = [];
	let embedding: number[] | null = null;

	// FR-7: Actionability check (no API needed, always runs)
	const actionWarning = checkActionability(params, subType);
	if (actionWarning) warnings.push(actionWarning);

	// FR-6 + FR-8: Semantic duplicate + contradiction (Voyage required)
	if (emb) {
		try {
			embedding = (await rejectAfter(
				emb.embedForStorage(embeddingText),
				EMBEDDING_TIMEOUT_MS,
			)) as number[];

			if (embedding) {
				const matches = vectorSearchKnowledge(
					store,
					embedding,
					VECTOR_SEARCH_LIMIT,
					LOW_SIMILAR_THRESHOLD,
				);

				for (const match of matches) {
					const doc = getKnowledgeByID(store, match.sourceId);
					if (!doc || !doc.enabled) continue;

					// FR-6: near_duplicate
					if (match.score >= NEAR_DUPLICATE_THRESHOLD) {
						warnings.push({
							type: "near_duplicate",
							message: `類似度 ${(match.score * 100).toFixed(0)}% の既存ナレッジあり`,
							related: { id: doc.id, title: doc.title, similarity: match.score },
						});
					}

					if (match.score >= SIMILAR_THRESHOLD) {
						// FR-8: contradiction check at high similarity
						const conflictType = classifyConflict(entryContent, doc.content);
						const entry: SimilarEntry = {
							id: doc.id,
							title: doc.title,
							similarity: match.score,
						};
						if (conflictType === "potential_contradiction") {
							warnings.push({
								type: "potential_contradiction",
								message: `既存ナレッジ "${doc.title}" と矛盾の可能性`,
								related: { id: doc.id, title: doc.title, similarity: match.score },
							});
						}
						similarExisting.push(entry);
					} else if (match.score >= LOW_SIMILAR_THRESHOLD) {
						// Low-similarity: reference info only
						const conflictType = classifyConflict(entryContent, doc.content);
						similarExisting.push({
							id: doc.id,
							title: doc.title,
							similarity: match.score,
							...(conflictType === "potential_contradiction"
								? { label: "possible_conflict" as const }
								: {}),
						});
					}
				}
			}
		} catch {
			// Timeout or API failure: skip checks, continue with save
			// embedding = null → ledgerSave falls back to async embedding
		}
	}

	return { warnings, similarExisting, embedding };
}

// --- Actionability check (FR-7) ---

export function checkActionability(
	params: QualityGateParams,
	subType: string,
): QualityWarning | null {
	let targets: string[];
	switch (subType) {
		case "decision":
			targets = [params.title ?? "", params.reasoning ?? ""];
			break;
		case "pattern":
			targets = [params.title ?? "", params.pattern ?? ""];
			break;
		case "rule":
			targets = [params.title ?? "", params.text ?? ""];
			break;
		default:
			return null;
	}

	const text = targets.join(" ");
	const allPatterns = [
		...ACTIONABILITY_PATTERNS.positive,
		...ACTIONABILITY_PATTERNS.negative,
		...ACTIONABILITY_PATTERNS.conditional,
	];

	if (allPatterns.some((p) => p.test(text))) return null;

	return {
		type: "low_actionability",
		message:
			"行動指示語・条件対が見つかりません。具体的な行動指示を含めることを推奨します。",
	};
}

// --- Helpers ---

function rejectAfter<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
	]);
}
