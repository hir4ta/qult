import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { QULT_HOOKS } from "./init.ts";
import {
	getAvgGateDuration,
	getCommitStats,
	getGatePassRates,
	getTopErrorPatterns,
} from "./state/gate-history.ts";
import { getMetricsSummary, readMetrics } from "./state/metrics.ts";
import { readSessionState } from "./state/session-state.ts";
import type { GatesConfig } from "./types.ts";

export type CheckStatus = "ok" | "fail" | "warn";
export interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
}

function getBunVersion(): string | null {
	if (process.versions.bun) return process.versions.bun;
	try {
		const { execSync } = require("node:child_process");
		return execSync("bun --version", { encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

function checkBun(): CheckResult {
	const version = getBunVersion();
	if (!version) return { name: "bun", status: "fail", message: "Bun not detected" };
	const [major, minor] = version.split(".").map(Number);
	if (major! > 1 || (major === 1 && minor! >= 3)) {
		return { name: "bun", status: "ok", message: `Bun ${version}` };
	}
	return { name: "bun", status: "fail", message: `Bun ${version} (requires >= 1.3)` };
}

function checkHooks(): CheckResult {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) {
		return { name: "hooks", status: "fail", message: "settings.json not found" };
	}
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = settings.hooks ?? {};
		const expected = Object.keys(QULT_HOOKS);
		const registered = expected.filter((event) => {
			const entries = hooks[event];
			if (!Array.isArray(entries)) return false;
			return entries.some((e: Record<string, unknown>) => JSON.stringify(e).includes("qult hook"));
		});
		if (registered.length === expected.length) {
			return {
				name: "hooks",
				status: "ok",
				message: `${registered.length}/${expected.length} hooks registered`,
			};
		}
		const missing = expected.filter((e) => !registered.includes(e));
		return {
			name: "hooks",
			status: "fail",
			message: `${registered.length}/${expected.length} hooks registered (missing: ${missing.join(", ")})`,
		};
	} catch {
		return { name: "hooks", status: "fail", message: "Failed to parse settings.json" };
	}
}

function checkFileExists(name: string, path: string, label: string): CheckResult {
	if (existsSync(path)) {
		return { name, status: "ok", message: `${label} installed` };
	}
	return { name, status: "fail", message: `${label} not found (${path})` };
}

/** Extract the executable name from a gate command string */
function extractExecutable(command: string): string | null {
	// Strip env vars (any case) and leading whitespace, get first word
	const match = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/g, "").match(/^(\S+)/);
	return match?.[1] ?? null;
}

/** Check if an executable is reachable via PATH or node_modules/.bin */
function isExecutableReachable(exe: string): boolean {
	if (!exe || !/^[a-zA-Z0-9._-]+$/.test(exe)) return false;
	const nodeModulesBin = join(process.cwd(), "node_modules", ".bin", exe);
	if (existsSync(nodeModulesBin)) return true;
	try {
		const { execFileSync } = require("node:child_process");
		execFileSync("which", [exe], { encoding: "utf-8", stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function checkGates(): CheckResult {
	const gatesPath = join(process.cwd(), ".qult", "gates.json");
	if (!existsSync(gatesPath)) {
		return { name: "gates", status: "fail", message: "gates.json not found" };
	}
	try {
		const gates: GatesConfig = JSON.parse(readFileSync(gatesPath, "utf-8"));
		const onWriteCount = Object.keys(gates.on_write ?? {}).length;
		const onCommitCount = Object.keys(gates.on_commit ?? {}).length;
		if (onWriteCount === 0) {
			return { name: "gates", status: "fail", message: "gates.json has no on_write gates" };
		}

		// Validate gate executables are reachable
		const missing: string[] = [];
		for (const [, gateMap] of Object.entries(gates)) {
			if (!gateMap || typeof gateMap !== "object") continue;
			for (const [name, gate] of Object.entries(gateMap as Record<string, { command: string }>)) {
				const exe = extractExecutable(gate.command);
				if (exe && !isExecutableReachable(exe)) {
					missing.push(`${name}: ${exe}`);
				}
			}
		}

		if (missing.length > 0) {
			return {
				name: "gates",
				status: "warn",
				message: `gates.json: ${onWriteCount} on_write, ${onCommitCount} on_commit (missing executables: ${missing.join(", ")})`,
			};
		}
		return {
			name: "gates",
			status: "ok",
			message: `gates.json: ${onWriteCount} on_write, ${onCommitCount} on_commit`,
		};
	} catch {
		return { name: "gates", status: "fail", message: "Failed to parse gates.json" };
	}
}

const KNOWN_STATE_FILES = new Set([
	"pending-fixes.json",
	"session-state.json",
	"gate-history.json",
	"metrics.json",
]);

function checkStateDir(): CheckResult {
	const stateDir = join(process.cwd(), ".qult", ".state");
	if (!existsSync(stateDir)) {
		return {
			name: "state",
			status: "fail",
			message: ".qult/.state/ not found (run qult init)",
		};
	}

	const warnings: string[] = [];
	try {
		const files = readdirSync(stateDir);
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			// Check for unknown files
			if (!KNOWN_STATE_FILES.has(file)) {
				warnings.push(`unknown: ${file}`);
			}
			// Check JSON parsability
			try {
				JSON.parse(readFileSync(join(stateDir, file), "utf-8"));
			} catch {
				warnings.push(`corrupt: ${file}`);
			}
		}
	} catch {
		// fail-open
	}

	if (warnings.length > 0) {
		return {
			name: "state",
			status: "warn",
			message: `.qult/.state/ issues: ${warnings.join(", ")}`,
		};
	}
	return { name: "state", status: "ok", message: ".qult/.state/ exists" };
}

function checkPath(): CheckResult {
	try {
		const { execSync } = require("node:child_process");
		const path = execSync("which qult", { encoding: "utf-8" }).trim();
		return { name: "path", status: "ok", message: `qult in PATH (${path})` };
	} catch {
		return { name: "path", status: "warn", message: "qult not in PATH" };
	}
}

/** Run all health checks and return results */
export function runChecks(): CheckResult[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const claudeDir = join(home, ".claude");
	return [
		checkBun(),
		checkHooks(),
		checkFileExists(
			"skill",
			join(claudeDir, "skills", "qult-review", "SKILL.md"),
			"/qult:review skill",
		),
		checkFileExists("agent", join(claudeDir, "agents", "qult-reviewer.md"), "qult-reviewer agent"),
		checkFileExists("rules", join(claudeDir, "rules", "qult-quality.md"), "qult-quality rules"),
		checkGates(),
		checkStateDir(),
		checkPath(),
	];
}

function showMetrics(): void {
	const sessionState = readSessionState();
	const commitStats = getCommitStats();
	const summary = getMetricsSummary(
		sessionState.peak_consecutive_error_count ?? 0,
		commitStats?.count ?? 0,
	);
	const entries = readMetrics();

	const tracked = entries.filter((e) => e.session_id);
	const sessionIds = new Set(tracked.map((e) => e.session_id));
	const sessionInfo =
		sessionIds.size > 0
			? ` across ${sessionIds.size} session${sessionIds.size > 1 ? "s" : ""}`
			: "";
	console.log(`\n--- Metrics (${entries.length} actions${sessionInfo}) ---`);

	// --- Actions ---
	console.log("\n  Actions:");
	const denyDetail =
		summary.deny > 0
			? `  (${summary.denyActionable} actionable, ${summary.denyDefensive} defensive)`
			: "";
	console.log(`    DENY:            ${summary.deny}${denyDetail}`);
	console.log(`    block:           ${summary.block}`);
	console.log(`    respond:         ${summary.respond}`);
	if (summary.respondSkipped > 0) {
		console.log(`    respond-skipped: ${summary.respondSkipped}  (budget exceeded)`);
	}
	if (summary.reviewMiss > 0) {
		console.log(`    review:miss:     ${summary.reviewMiss}`);
	}

	// --- Top reasons by type ---
	const showReasons = (label: string, reasons: { reason: string; count: number }[]) => {
		if (reasons.length === 0) return;
		console.log(`\n  ${label}:`);
		for (const r of reasons) {
			console.log(`    ${r.count}x  ${r.reason}`);
		}
	};
	showReasons("Top DENY reasons (actionable)", summary.topDenyReasons);
	showReasons("Top block reasons", summary.topBlockReasons);

	// --- Gate error patterns ---
	try {
		const patterns = getTopErrorPatterns(5);
		if (patterns.length > 0) {
			console.log("\n  Top gate failures:");
			for (const p of patterns) {
				console.log(`    ${p.count}x  ${p.gate}: ${p.pattern}`);
			}
		}
	} catch {
		/* fail-open */
	}

	// --- Effectiveness ---
	const hasEffectiveness =
		summary.denyActionable > 0 || summary.gatePassRate > 0 || summary.firstPassTotal > 0;
	if (hasEffectiveness) {
		console.log("\n  Effectiveness:");
		if (summary.denyActionable > 0) {
			console.log(
				`    DENY resolution (actionable): ${summary.resolution}/${summary.denyActionable} (${summary.actionableDenyResolutionRate}%)`,
			);
		}
		if (summary.fixEffortTotal > 0) {
			console.log(`    Avg fix effort: ${summary.avgFixEffort} edits/resolution`);
		}
		if (summary.gatePassRate > 0) {
			console.log(`    Gate pass rate: ${summary.gatePassRate}%`);
		}
		if (summary.firstPassTotal > 0) {
			const recent =
				summary.firstPassRateRecent > 0 ? ` (recent: ${summary.firstPassRateRecent}%)` : "";
			console.log(`    First-pass clean: ${summary.firstPassRate}%${recent}`);
		}
		if (summary.denysPerCommit > 0) {
			console.log(`    DENYs per commit: ${summary.denysPerCommit}`);
		}
		if (summary.peakConsecutiveErrors > 0) {
			console.log(`    Peak consecutive errors: ${summary.peakConsecutiveErrors}`);
		}
	}

	// --- Gates ---
	try {
		const gateRates = getGatePassRates();
		const gateDurations = getAvgGateDuration();
		if (gateRates.length > 0) {
			console.log("\n  Gates:");
			const durationMap = new Map(gateDurations.map((d) => [d.gate, d.avgMs]));
			for (const g of gateRates) {
				const dur = durationMap.get(g.gate);
				const durStr = dur !== undefined ? `, avg ${dur}ms` : "";
				console.log(`    ${g.gate.padEnd(12)} pass ${g.passRate}%${durStr}`);
			}
		}
	} catch {
		/* fail-open */
	}

	// --- Gate-specific first-pass ---
	if (summary.gateFirstPassRates.length > 0) {
		console.log("\n  First-pass by gate:");
		for (const g of summary.gateFirstPassRates) {
			console.log(`    ${g.gate.padEnd(12)} ${g.rate}% (${g.total} failures)`);
		}
	}

	// --- Review ---
	if (summary.reviewTotal > 0) {
		console.log("\n  Review:");
		console.log(`    Pass rate: ${summary.reviewPassRate}% (${summary.reviewTotal} reviews)`);
		console.log(
			`    Findings: ${summary.reviewFindingsTotal} total (avg ${summary.reviewAvgFindings}/review)`,
		);
		if (summary.reviewFindingsTotal > 0) {
			const s = summary.reviewFindingsBySeverity;
			console.log(
				`    Severity: ${s.critical} crit, ${s.high} high, ${s.medium} med, ${s.low} low`,
			);
		}
		if (summary.reviewMiss > 0) {
			console.log(`    Misses: ${summary.reviewMiss}`);
		}
	}

	// --- Commits ---
	if (commitStats) {
		console.log("\n  Commits:");
		console.log(
			`    ${commitStats.count} commits, avg ${commitStats.avgMinutes}m, med ${commitStats.medianMinutes}m, range ${commitStats.minMinutes}-${commitStats.maxMinutes}m`,
		);
	}

	// --- Plans ---
	const permTotal = summary.permissionAllow + summary.permissionDeny;
	if (permTotal > 0) {
		console.log("\n  Plans:");
		console.log(
			`    Approved: ${summary.permissionAllow}, Rejected: ${summary.permissionDeny} (${summary.planSuccessRate}% pass)`,
		);
	}
}

const STATE_DEFAULTS: Record<string, string> = {
	"pending-fixes.json": "[]",
	"session-state.json": "{}",
	"gate-history.json": '{"gates":[],"commits":[]}',
	"metrics.json": "[]",
};

/** Scan .qult/.state/ for corrupt JSON and replace with defaults. */
export function repairState(): string[] {
	const stateDir = join(process.cwd(), ".qult", ".state");
	if (!existsSync(stateDir)) return [];

	const repaired: string[] = [];
	try {
		const files = readdirSync(stateDir);
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const filePath = join(stateDir, file);
			try {
				JSON.parse(readFileSync(filePath, "utf-8"));
			} catch {
				if (!(file in STATE_DEFAULTS)) continue; // skip unknown files
				writeFileSync(filePath, STATE_DEFAULTS[file]!);
				repaired.push(file);
			}
		}
	} catch {
		// fail-open
	}
	return repaired;
}

export const doctorCommand = defineCommand({
	meta: { description: "Check qult health" },
	args: {
		metrics: { type: "boolean", description: "Show action metrics", default: false },
		fix: { type: "boolean", description: "Repair corrupted state files", default: false },
	},
	async run({ args }) {
		const results = runChecks();
		for (const r of results) {
			const tag = r.status === "ok" ? "[OK]" : r.status === "fail" ? "[FAIL]" : "[WARN]";
			console.log(`${tag} ${r.message}`);
		}

		if (args.metrics) {
			showMetrics();
		}

		if (args.fix) {
			const repaired = repairState();
			if (repaired.length > 0) {
				console.log(`\nRepaired ${repaired.length} state file(s): ${repaired.join(", ")}`);
			} else {
				console.log("\nNo state files needed repair.");
			}
		}

		const hasFail = results.some((r) => r.status === "fail");
		if (hasFail) process.exit(1);
	},
});
