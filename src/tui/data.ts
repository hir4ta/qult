/**
 * Data layer for TUI — reads quality events from DB + state files.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store, openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { getRecentEvents, getSessionSummary, calculateQualityScore, getGateBreakdown } from "../store/quality-events.js";
import { countKnowledge } from "../store/knowledge.js";
import { readPendingFixes, hasPendingFixes, type PendingFixes } from "../hooks/pending-fixes.js";
import { readStateJSON } from "../hooks/state.js";
import type { QualityScore } from "../types.js";
import { getKnowledgeInjectionCount } from "../hooks/user-prompt.js";

export interface QualityDashboardData {
	// Score
	score: QualityScore;
	previousScore: number | null;

	// Gates (3 categories)
	gates: {
		onWrite: { pass: number; fail: number };
		onCommit: { pass: number; fail: number };
		test: { pass: number; fail: number };
	};

	// Knowledge usage
	knowledge: {
		errorHits: number;
		errorMisses: number;
		knowledgeInjections: number;
		assertionWarnings: number;
		conventionPass: number;
		conventionWarn: number;
	};

	// Knowledge DB totals
	knowledgeTotals: {
		errorResolutions: number;
		fixPatterns: number;
		conventions: number;
	};

	// Recent events stream
	recentEvents: Array<{
		timestamp: string;
		type: string;
		detail: string;
	}>;

	// Session info
	session: {
		lastActivity: string; // HH:MM or ""
		eventsToday: number;
		changedFiles: number;
		commits: number;
	};

	// Pending fixes
	pendingFixesCount: number;

	// Directive injection count
	directiveCount: number;

	// Project
	projectName: string;
}

// no session start time — not meaningful across day boundaries

export function loadDashboardData(cwd: string): QualityDashboardData {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		const sessionId = findLatestSessionId(store) ?? `session-${Date.now()}`;

		const summary = getSessionSummary(store, sessionId);
		const score = calculateQualityScore(store, sessionId);
		const gates = getGateBreakdown(store, sessionId);
		const events = getRecentEvents(store, sessionId, 20);

		// Previous session score
		const prevSummary = readStateJSON<{ score?: number } | null>(cwd, "session-summary.json", null);
		const previousScore = prevSummary?.score ?? null;

		// Knowledge DB totals
		const knowledgeTotals = {
			errorResolutions: countKnowledgeByType(store, project.id, "error_resolution"),
			fixPatterns: countKnowledgeByType(store, project.id, "fix_pattern"),
			conventions: countKnowledgeByType(store, project.id, "convention"),
		};

		// Last activity + events today
		const lastActivity = getLastActivityTime(store);
		const eventsToday = getEventCountToday(store);

		// Git stats
		const gitStats = getGitStats(cwd);

		// Pending fixes
		const pendingFixesCount = countPendingFixes(cwd);

		// Count directives (gate_fail events serve as proxy for directive injections)
		const directiveCount = (summary.gate_fail ?? 0) + (summary.test_fail ?? 0);

		return {
			score,
			previousScore,
			gates: {
				onWrite: { pass: gates.onWrite.pass, fail: gates.onWrite.fail },
				onCommit: { pass: gates.onCommit.pass, fail: gates.onCommit.fail },
				test: { pass: summary.test_pass ?? 0, fail: summary.test_fail ?? 0 },
			},
			knowledge: {
				errorHits: summary.error_hit ?? 0,
				errorMisses: summary.error_miss ?? 0,
				knowledgeInjections: getKnowledgeInjectionCount(cwd),
				assertionWarnings: summary.assertion_warning ?? 0,
				conventionPass: summary.convention_pass ?? 0,
				conventionWarn: summary.convention_warn ?? 0,
			},
			knowledgeTotals,
			recentEvents: events.map((e) => {
				let detail = "";
				try {
					const d = JSON.parse(e.data);
					detail = d.gate ?? d.query?.slice(0, 60) ?? d.command?.slice(0, 60) ?? "";
				} catch { /* ignore */ }
				return {
					timestamp: e.createdAt?.slice(11, 16) ?? "",
					type: e.eventType,
					detail,
				};
			}),
			session: {
				lastActivity,
				eventsToday,
				changedFiles: gitStats.changedFiles,
				commits: gitStats.commits,
			},
			pendingFixesCount,
			directiveCount,
			projectName: project.name,
		};
	} catch {
		return emptyData();
	}
}

function emptyData(): QualityDashboardData {
	return {
		score: {
			sessionScore: 0,
			breakdown: {
				gatePassRateWrite: { score: 0, pass: 0, total: 0 },
				gatePassRateCommit: { score: 0, pass: 0, total: 0 },
				errorResolutionHit: { score: 0, hit: 0, total: 0 },
				conventionAdherence: { score: 0, pass: 0, total: 0 },
			},
			trend: "stable",
		},
		previousScore: null,
		gates: { onWrite: { pass: 0, fail: 0 }, onCommit: { pass: 0, fail: 0 }, test: { pass: 0, fail: 0 } },
		knowledge: { errorHits: 0, errorMisses: 0, knowledgeInjections: 0, assertionWarnings: 0, conventionPass: 0, conventionWarn: 0 },
		knowledgeTotals: { errorResolutions: 0, fixPatterns: 0, conventions: 0 },
		recentEvents: [],
		session: { lastActivity: "", eventsToday: 0, changedFiles: 0, commits: 0 },
		pendingFixesCount: 0,
		directiveCount: 0,
		projectName: "unknown",
	};
}

function findLatestSessionId(store: Store): string | null {
	try {
		const row = store.db
			.prepare("SELECT DISTINCT session_id FROM quality_events ORDER BY created_at DESC LIMIT 1")
			.get() as { session_id: string } | undefined;
		return row?.session_id ?? null;
	} catch {
		return null;
	}
}

function getLastActivityTime(store: Store): string {
	try {
		const row = store.db
			.prepare("SELECT created_at FROM quality_events ORDER BY created_at DESC LIMIT 1")
			.get() as { created_at: string } | undefined;
		return row?.created_at?.slice(11, 16) ?? "";
	} catch {
		return "";
	}
}

function getEventCountToday(store: Store): number {
	try {
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		const row = store.db
			.prepare("SELECT COUNT(*) as cnt FROM quality_events WHERE created_at >= ?")
			.get(today) as { cnt: number };
		return row.cnt;
	} catch {
		return 0;
	}
}

function countKnowledgeByType(store: Store, projectId: string, type: string): number {
	try {
		const row = store.db
			.prepare("SELECT COUNT(*) as cnt FROM knowledge_index WHERE project_id = ? AND type = ? AND enabled = 1")
			.get(projectId, type) as { cnt: number };
		return row.cnt;
	} catch {
		return 0;
	}
}

function getGitStats(cwd: string): { changedFiles: number; commits: number } {
	try {
		const diffOutput = execFileSync("git", ["diff", "--name-only"], {
			cwd, timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
		});
		const changedFiles = diffOutput.trim().split("\n").filter(Boolean).length;

		// Count commits today
		const logOutput = execFileSync("git", ["log", "--oneline", "--since=midnight"], {
			cwd, timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
		});
		const commits = logOutput.trim().split("\n").filter(Boolean).length;

		return { changedFiles, commits };
	} catch {
		return { changedFiles: 0, commits: 0 };
	}
}

function countPendingFixes(cwd: string): number {
	if (!hasPendingFixes(cwd)) return 0;
	const fixes = readPendingFixes(cwd);
	let count = 0;
	for (const file of Object.values(fixes.files)) {
		count += (file.lint?.length ?? 0) + (file.type?.length ?? 0);
	}
	return count;
}
