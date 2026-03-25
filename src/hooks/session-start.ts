import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { readStateJSON, writeStateJSON } from "./state.js";
import { detectProjectProfile, type ProjectProfile } from "../profile/detect.js";
import { detectGates } from "../gates/index.js";

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

	// 3. Conventions injection
	const conventions = readConventions(ev.cwd);
	if (conventions.length > 0) {
		items.push({
			level: "CONTEXT",
			message: `Conventions: ${conventions.join(" | ")}`,
		});
	}

	// 4. Auto-generate gates.json if missing
	ensureGates(ev.cwd);

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

// ── Gates auto-generation ───────────────────────────────────────────

function ensureGates(cwd: string): void {
	const gatesPath = join(cwd, ".alfred", "gates.json");
	if (existsSync(gatesPath)) return;

	// Only auto-generate if .alfred/ dir exists
	const alfredDir = join(cwd, ".alfred");
	if (!existsSync(alfredDir)) return;

	try {
		const gates = detectGates(cwd);
		const { writeFileSync, mkdirSync } = require("node:fs");
		mkdirSync(alfredDir, { recursive: true });
		writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
	} catch {
		/* best effort */
	}
}
