import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../../embedder/index.js";
import { writeReviewGate } from "../../hooks/review-gate.js";
import { appendAudit } from "../../spec/audit.js";
import { initSpec } from "../../spec/init.js";
import type { SpecSize, SpecType } from "../../spec/types.js";
import { searchKnowledgeFTS, subTypeBoost } from "../../store/fts.js";
import type { Store } from "../../store/index.js";
import { getKnowledgeByIDs } from "../../store/knowledge.js";
import { vectorSearchKnowledge } from "../../store/vectors.js";
import { truncate } from "../helpers.js";
import { type DossierParams, errorResult, jsonResult, truncateAtNewline } from "./helpers.js";

export async function dossierInit(
	projectPath: string,
	store: Store,
	emb: Embedder | null,
	params: DossierParams,
) {
	if (!params.task_slug) return errorResult("task_slug is required for init");

	const sizeOpt = params.size ? (params.size.toUpperCase() as SpecSize) : undefined;
	const specTypeOpt = params.spec_type ? (params.spec_type.toLowerCase() as SpecType) : undefined;

	let initResult;
	try {
		initResult = initSpec(projectPath, params.task_slug, params.description ?? "", {
			size: sizeOpt,
			specType: specTypeOpt,
		});
	} catch (err) {
		return errorResult(`init failed: ${err}`);
	}

	appendAudit(projectPath, {
		action: "spec.init",
		target: params.task_slug,
		detail: params.description,
		user: "mcp",
	});

	const result: Record<string, unknown> = {
		task_slug: params.task_slug,
		spec_dir: initResult.specDir.dir(),
		size: initResult.size,
		spec_type: initResult.specType,
		files: initResult.files,
	};

	// Search related knowledge.
	if (params.description && emb) {
		const suggestions = await searchRelatedKnowledge(store, emb, params.description, 5);
		if (suggestions.length > 0) result.suggested_knowledge = suggestions;
	}

	// Steering context — inject all 3 steering docs for spec creation context.
	const steeringDir = join(projectPath, ".alfred", "steering");
	const steeringFiles = ["product.md", "structure.md", "tech.md"];
	const steeringParts: string[] = [];
	for (const sf of steeringFiles) {
		const sfPath = join(steeringDir, sf);
		if (existsSync(sfPath)) {
			try {
				steeringParts.push(truncateAtNewline(readFileSync(sfPath, "utf-8"), 3000));
			} catch { /* ignore */ }
		}
	}
	if (steeringParts.length > 0) {
		result.steering_context = steeringParts.join("\n\n---\n\n");
	} else {
		result.steering_hint =
			"project steering docs not found — run `/alfred:init` to set up project context";
	}

	if (params.description) {
		result.suggested_search = `Before writing specs, search past experience: ledger action=search query="${truncate(params.description, 80)}"`;
	}

	// Language directive — tell Claude which language to write spec content in.
	const lang = process.env.ALFRED_LANG || "en";
	result.lang = lang;
	if (lang !== "en") {
		result.lang_directive = `Write ALL spec content in ${lang === "ja" ? "Japanese (日本語)" : lang}. Technical terms and IDs (FR-N, T-N.N, etc.) stay in English.`;
	}

	// FR-8: Onboarding hint for first-time users.
	result.onboarding_hint = `Spec '${params.task_slug}' created (size: ${initResult.size}). Next: write spec files → self-review → ${["M", "L", "XL"].includes(initResult.size) ? "dashboard approval → " : ""}implement per wave.`;

	// Auto-set spec-review gate (FR-2/FR-6: all sizes, including S/D).
	try {
		writeReviewGate(projectPath, {
			gate: "spec-review",
			slug: params.task_slug,
			reason: "Spec created. Run thorough self-review before requesting approval.",
		});
		result.review_gate = "spec-review";
	} catch {
		/* fail-open: gate write failure doesn't block init */
	}

	return jsonResult(result);
}

export async function searchRelatedKnowledge(
	store: Store,
	emb: Embedder,
	description: string,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	try {
		const vec = await emb.embedForSearch(description);
		const matches = vectorSearchKnowledge(store, vec, limit * 3);
		if (matches.length > 0) {
			const ids = matches.map((m) => m.sourceId);
			const scores = new Map(matches.map((m) => [m.sourceId, m.score]));
			const docs = getKnowledgeByIDs(store, ids);
			return docs
				.map((d) => ({
					label: d.title,
					source: d.subType,
					sub_type: d.subType,
					content: truncate(d.content, 500),
					relevance_score:
						Math.round((scores.get(d.id) ?? 0) * subTypeBoost(d.subType) * 100) / 100,
				}))
				.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
				.slice(0, limit);
		}
	} catch {
		/* vector search failed, try FTS */
	}

	try {
		const docs = searchKnowledgeFTS(store, description, limit);
		return docs.map((d, i) => ({
			label: d.title,
			source: d.subType,
			sub_type: d.subType,
			content: truncate(d.content, 500),
			relevance_score: Math.round((1.0 / (i + 1)) * subTypeBoost(d.subType) * 100) / 100,
		}));
	} catch {
		return [];
	}
}
