import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { loadGates } from "../gates/load.ts";
import { runCoverageGate, runGate, runGateAsync, shellEscape } from "../gates/runner.ts";
import {
	addPendingFixes,
	clearPendingFixesForFile,
	readPendingFixes,
	writePendingFixes,
} from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import {
	clearOnCommit,
	getGatedExtensions,
	incrementEscalation,
	incrementFileEditCount,
	incrementGateFailure,
	isGateDisabled,
	markGateRan,
	readSessionState,
	recordChangedFile,
	recordTestPass,
	resetGateFailure,
	shouldSkipGate,
} from "../state/session-state.ts";
import type { GateDefinition, HookEvent, PendingFix } from "../types.ts";
import { detectConventionDrift } from "./detectors/convention-check.ts";
import { detectDeadImports } from "./detectors/dead-import-check.ts";
import { classifiedToPendingFixes } from "./detectors/diagnostic-classifier.ts";
import { detectCrossFileDuplication, detectDuplication } from "./detectors/duplication-check.ts";
import { detectExportBreakingChanges } from "./detectors/export-check.ts";
import { detectHallucinatedImports } from "./detectors/import-check.ts";
import { findImporters } from "./detectors/import-graph.ts";
import { detectSecurityPatterns, getAdvisoryAsPendingFixes } from "./detectors/security-check.ts";
import { detectSemanticPatterns } from "./detectors/semantic-check.ts";
import { resolveTestFile } from "./detectors/test-file-resolver.ts";
import {
	analyzeTestQuality,
	getBlockingTestSmells,
	suggestPbt,
} from "./detectors/test-quality-check.ts";
import { deny } from "./respond.ts";

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

	// Defense-in-depth: if PreToolUse DENY was ignored (Claude Code #21988),
	// re-check pending-fixes here and DENY again before running new gates.
	try {
		const existingFixes = readPendingFixes();
		if (existingFixes.length > 0 && !existingFixes.some((f) => resolve(f.file) === file)) {
			deny(
				`Fix existing errors before editing other files (PostToolUse fallback):\n${existingFixes.map((f) => `  ${f.file}`).join("\n")}`,
			);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
		/* fail-open */
	}

	const config = loadConfig();
	const gates = loadGates();
	const hasWriteGates = !!gates?.on_write;

	// File extension filter: skip per-file gates for extensions not covered by any gate tool
	const fileExt = extname(file).toLowerCase();
	const gatedExts = getGatedExtensions();
	// Filter gates, then run in parallel
	const gateEntries: {
		name: string;
		gate: GateDefinition;
		fileArg: string | undefined;
	}[] = [];
	if (hasWriteGates && gates?.on_write) {
		for (const [name, gate] of Object.entries(gates.on_write)) {
			if (isGateDisabled(name)) continue;
			if (gate.run_once_per_batch && shouldSkipGate(name, file)) continue;
			const hasPlaceholder = gate.command.includes("{file}");
			if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt)) continue;
			gateEntries.push({ name, gate, fileArg: hasPlaceholder ? file : undefined });
		}
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
				if (entry.gate.run_once_per_batch) {
					markGateRan(entry.name);
				}
				if (!settled.value.passed) {
					// Use classified diagnostics if available (typecheck gates), otherwise fallback
					const classified = settled.value.classifiedDiagnostics;
					if (classified?.length) {
						newFixes.push(...classifiedToPendingFixes(classified));
					} else {
						newFixes.push({ file, errors: [settled.value.output], gate: entry.name });
					}
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

	// Build a set of existing file:gate pairs to avoid re-counting escalation on re-edits
	const existingFixKeys = new Set(readPendingFixes().map((f) => `${resolve(f.file)}:${f.gate}`));
	const fileName = file.split("/").pop() ?? "";
	const isTestFile =
		fileName.includes(".test.") ||
		fileName.includes(".spec.") ||
		fileName.startsWith("test_") ||
		fileName.includes("_test.");

	// Security pattern detection (computational on_write sensor — no external tools needed)
	try {
		const securityFixes = detectSecurityPatterns(file);
		if (securityFixes.length > 0) {
			newFixes.push(...securityFixes);
			// Only count first occurrence per file (avoid re-edit inflation)
			if (!isTestFile && !existingFixKeys.has(`${file}:security-check`)) {
				const count = incrementEscalation("security_warning_count");
				if (count >= 10) {
					process.stderr.write(
						`[qult] Security escalation: ${count} security warnings this session. Review security posture.\n`,
					);
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// Semantic pattern detection (silent failures: empty catch, ignored return, assignment in condition)
	try {
		const semanticFixes = detectSemanticPatterns(file);
		if (semanticFixes.length > 0) {
			newFixes.push(...semanticFixes);
			if (!isTestFile && !existingFixKeys.has(`${file}:semantic-check`)) {
				const count = incrementEscalation("semantic_warning_count");
				if (count >= 8) {
					process.stderr.write(
						`[qult] Semantic escalation: ${count} semantic warnings this session. Review code for silent failures.\n`,
					);
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// Dead import detection (advisory → blocking after escalation threshold)
	try {
		const deadImportWarnings = detectDeadImports(file);
		if (deadImportWarnings.length > 0) {
			let diCount = readSessionState().dead_import_warning_count ?? 0;
			if (!existingFixKeys.has(`${file}:dead-import-check`)) {
				diCount = incrementEscalation("dead_import_warning_count");
			}
			if (diCount >= config.escalation.dead_import_blocking_threshold) {
				newFixes.push({
					file,
					gate: "dead-import-check",
					errors: deadImportWarnings,
				});
				process.stderr.write(
					`[qult] Dead import escalation: ${diCount} warnings exceeded threshold — promoting to blocking\n`,
				);
			} else {
				for (const w of deadImportWarnings) {
					process.stderr.write(`[qult] Dead import: ${w}\n`);
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// Convention drift detection (advisory): warn on naming mismatch for new files
	try {
		const state = readSessionState();
		if (!state.changed_file_paths.includes(file)) {
			const warnings = detectConventionDrift(file);
			for (const w of warnings) {
				process.stderr.write(`[qult] Convention: ${w}\n`);
				incrementEscalation("drift_warning_count");
			}
		}
	} catch {
		/* fail-open */
	}

	// Duplication detection (intra-file: blocking, cross-file: advisory)
	try {
		const dupFixes = detectDuplication(file);
		if (dupFixes.length > 0) {
			newFixes.push(...dupFixes);
			if (!existingFixKeys.has(`${file}:duplication-check`)) {
				incrementEscalation("duplication_warning_count");
			}
		}
		const sessionFiles = readSessionState().changed_file_paths ?? [];
		const crossDupWarnings = detectCrossFileDuplication(file, sessionFiles);
		if (crossDupWarnings.length > 0) {
			if (!existingFixKeys.has(`${file}:duplication-check`)) {
				incrementEscalation("duplication_warning_count");
			}
			for (const w of crossDupWarnings) {
				process.stderr.write(`[qult] Duplication: ${w}\n`);
			}
		}
	} catch {
		/* fail-open */
	}

	// Test quality blocking: reject empty tests, always-true, trivial assertions
	try {
		if (isTestFile && !isGateDisabled("test-quality-check")) {
			const tqResult = analyzeTestQuality(file);
			if (tqResult) {
				const blockingFixes = getBlockingTestSmells(file, tqResult);
				if (blockingFixes.length > 0) {
					newFixes.push(...blockingFixes);
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// PBT suggestion: advise PBT for validation/serialization files
	try {
		if (!isTestFile) {
			const pbtSuggestion = suggestPbt(file);
			if (pbtSuggestion) {
				process.stderr.write(`[qult] PBT advisory: ${pbtSuggestion}\n`);
			}
		}
	} catch {
		/* fail-open */
	}

	// Test-on-edit: run related test file when enabled and no lint/type errors
	try {
		if (config.gates.test_on_edit && newFixes.length === 0) {
			const testFile = resolveTestFile(file);
			if (testFile && gates?.on_commit?.test) {
				const testGate = gates.on_commit.test;
				// Build per-file test command from the test runner
				const testCommand = buildTestFileCommand(testGate.command, testFile);
				if (testCommand) {
					const testResult = await runGateAsync("test-on-edit", {
						command: testCommand,
						timeout: config.gates.test_on_edit_timeout,
					});
					if (!testResult.passed) {
						newFixes.push({ file, errors: [testResult.output], gate: "test-on-edit" });
						process.stderr.write(`[qult] test-on-edit: ${testFile} FAIL\n`);
					} else {
						process.stderr.write(`[qult] test-on-edit: ${testFile} PASS\n`);
					}
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// Iterative security escalation: promote advisory → blocking after N edits
	try {
		if (!isGateDisabled("security-check-advisory")) {
			const editCount = incrementFileEditCount(file);
			const projectRoot = resolve(process.cwd());
			if (
				editCount >= config.escalation.security_iterative_threshold &&
				file.startsWith(`${projectRoot}/`)
			) {
				const fileContent = readFileSync(file, "utf-8");
				const advisoryFixes = getAdvisoryAsPendingFixes(file, fileContent);
				if (advisoryFixes.length > 0) {
					newFixes.push(...advisoryFixes);
					const relative = file.split("/").slice(-3).join("/");
					process.stderr.write(
						`[qult] Iterative security escalation: ${relative} edited ${editCount} times — advisory patterns promoted to blocking\n`,
					);
				}
			}
		}
	} catch {
		/* fail-open */
	}

	// Consumer typecheck: re-run typecheck on files that import the changed file
	try {
		const config = loadConfig();
		if (config.gates.consumer_typecheck) {
			const gates = loadGates();
			const typecheckGate = gates?.on_write?.typecheck;
			if (typecheckGate?.run_once_per_batch) {
				// typecheck is whole-project, already covers consumers
			} else if (typecheckGate) {
				const importers = findImporters(file, process.cwd(), config.gates.import_graph_depth);
				const consumerResults = await Promise.allSettled(
					importers.map((imp) => runGateAsync("typecheck", typecheckGate, imp)),
				);
				for (let ci = 0; ci < consumerResults.length; ci++) {
					const cr = consumerResults[ci]!;
					if (cr.status === "fulfilled" && !cr.value.passed) {
						const classified = cr.value.classifiedDiagnostics;
						if (classified?.length) {
							newFixes.push(...classifiedToPendingFixes(classified));
						} else {
							newFixes.push({ file: importers[ci]!, errors: [cr.value.output], gate: "typecheck" });
						}
					}
				}
			}
		}
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
			const securityFixCount = newFixes.filter((f) => f.gate === "security-check").length;
			if (securityFixCount > 0) gateParts.push("security-check FAIL");
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

	// Over-engineering detection: warn when too many unplanned files changed
	try {
		checkOverEngineering();
	} catch {
		/* fail-open */
	}

	// Plan-required detection: warn when many files changed without a plan
	try {
		checkPlanRequired();
	} catch {
		/* fail-open */
	}
}

/** Advisory: warn when too many files are changed outside the plan scope. */
function checkOverEngineering(): void {
	const plan = getActivePlan();
	if (!plan) return;

	const state = readSessionState();
	const changed = state.changed_file_paths ?? [];
	const totalChanged = changed.length;

	const cwd = process.cwd();
	const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve(cwd, t.file!)));
	const unplannedCount = changed.filter((f) => !planFiles.has(f)).length;
	const planTaskCount = plan.tasks.filter((t) => t.file).length;

	const overEngThreshold = loadConfig().review.required_changed_files;
	if (unplannedCount > overEngThreshold || totalChanged > planTaskCount * 2) {
		process.stderr.write(
			`[qult] Over-engineering risk: ${unplannedCount} unplanned file(s) out of ${totalChanged} changed. Review scope.\n`,
		);
	}
}

/** Warn when many files changed without a plan. Escalates to block in Stop hook.
 *  This enforces "architect designs, agent implements" — no large unplanned changes. */
const planWarnedAt = new Set<number>(); // deduplicate warnings by file-count threshold

function checkPlanRequired(): void {
	const plan = getActivePlan();
	if (plan) return; // plan exists — no warning needed

	const state = readSessionState();
	const changed = state.changed_file_paths?.length ?? 0;
	const threshold = loadConfig().review.required_changed_files;

	if (changed >= threshold && !planWarnedAt.has(threshold)) {
		planWarnedAt.add(threshold);
		process.stderr.write(
			`[qult] Plan required: ${changed} files changed without a plan. Run /qult:plan-generator to create a structured plan.\n`,
		);
	}
	// Escalate at 2x threshold
	if (changed >= threshold * 2 && !planWarnedAt.has(threshold * 2)) {
		planWarnedAt.add(threshold * 2);
		process.stderr.write(
			`[qult] Plan strongly recommended: ${changed} files changed (${threshold * 2}+ threshold). Large unplanned changes risk scope creep and missed tests.\n`,
		);
	}
}

// ── Test-on-edit command builder ─────────────────────────────

/** Build a test command for a specific file based on the test runner in on_commit.test. */
function buildTestFileCommand(testCommand: string, testFile: string): string | null {
	const escaped = shellEscape(testFile);
	// vitest / jest: append file path
	if (/\b(vitest|jest)\b/.test(testCommand)) {
		const base = testCommand.replace(/\s+run\b/, " run");
		return `${base} ${escaped}`;
	}
	// pytest: append file path
	if (/\bpytest\b/.test(testCommand)) {
		return `${testCommand} ${escaped}`;
	}
	// go test: run on package directory (go test doesn't accept file paths)
	if (/\bgo\s+test\b/.test(testCommand)) {
		return `go test -v -run . ${shellEscape(dirname(testFile))}`;
	}
	// mocha: append file
	if (/\bmocha\b/.test(testCommand)) {
		return `${testCommand} ${escaped}`;
	}
	return null;
}

// ── Bash: three independent detectors ───────────────────────

const GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;

const LINT_FIX_RE =
	/\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/;

/** Fallback regex for test command detection when no on_commit gates configured.
 *  Includes bun/npx/pnpm prefixed variants. */
const TEST_CMD_RE = /\b(bun\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;

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

	const config = loadConfig();
	const coverageThreshold = config.gates.coverage_threshold;

	for (const [name, gate] of Object.entries(gates.on_commit)) {
		try {
			if (isGateDisabled(name)) continue;

			// Coverage gate: check coverage percentage against threshold
			if (name === "coverage" && coverageThreshold > 0) {
				const result = runCoverageGate(name, gate, coverageThreshold);
				if (!result.passed) {
					addPendingFixes("__commit__", [
						{ file: "__commit__", errors: [result.output], gate: name },
					]);
				}
				continue;
			}

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
 *  Best-effort detection — MCP `record_test_pass` is the authoritative mechanism.
 *  Requires positive evidence of success — absence of exit code does NOT count as pass. */
function onTestCommand(ev: HookEvent, command: string): void {
	// Prefer structured exitCode from tool_response (more reliable than regex)
	const structuredCode = getStructuredExitCode(ev);
	if (structuredCode !== null) {
		if (structuredCode === 0) recordTestPass(command);
		return;
	}

	// Fallback: parse exit code from text output (multiple patterns for robustness)
	const output = getToolOutput(ev);
	const exitCodeMatch =
		output.match(/exit code (\d+)/i) ??
		output.match(/exited with (\d+)/i) ??
		output.match(/exited with code (\d+)/i) ??
		output.match(/process exited with (\d+)/i);
	const isPass = exitCodeMatch ? Number(exitCodeMatch[1]) === 0 : false;

	if (isPass) {
		recordTestPass(command);
	}
}

/** Extract structured exit code from tool_response if available. Returns null if not present. */
function getStructuredExitCode(ev: HookEvent): number | null {
	if (ev.tool_response != null && typeof ev.tool_response === "object") {
		const resp = ev.tool_response as Record<string, unknown>;
		if (typeof resp.exitCode === "number") return resp.exitCode;
		if (typeof resp.exit_code === "number") return resp.exit_code;
	}
	return null;
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
