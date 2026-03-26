/**
 * MCP tool handler: `alfred` — 4 actions (search, save, profile, score)
 */
import type { Embedder } from "../embedder/index.js";
import type { KnowledgeType } from "../types.js";
import type { Store } from "../store/index.js";
import { upsertKnowledge } from "../store/knowledge.js";
import { searchKnowledge } from "../store/search.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { calculateQualityScore } from "../store/quality-events.js";
import { insertEmbedding } from "../store/vectors.js";
import { getGitUserName } from "../git/user.js";

interface AlfredParams {
	action: string;
	// search
	query?: string;
	type?: string;
	scope?: string;
	limit?: number;
	// save
	title?: string;
	error_signature?: string;
	resolution?: string;
	bad?: string;
	good?: string;
	explanation?: string;
	pattern?: string;
	category?: string;
	example_files?: string;
	tags?: string;
	// common
	project_path?: string;
	// profile
	refresh?: boolean;
	// score
	session_id?: string;
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

export async function handleAlfred(store: Store, emb: Embedder | null, params: AlfredParams) {
	switch (params.action) {
		case "search":
			return alfredSearch(store, emb, params);
		case "save":
			return alfredSave(store, emb, params);
		case "profile":
			return alfredProfile(store, params);
		case "score":
			return alfredScore(store, params);
		default:
			return errorResult(`Unknown action: ${params.action}`);
	}
}

// ===== search =====

async function alfredSearch(store: Store, emb: Embedder | null, params: AlfredParams) {
	if (!emb) return errorResult("VOYAGE_API_KEY required for search");
	if (!params.query) return errorResult("query is required for search");

	const cwd = params.project_path || process.cwd();
	const proj = resolveOrRegisterProject(store, cwd);
	const scope = params.scope ?? "project";
	const typeFilter = params.type as KnowledgeType | "all" | undefined;
	// Note: vector search is already global (cosine similarity across all embeddings).
	// scope=project would need post-filtering by project_id if desired.

	try {
		const results = await searchKnowledge(store, emb, params.query, {
			type: typeFilter ?? "all",
			limit: params.limit ?? 5,
			trackHits: true,
		});

		return jsonResult({
			results: results.map((r) => ({
				id: r.entry.id,
				type: r.entry.type,
				title: r.entry.title,
				content: r.entry.content,
				score: r.score,
				matchReason: r.matchReason,
				hitCount: r.entry.hitCount,
			})),
			total: results.length,
		});
	} catch (err) {
		return errorResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ===== save =====

async function alfredSave(store: Store, emb: Embedder | null, params: AlfredParams) {
	if (!params.type) return errorResult("type is required for save (error_resolution, fix_pattern, convention, decision)");
	if (!params.title) return errorResult("title is required for save");

	const knowledgeType = params.type as KnowledgeType;
	if (!["error_resolution", "fix_pattern", "convention", "decision"].includes(knowledgeType)) {
		return errorResult(`Invalid type: ${params.type}. Must be error_resolution, exemplar, or convention`);
	}

	const cwd = params.project_path || process.cwd();
	const proj = resolveOrRegisterProject(store, cwd);
	const author = await getGitUserName(cwd);

	// Build content JSON based on type
	let content: Record<string, unknown>;
	switch (knowledgeType) {
		case "error_resolution":
			if (!params.error_signature || !params.resolution) {
				return errorResult("error_signature and resolution are required for error_resolution");
			}
			content = { error_signature: params.error_signature, resolution: params.resolution };
			break;
		case "fix_pattern":
			if (!params.bad || !params.good || !params.explanation) {
				return errorResult("bad, good, and explanation are required for fix_pattern");
			}
			content = { bad: params.bad, good: params.good, explanation: params.explanation };
			break;
		case "convention":
			if (!params.pattern) {
				return errorResult("pattern is required for convention");
			}
			content = {
				pattern: params.pattern,
				category: params.category ?? "style",
				example_files: params.example_files?.split(",").map((s) => s.trim()) ?? [],
			};
			break;
		default:
			return errorResult(`Unknown type: ${knowledgeType}`);
	}

	const contentStr = JSON.stringify(content);
	const { id, changed } = upsertKnowledge(store, {
		projectId: proj.id,
		type: knowledgeType,
		title: params.title,
		content: contentStr,
		tags: params.tags ?? "",
		author,
	});

	// Embed for vector search
	if (emb && changed) {
		try {
			const embedText = `${params.title}\n${contentStr}`;
			const vector = await emb.embedForStorage(embedText);
			insertEmbedding(store, id, emb.model, vector);
		} catch {
			// fail-open: save succeeded, embedding failed
		}
	}

	return jsonResult({ id, status: changed ? "saved" : "unchanged" });
}

// ===== profile =====

async function alfredProfile(store: Store, params: AlfredParams) {
	const cwd = params.project_path || process.cwd();

	// Read project-profile.json if exists
	const { existsSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const profilePath = join(cwd, ".alfred", ".state", "project-profile.json");

	if (existsSync(profilePath) && !params.refresh) {
		try {
			const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
			return jsonResult(profile);
		} catch { /* fall through to detect */ }
	}

	// Auto-detect project profile
	const { detectProjectProfile } = await import("../profile/detect.js");
	const profile = detectProjectProfile(cwd);

	// Save to state file
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const stateDir = join(cwd, ".alfred", ".state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");

	return jsonResult(profile);
}

// ===== score =====

async function alfredScore(store: Store, params: AlfredParams) {
	const sessionId = params.session_id ?? "current";
	const score = calculateQualityScore(store, sessionId);
	return jsonResult(score);
}
