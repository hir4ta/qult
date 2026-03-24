import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../embedder/index.js";
import type { Store } from "../store/index.js";
import { subTypeHalfLife } from "../store/fts.js";
import {
	getKnowledgeByID,
	getKnowledgeStats,
	getPromotionCandidates,
	promoteSubType,
	upsertKnowledge,
} from "../store/knowledge.js";
import { getGitUserName as getGitUser } from "../git/user.js";
import { resolveOrRegisterProject } from "../store/project.js";
import type { DecisionEntry, KnowledgeRow, PatternEntry, RuleEntry } from "../types.js";
import { VALID_SUB_TYPES } from "../types.js";
import { searchPipeline, trackHitCounts, truncate } from "./helpers.js";
import { qualityGate } from "./quality-gate.js";

interface LedgerParams {
	action: string;
	id?: number;
	query?: string;
	label?: string;
	limit?: number;
	detail?: string;
	sub_type?: string;
	title?: string;
	// Decision fields
	decision?: string;
	reasoning?: string;
	alternatives?: string;
	context_text?: string;
	// Pattern fields
	pattern_type?: string;
	pattern?: string;
	application_conditions?: string;
	expected_outcomes?: string;
	// Rule fields
	key?: string;
	text?: string;
	category?: string;
	priority?: string;
	rationale?: string;
	source_ref?: string;
	// Common
	tags?: string;
	project_path?: string;
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
		isError: true as const,
	};
}

export async function handleLedger(store: Store, emb: Embedder | null, params: LedgerParams) {
	switch (params.action) {
		case "search":
			return ledgerSearch(store, emb, params);
		case "save":
			return ledgerSave(store, emb, params);
		case "promote":
			return ledgerPromote(store, params);
		case "candidates":
			return ledgerCandidates(store);
		case "verify":
			return ledgerVerify(store, params);
		case "stale":
			return jsonResult({ message: "feature removed in schema V8" });
		case "audit-conventions":
			return jsonResult({ status: "not_implemented" });
		default:
			return errorResult(`unknown action: ${params.action}`);
	}
}

// --- Search ---

async function ledgerSearch(store: Store, emb: Embedder | null, params: LedgerParams) {
	const query = params.query ?? "";
	const lang = process.env.ALFRED_LANG || "en";
	let limit = params.limit ?? 10;
	const detail = params.detail ?? "summary";
	const warnings: string[] = [];

	if (limit > 100) {
		limit = 100;
		warnings.push("limit capped to 100");
	}
	if (!query.trim()) return errorResult("query is required for search");

	const overRetrieve = Math.max(limit * 3, 30);
	const result = await searchPipeline(store, emb, query, limit, overRetrieve);
	warnings.push(...result.warnings);

	let scored = result.scoredDocs;
	if (params.sub_type) {
		scored = scored.filter((sd) => sd.doc.subType === params.sub_type);
	}
	// Exclude snapshots from search results.
	scored = scored.filter((sd) => sd.doc.subType !== "snapshot");

	trackHitCounts(store, scored);

	const results = scored.map((sd) => ({
		...formatDoc(sd.doc, detail),
		relevance_score: sd.score,
		match_reason: sd.matchReason,
	}));

	return jsonResult({
		query,
		results,
		count: results.length,
		search_method: result.searchMethod,
		lang,
		...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
	});
}

function formatDoc(d: KnowledgeRow, detail: string) {
	const base: Record<string, unknown> = { title: d.title, sub_type: d.subType };
	if (detail === "compact") return base;

	base.file_path = d.filePath;
	base.saved_at = d.createdAt;

	// Try parsing JSON content for structured display.
	if (detail === "full" || detail === "summary") {
		try {
			const parsed = JSON.parse(d.content);
			if (d.subType === "decision") {
				base.decision = parsed.decision;
				base.reasoning =
					detail === "full" ? parsed.reasoning : truncate(parsed.reasoning ?? "", 200);
				if (detail === "full" && parsed.alternatives) base.alternatives = parsed.alternatives;
				if (parsed.tags) base.tags = parsed.tags;
			} else if (d.subType === "pattern") {
				base.pattern_type = parsed.type;
				base.pattern = detail === "full" ? parsed.pattern : truncate(parsed.pattern ?? "", 200);
				if (detail === "full") {
					base.application_conditions = parsed.applicationConditions;
					base.expected_outcomes = parsed.expectedOutcomes;
				}
				if (parsed.tags) base.tags = parsed.tags;
			} else if (d.subType === "rule") {
				base.key = parsed.key;
				base.text = parsed.text;
				base.priority = parsed.priority;
				if (detail === "full") {
					base.rationale = parsed.rationale;
					base.source_ref = parsed.sourceRef;
				}
				if (parsed.tags) base.tags = parsed.tags;
			} else {
				// Fallback for snapshot or unknown types.
				base.content = detail === "full" ? d.content : truncate(d.content, 200);
			}
		} catch {
			// Legacy plain text content — fallback.
			base.content = detail === "full" ? d.content : truncate(d.content, 200);
		}
	}
	return base;
}

// --- Save ---

function toLang(): string {
	return process.env.ALFRED_LANG || "en";
}

function toKebabId(prefix: string, title: string): string {
	// Try ASCII slug first; fall back to hash for non-ASCII titles.
	const ascii = title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 50)
		.replace(/-$/, "");
	if (ascii.length >= 3) return `${prefix}-${ascii}`;
	// Non-ASCII fallback: use short hash of original title.
	const hash = createHash("sha256").update(title).digest("hex").slice(0, 12);
	return `${prefix}-${hash}`;
}

/**
 * Atomic write: write to temp file then rename (POSIX atomic).
 */
function atomicWriteSync(filePath: string, data: string): void {
	const tmp = `${filePath}.tmp.${process.pid}`;
	try {
		writeFileSync(tmp, data);
		renameSync(tmp, filePath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* cleanup best-effort */
		}
		throw err;
	}
}

/**
 * Write knowledge entry JSON to .alfred/knowledge/{type}/{id}.json.
 * Exported for use by knowledge-extractor.ts.
 */
export function writeKnowledgeFile(
	projectPath: string,
	subType: string,
	id: string,
	entry: unknown,
): string {
	const typeDir =
		subType === "decision" ? "decisions" : subType === "pattern" ? "patterns" : "rules";
	const knowledgeDir = join(projectPath, ".alfred", "knowledge", typeDir);
	mkdirSync(knowledgeDir, { recursive: true });
	const filePath = join(typeDir, `${id}.json`);
	atomicWriteSync(
		join(projectPath, ".alfred", "knowledge", filePath),
		`${JSON.stringify(entry, null, 2)}\n`,
	);
	return filePath;
}

/**
 * FR-1a: Compute verification_due date from a base date and half-life in days.
 */
export function computeVerificationDue(baseDate: Date, halfLifeDays: number): string {
	return new Date(baseDate.getTime() + (halfLifeDays / 2) * 86400000).toISOString();
}

const MAX_EMBEDDING_LENGTH = 1500;

/**
 * Build embedding text optimized per sub_type for vector search.
 * Truncated to MAX_EMBEDDING_LENGTH to avoid model token limits.
 */
function buildEmbeddingText(subType: string, params: LedgerParams): string {
	let parts: string[];
	switch (subType) {
		case "decision":
			parts = [
				params.title ?? "",
				params.context_text ?? "",
				params.decision ?? "",
				params.alternatives ?? "",
			];
			break;
		case "pattern":
			parts = [
				params.title ?? "",
				params.context_text ?? "",
				params.pattern ?? "",
				params.application_conditions ?? "",
			];
			break;
		case "rule":
			parts = [
				params.title ?? "",
				params.text ?? "",
				params.rationale ?? "",
				params.category ?? "",
			];
			break;
		default:
			parts = [params.title ?? "", params.context_text ?? ""];
	}
	const text = parts.filter(Boolean).join(" ");
	return text.length > MAX_EMBEDDING_LENGTH ? text.slice(0, MAX_EMBEDDING_LENGTH) : text;
}

function parseTags(tagsStr: string | undefined): string[] {
	return (tagsStr ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

const MAX_TITLE_LENGTH = 200;

/**
 * Detect serialized JSON objects/arrays dumped into text fields.
 */
function looksLikeJSON(s: string): boolean {
	const t = s.trim();
	return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

/**
 * Validate knowledge fields before saving. Rejects garbage data early.
 */
function validateKnowledgeFields(params: LedgerParams): string | null {
	// Title validation
	if (params.title && looksLikeJSON(params.title)) {
		return "title must be natural language, not JSON. Provide a concise summary sentence.";
	}
	if (params.title && params.title.length > MAX_TITLE_LENGTH) {
		return `title must be ${MAX_TITLE_LENGTH} characters or less (got ${params.title.length})`;
	}
	if (params.label && looksLikeJSON(params.label)) {
		return "label must be natural language, not JSON.";
	}

	// Content field validation (decision / pattern / text)
	for (const [field, value] of [
		["decision", params.decision],
		["pattern", params.pattern],
		["text", params.text],
		["reasoning", params.reasoning],
	] as const) {
		if (value && looksLikeJSON(value)) {
			return `${field} must be natural language, not JSON. Describe the ${field} in plain text.`;
		}
	}

	// Whitespace-only detection for required fields
	if (params.title?.trim() === "") return "title must not be empty or whitespace-only";
	if (params.label?.trim() === "") return "label must not be empty or whitespace-only";

	return null; // valid
}

async function ledgerSave(store: Store, emb: Embedder | null, params: LedgerParams) {
	const subType = params.sub_type;
	if (!subType || !(VALID_SUB_TYPES as readonly string[]).includes(subType)) {
		return errorResult("sub_type must be decision, pattern, or rule");
	}
	if (!params.title) return errorResult("title is required for save");
	if (!params.label) return errorResult("label is required for save");

	// Validate field quality before constructing entry.
	const validationError = validateKnowledgeFields(params);
	if (validationError) return errorResult(validationError);

	const now = new Date().toISOString();
	const lang = toLang();
	const tags = parseTags(params.tags);
	const projectPath = params.project_path ?? process.cwd();
	const author = getGitUser(projectPath);
	let entry: DecisionEntry | PatternEntry | RuleEntry;
	let id: string;

	switch (subType) {
		case "decision": {
			if (!params.decision) return errorResult("decision field is required for decision type");
			if (!params.reasoning) return errorResult("reasoning field is required for decision type");
			id = toKebabId("dec", params.title);
			entry = {
				id,
				title: params.title,
				context: params.context_text ?? "",
				decision: params.decision,
				reasoning: params.reasoning,
				alternatives: (params.alternatives ?? "").split("\n").filter(Boolean),
				tags,
				createdAt: now,
				status: "approved",
				lang,
				author,
			} satisfies DecisionEntry;
			break;
		}
		case "pattern": {
			if (!params.pattern) return errorResult("pattern field is required for pattern type");
			id = toKebabId("pat", params.title);
			entry = {
				id,
				title: params.title,
				type: (params.pattern_type as PatternEntry["type"]) ?? "good",
				context: params.context_text ?? "",
				pattern: params.pattern,
				applicationConditions: params.application_conditions ?? "",
				expectedOutcomes: params.expected_outcomes ?? "",
				tags,
				createdAt: now,
				status: "approved",
				lang,
				author,
			} satisfies PatternEntry;
			break;
		}
		case "rule": {
			if (!params.text) return errorResult("text field is required for rule type");
			if (!params.key) return errorResult("key field is required for rule type");
			id = toKebabId("rule", params.title);
			let sourceRef: RuleEntry["sourceRef"];
			if (params.source_ref) {
				try {
					sourceRef = JSON.parse(params.source_ref);
				} catch {
					/* ignore */
				}
			}
			entry = {
				id,
				title: params.title,
				key: params.key,
				text: params.text,
				category: params.category ?? "",
				priority: (params.priority as RuleEntry["priority"]) ?? "p1",
				rationale: params.rationale ?? "",
				sourceRef,
				tags,
				createdAt: now,
				status: "approved",
				lang,
				author,
			} satisfies RuleEntry;
			break;
		}
		default:
			return errorResult("sub_type must be decision, pattern, or rule");
	}

	// FR-1a: Add verification fields to entry before writing.
	const halfLife = subTypeHalfLife(subType);
	const verificationDue = computeVerificationDue(new Date(now), halfLife);
	(entry as unknown as Record<string, unknown>).verification_due = verificationDue;
	(entry as unknown as Record<string, unknown>).verification_count = 0;
	(entry as unknown as Record<string, unknown>).last_verified = null;

	// Quality gate: duplicate/contradiction/actionability checks (FR-6, FR-7, FR-8).
	const embText = buildEmbeddingText(subType, params);
	const entryContent = JSON.stringify(entry);
	const gate = await qualityGate(store, emb, embText, entryContent, subType, params);

	// Write JSON file to .alfred/knowledge/{type}/{id}.json (atomic).
	const filePath = writeKnowledgeFile(projectPath, subType, id, entry);

	// DB upsert for search index.
	const projInfo = resolveOrRegisterProject(store, projectPath);
	const row: KnowledgeRow = {
		id: 0,
		projectId: projInfo.id,
		filePath,
		contentHash: "",
		title: params.title,
		content: entryContent,
		subType,
		branch: projInfo.branch,
		author,
		createdAt: "",
		updatedAt: "",
		hitCount: 0,
		lastAccessed: "",
		enabled: true,
	};
	const { id: dbId, changed } = upsertKnowledge(store, row);

	// FR-1a: Update verification columns in DB.
	try {
		store.db
			.prepare(`UPDATE knowledge_index SET verification_due = ?, verification_count = 0, last_verified = NULL WHERE id = ?`)
			.run(verificationDue, dbId);
	} catch { /* columns may not exist yet */ }

	// Embedding: reuse vector from quality gate if available, else async fallback.
	let embeddingStatus = "none";
	if (emb && changed) {
		if (gate.embedding) {
			// Reuse the vector computed during quality gate (no second API call).
			const { insertEmbedding } = await import("../store/vectors.js");
			insertEmbedding(store, "knowledge", dbId, emb.model, gate.embedding);
			embeddingStatus = "saved";
		} else {
			// Fallback: async embedding (quality gate timed out or no API key).
			const model = emb.model;
			emb
				.embedForStorage(embText)
				.then(async (vec) => {
					const { insertEmbedding } = await import("../store/vectors.js");
					insertEmbedding(store, "knowledge", dbId, model, vec);
				})
				.catch((err) => {
					console.error(`[alfred] embedding failed for ${dbId}: ${err}`);
				});
			embeddingStatus = "pending";
		}
	}

	return jsonResult({
		status: changed ? "saved" : "unchanged (duplicate)",
		id: dbId,
		entry_id: id,
		title: params.title,
		file_path: filePath,
		embedding_status: embeddingStatus,
		lang,
		...(gate.warnings.length > 0 ? { quality_warnings: gate.warnings } : {}),
		...(gate.similarExisting.length > 0 ? { similar_existing: gate.similarExisting } : {}),
	});
}

// --- Promote ---

async function ledgerPromote(store: Store, params: LedgerParams) {
	if (!params.id) return errorResult("id is required for promote");
	if (!params.sub_type) return errorResult("sub_type is required for promote");
	if (params.sub_type !== "rule")
		return errorResult('promotion target must be "rule" (pattern→rule only)');

	const doc = getKnowledgeByID(store, params.id);
	if (!doc) return errorResult(`knowledge ${params.id} not found`);
	if (doc.subType !== "pattern") return errorResult("only patterns can be promoted to rules");

	try {
		promoteSubType(store, params.id, params.sub_type);
	} catch (err) {
		return errorResult(`promote failed: ${err}`);
	}

	return jsonResult({
		id: params.id,
		previous_sub_type: doc.subType,
		new_sub_type: params.sub_type,
		title: doc.title,
	});
}

// --- Candidates ---

async function ledgerCandidates(store: Store) {
	const candidates = getPromotionCandidates(store);
	const results = candidates.map((d) => ({
		id: d.id,
		title: d.title,
		hit_count: d.hitCount,
		current: d.subType,
		suggested: "rule",
	}));
	return jsonResult({ candidates: results, count: results.length });
}

// --- Verify (FR-4) ---

async function ledgerVerify(store: Store, params: LedgerParams) {
	if (!params.id) return errorResult("id is required for verify");

	const doc = getKnowledgeByID(store, params.id);
	if (!doc) return errorResult(`knowledge ${params.id} not found`);

	const halfLife = subTypeHalfLife(doc.subType);
	const now = new Date();
	const verificationDue = new Date(now.getTime() + halfLife * 86400000).toISOString();
	const lastVerified = now.toISOString();

	// Get current verification_count from DB.
	let currentCount = 0;
	try {
		const row = store.db
			.prepare("SELECT verification_count FROM knowledge_index WHERE id = ?")
			.get(params.id) as { verification_count: number | null } | undefined;
		currentCount = row?.verification_count ?? 0;
	} catch { /* column may not exist */ }
	const newCount = currentCount + 1;

	// JSON update (source of truth — write first).
	const projectPath = params.project_path ?? process.cwd();
	const jsonPath = join(projectPath, ".alfred", "knowledge", doc.filePath);
	try {
		const raw = readFileSync(jsonPath, "utf-8");
		const parsed = JSON.parse(raw);
		parsed.verification_due = verificationDue;
		parsed.last_verified = lastVerified;
		parsed.verification_count = newCount;
		atomicWriteSync(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
	} catch (err) {
		return errorResult(`failed to update JSON: ${err}`);
	}

	// DB update (after JSON success).
	try {
		store.db
			.prepare("UPDATE knowledge_index SET verification_due = ?, last_verified = ?, verification_count = ? WHERE id = ?")
			.run(verificationDue, lastVerified, newCount, params.id);
	} catch { /* columns may not exist */ }

	return jsonResult({
		status: "verified",
		id: params.id,
		title: doc.title,
		verification_due: verificationDue,
		verification_count: newCount,
	});
}

