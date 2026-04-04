import { extname, resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { runGate, runGateAsync } from "../gates/runner.ts";
import {
	addPendingFixes,
	clearPendingFixesForFile,
	readPendingFixes,
	writePendingFixes,
} from "../state/pending-fixes.ts";
import {
	clearOnCommit,
	getGatedExtensions,
	incrementGateFailure,
	isGateDisabled,
	markGateRan,
	recordChangedFile,
	recordTestPass,
	resetGateFailure,
	shouldSkipGate,
} from "../state/session-state.ts";
import type { HookEvent, PendingFix } from "../types.ts";
import { detectExportBreakingChanges } from "./detectors/export-check.ts";
import { detectHallucinatedImports } from "./detectors/import-check.ts";

/** PostToolUse: lint/type gate after Edit/Write, commit/test/lint-fix detection after Bash */
export default async function postTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;
	if (!tool) return;

	if (tool === "Edit" || tool === "Write") {
		await handleEditWrite(ev);
	} else if (tool === "Bash") {
		handleBash(ev);
	}
}

// ── Edit/Write: run on_write gates ──────────────────────────

async function handleEditWrite(ev: HookEvent): Promise<void> {
	const rawFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
	if (!rawFile) return;
	const file = resolve(rawFile);

	// Skip qult's own state/config files
	const qultDir = resolve(process.cwd(), ".qult");
	if (file.startsWith(`${qultDir}/`) || file === qultDir) return;

	const gates = loadGates();
	if (!gates?.on_write) return;

	// File extension filter: skip per-file gates for extensions not covered by any gate tool
	const fileExt = extname(file).toLowerCase();
	const gatedExts = getGatedExtensions();
	const sessionId = ev.session_id;

	// Filter gates, then run in parallel
	const gateEntries: {
		name: string;
		gate: (typeof gates.on_write)[string];
		fileArg: string | undefined;
	}[] = [];
	for (const [name, gate] of Object.entries(gates.on_write)) {
		if (isGateDisabled(name)) continue;
		if (gate.run_once_per_batch && sessionId && shouldSkipGate(name, sessionId)) continue;
		const hasPlaceholder = gate.command.includes("{file}");
		if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt)) continue;
		gateEntries.push({ name, gate, fileArg: hasPlaceholder ? file : undefined });
	}

	const results = await Promise.allSettled(
		gateEntries.map((entry) => runGateAsync(entry.name, entry.gate, entry.fileArg)),
	);

	const newFixes: PendingFix[] = [];
	for (let i = 0; i < results.length; i++) {
		const settled = results[i]!;
		const entry = gateEntries[i]!;
		try {
			if (settled.status === "fulfilled") {
				if (entry.gate.run_once_per_batch && sessionId) {
					markGateRan(entry.name, sessionId);
				}
				if (!settled.value.passed) {
					newFixes.push({ file, errors: [settled.value.output], gate: entry.name });
					// 3-Strike escalation: track repeated failures
					try {
						const count = incrementGateFailure(file, entry.name);
						if (count >= 3) {
							process.stderr.write(
								`[qult] 3-Strike: ${file} failed ${entry.name} ${count} times. Investigate root cause before continuing.\n`,
							);
						}
					} catch {
						/* fail-open */
					}
				} else {
					try {
						resetGateFailure(file, entry.name);
					} catch {
						/* fail-open */
					}
				}
			}
		} catch {
			// fail-open
		}
	}

	// Hallucinated import detection — accumulate into same newFixes array to avoid per-file replacement conflict
	try {
		const importFixes = detectHallucinatedImports(file);
		newFixes.push(...importFixes);
	} catch {
		/* fail-open */
	}

	// Export breaking change detection (L4)
	try {
		const exportFixes = detectExportBreakingChanges(file);
		newFixes.push(...exportFixes);
	} catch {
		/* fail-open */
	}

	if (newFixes.length > 0) {
		addPendingFixes(file, newFixes);
	} else {
		clearPendingFixesForFile(file);
	}

	// Gate execution summary to stderr (instruction drift defense)
	try {
		if (gateEntries.length > 0 || newFixes.some((f) => f.gate === "import-check")) {
			const gateParts = gateEntries.map((entry, i) => {
				const settled = results[i]!;
				if (settled.status === "fulfilled") {
					return `${entry.name} ${settled.value.passed ? "PASS" : "FAIL"}`;
				}
				return `${entry.name} ERROR`;
			});
			const importFixCount = newFixes.filter((f) => f.gate === "import-check").length;
			if (importFixCount > 0) gateParts.push("import-check FAIL");
			const exportFixCount = newFixes.filter((f) => f.gate === "export-check").length;
			if (exportFixCount > 0) gateParts.push("export-check FAIL");
			const totalFixes = readPendingFixes().length;
			const fixSuffix = totalFixes > 0 ? ` | ${totalFixes} pending fix(es)` : "";
			process.stderr.write(`[qult] gates: ${gateParts.join(", ")}${fixSuffix}\n`);
		}
	} catch {
		/* fail-open */
	}

	try {
		recordChangedFile(file);
	} catch {
		/* fail-open */
	}
}

// ── Bash: three independent detectors ───────────────────────

const GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;

const LINT_FIX_RE =
	/\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/;

/** Fallback regex for test command detection when no on_commit gates configured */
const TEST_CMD_RE = /\b(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;

function handleBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;

	if (GIT_COMMIT_RE.test(command)) {
		onGitCommit();
		return;
	}

	if (LINT_FIX_RE.test(command)) {
		onLintFix();
	}

	if (isTestCommand(command)) {
		onTestCommand(ev, command);
	}
}

/** git commit detected: reset per-commit state, run on_commit gates */
function onGitCommit(): void {
	clearOnCommit();

	const gates = loadGates();
	if (!gates?.on_commit) return;

	for (const [name, gate] of Object.entries(gates.on_commit)) {
		try {
			if (isGateDisabled(name)) continue;
			runGate(name, gate);
		} catch {
			// fail-open
		}
	}
}

/** Lint-fix command detected: re-validate files with pending fixes */
function onLintFix(): void {
	try {
		const fixes = readPendingFixes();
		if (fixes.length === 0) return;

		const gates = loadGates();
		if (!gates?.on_write) return;

		const remaining = fixes.filter((fix) => {
			for (const [name, gate] of Object.entries(gates.on_write!)) {
				if (isGateDisabled(name)) continue;
				const hasPlaceholder = gate.command.includes("{file}");
				if (!hasPlaceholder) continue;
				try {
					const result = runGate(name, gate, fix.file);
					if (!result.passed) return true;
				} catch {
					return true; // fail-open: keep the fix
				}
			}
			return false;
		});

		writePendingFixes(remaining);
	} catch {
		// fail-open
	}
}

/** Check if a bash command matches an on_commit gate command or test regex fallback */
function isTestCommand(command: string): boolean {
	const gates = loadGates();
	if (gates?.on_commit) {
		for (const gate of Object.values(gates.on_commit)) {
			if (command.includes(gate.command)) return true;
		}
		return false;
	}
	return TEST_CMD_RE.test(command);
}

/** Test command detected: record pass only if exit code 0 is explicitly present.
 *  Requires positive evidence of success — absence of exit code does NOT count as pass. */
function onTestCommand(ev: HookEvent, command: string): void {
	const output = getToolOutput(ev);
	const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i);
	const isPass = exitCodeMatch ? Number(exitCodeMatch[1]) === 0 : false;

	if (isPass) {
		recordTestPass(command);
	}
}

/** Extract tool output as string from tool_response (official) or tool_output (legacy) */
function getToolOutput(ev: HookEvent): string {
	if (ev.tool_response != null && typeof ev.tool_response === "object") {
		const resp = ev.tool_response as Record<string, unknown>;
		const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
		const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
		return (stdout + stderr).trim();
	}
	if (typeof ev.tool_output === "string") return ev.tool_output;
	return "";
}
