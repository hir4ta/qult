import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { readStateJSON, writeStateJSON } from "./state.js";
import { detectProjectProfile, type ProjectProfile } from "../profile/detect.js";
import { detectGates } from "../gates/index.js";
import { openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { insertQualityEvent } from "../store/quality-events.js";
import { upsertKnowledge } from "../store/knowledge.js";

/**
 * SessionStart handler: initial context injection.
 *
 * Flow:
 * 1. Project profiling (first run: auto-detect language, test fw, linter)
 * 2. Previous session quality summary injection
 * 3. Conventions injection (top 5)
 */
export async function sessionStart(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// Zero-config: auto-create .alfred/ on first session
	ensureAlfredDir(ev.cwd);

	const items: DirectiveItem[] = [];

	// 1. Project profiling
	const profile = ensureProfile(ev.cwd);
	if (profile) {
		items.push({
			level: "CONTEXT",
			message: formatProfile(profile),
		});
	}

	// 2. Previous session quality summary
	const summary = readSessionSummary(ev.cwd);
	if (summary) {
		items.push({
			level: "CONTEXT",
			message: `Previous session quality: ${summary}`,
		});
	}

	// 3. Conventions injection + event tracking
	const conventions = readConventions(ev.cwd);
	if (conventions.length > 0) {
		items.push({
			level: "CONTEXT",
			message: `Conventions: ${conventions.join(" | ")}`,
		});
		recordConventionEvent(ev.cwd, "convention_pass", conventions.length);
	}

	// 4. Auto-generate gates.json if missing
	ensureGates(ev.cwd);

	// 5. Knowledge sync (.alfred/knowledge/ → DB)
	syncKnowledgeFiles(ev.cwd);

	emitDirectives("SessionStart", items);
}

// ── Profile ─────────────────────────────────────────────────────────

const PROFILE_FILE = "project-profile.json";

function ensureProfile(cwd: string): ProjectProfile | null {
	// Try reading cached profile
	const cached = readStateJSON<ProjectProfile | null>(cwd, PROFILE_FILE, null);

	if (cached && cached.detectedAt) {
		// Re-detect if older than 24 hours
		const age = Date.now() - new Date(cached.detectedAt).getTime();
		if (age < 24 * 60 * 60 * 1000) return cached;
	}

	// Detect and cache
	try {
		const profile = detectProjectProfile(cwd);
		writeStateJSON(cwd, PROFILE_FILE, profile);
		return profile;
	} catch {
		return cached;
	}
}

function formatProfile(p: ProjectProfile): string {
	const parts: string[] = [];
	if (p.languages.length > 0) parts.push(`Project: ${p.languages.join(", ")}`);
	if (p.runtime !== "unknown") parts.push(`runtime: ${p.runtime}`);
	if (p.testFramework !== "unknown") parts.push(`test: ${p.testFramework}`);
	if (p.linter !== "unknown") parts.push(`lint: ${p.linter}`);
	if (p.buildSystem !== "unknown") parts.push(`build: ${p.buildSystem}`);
	return parts.join(", ");
}

// ── Session summary ─────────────────────────────────────────────────

interface SessionSummary {
	gate_pass: number;
	gate_fail: number;
	error_hit: number;
	error_miss: number;
	score?: number;
}

function readSessionSummary(cwd: string): string | null {
	const summary = readStateJSON<SessionSummary | null>(cwd, "session-summary.json", null);
	if (!summary) return null;

	const gateTotal = (summary.gate_pass ?? 0) + (summary.gate_fail ?? 0);
	if (gateTotal === 0 && (summary.error_hit ?? 0) === 0) return null;

	const parts: string[] = [];
	if (gateTotal > 0) {
		const rate = Math.round(((summary.gate_pass ?? 0) / gateTotal) * 100);
		parts.push(`gate pass rate ${rate}% (${summary.gate_pass}/${gateTotal})`);
	}
	if ((summary.error_hit ?? 0) + (summary.error_miss ?? 0) > 0) {
		parts.push(`${summary.error_hit} error resolutions used`);
	}
	if (summary.score != null) {
		parts.push(`score: ${summary.score}/100`);
	}

	return parts.join(", ");
}

// ── Conventions ─────────────────────────────────────────────────────

interface Convention {
	pattern: string;
	category?: string;
}

function readConventions(cwd: string): string[] {
	const conventionsPath = join(cwd, ".alfred", "conventions.json");
	if (!existsSync(conventionsPath)) return [];

	try {
		const data = JSON.parse(readFileSync(conventionsPath, "utf-8")) as Convention[];
		if (!Array.isArray(data)) return [];
		return data
			.slice(0, 5)
			.map((c, i) => `(${i + 1}) ${c.pattern}`);
	} catch {
		return [];
	}
}

// ── Zero-config: auto-create .alfred/ ────────────────────────────────

function ensureAlfredDir(cwd: string): void {
	const alfredDir = join(cwd, ".alfred");
	if (existsSync(alfredDir)) return;

	try {
		mkdirSync(join(alfredDir, ".state"), { recursive: true });
		for (const dir of ["error_resolutions", "exemplars", "conventions"]) {
			mkdirSync(join(alfredDir, "knowledge", dir), { recursive: true });
		}
		// Auto-detect and write gates.json
		const gates = detectGates(cwd);
		writeFileSync(join(alfredDir, "gates.json"), JSON.stringify(gates, null, 2));
	} catch {
		/* best effort */
	}
}

// ── Gates auto-generation ───────────────────────────────────────────

function ensureGates(cwd: string): void {
	const gatesPath = join(cwd, ".alfred", "gates.json");
	if (existsSync(gatesPath)) return;

	const alfredDir = join(cwd, ".alfred");
	if (!existsSync(alfredDir)) return;

	try {
		const gates = detectGates(cwd);
		writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
	} catch {
		/* best effort */
	}
}

// ── Convention event tracking ───────────────────────────────────────

function recordConventionEvent(cwd: string, type: "convention_pass" | "convention_warn", count: number): void {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		const sessionId = findLatestSessionId(store) ?? `session-${Date.now()}`;
		insertQualityEvent(store, project.id, sessionId, type, { count });
	} catch { /* fail-open */ }
}

function findLatestSessionId(store: import("../store/index.js").Store): string | null {
	try {
		const row = store.db
			.prepare("SELECT DISTINCT session_id FROM quality_events ORDER BY created_at DESC LIMIT 1")
			.get() as { session_id: string } | undefined;
		return row?.session_id ?? null;
	} catch {
		return null;
	}
}

// ── Knowledge sync (.alfred/knowledge/ → DB) ────────────────────────

function syncKnowledgeFiles(cwd: string): void {
	try {
		const knowledgeDir = join(cwd, ".alfred", "knowledge");
		if (!existsSync(knowledgeDir)) return;

		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);

		for (const typeDir of ["error_resolutions", "exemplars", "conventions"]) {
			const dir = join(knowledgeDir, typeDir);
			if (!existsSync(dir)) continue;

			const type = typeDir === "error_resolutions" ? "error_resolution"
				: typeDir === "exemplars" ? "exemplar" : "convention";

			for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
				try {
					const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
					if (data.title && data.content) {
						upsertKnowledge(store, {
							projectId: project.id,
							type: type as "error_resolution" | "exemplar" | "convention",
							title: data.title,
							content: typeof data.content === "string" ? data.content : JSON.stringify(data.content),
							tags: data.tags ?? "",
							author: data.author ?? "",
						});
					}
				} catch { /* skip invalid files */ }
			}
		}
	} catch { /* fail-open */ }
}
