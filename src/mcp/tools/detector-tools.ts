/**
 * Detector category MCP tool handlers (6 tools):
 * get_pending_fixes, clear_pending_fixes, get_detector_summary,
 * get_file_health_score, get_impact_analysis, get_call_coverage.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../config.ts";
import { computeFileHealthScore } from "../../detector/health-score.ts";
import { findImporters } from "../../detector/import-graph.ts";
import { validateTestCoversImpl } from "../../detector/spec-trace-check.ts";
import { appendAuditLog } from "../../state/audit-log.ts";
import {
	clearPendingFixes as clearPendingFixesFs,
	readPendingFixes,
} from "../../state/json-state.ts";
import { errorResult, jsonResult, type ToolResult, textResult } from "./shared.ts";

export function handleGetPendingFixes(): ToolResult {
	const state = readPendingFixes();
	if (state.fixes.length === 0) return textResult("No pending fixes.");
	const lines: string[] = [`${state.fixes.length} pending fix(es):\n`];
	for (const fix of state.fixes) {
		lines.push(`[${fix.detector}] (${fix.severity}) ${fix.file}${fix.line ? `:${fix.line}` : ""}`);
		lines.push(`  ${fix.message}`);
	}
	return textResult(lines.join("\n"));
}

export function handleClearPendingFixes(args: Record<string, unknown> | undefined): ToolResult {
	const reason = typeof args?.reason === "string" ? args.reason : null;
	if (!reason || reason.length < 10 || new Set(reason).size < 5) {
		return errorResult("Missing or insufficient reason (min 10 chars, min 5 unique).");
	}
	clearPendingFixesFs();
	appendAuditLog({
		action: "clear_pending_fixes",
		reason,
		timestamp: new Date().toISOString(),
	});
	return textResult("All pending fixes cleared.");
}

export function handleGetDetectorSummary(cwd: string): ToolResult {
	const state = readPendingFixes();
	const lines: string[] = [];
	if (state.fixes.length > 0) {
		const byDetector: Record<string, typeof state.fixes> = {};
		for (const fix of state.fixes) {
			const d = fix.detector || "unknown";
			if (!byDetector[d]) byDetector[d] = [];
			byDetector[d].push(fix);
		}
		for (const [detector, fixes] of Object.entries(byDetector)) {
			lines.push(`\n[${detector}] ${fixes.length} issue(s):`);
			for (const fix of fixes) {
				const relPath = fix.file.startsWith(`${cwd}/`) ? fix.file.slice(cwd.length + 1) : fix.file;
				const loc = fix.line ? `:${fix.line}` : "";
				lines.push(`  (${fix.severity}) ${relPath}${loc}`);
				lines.push(`    ${fix.message.slice(0, 200)}`);
			}
		}
	}
	return lines.length === 0 ? textResult("No detector findings.") : textResult(lines.join("\n"));
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function handleGetFileHealthScore(
	args: Record<string, unknown> | undefined,
	cwd: string,
): ToolResult {
	const filePath = typeof args?.file_path === "string" ? args.file_path : "";
	if (!filePath) {
		return jsonResult({ score: 10, breakdown: {}, error: "file_path required" });
	}
	const resolved = resolve(filePath);
	const realFile = safeRealpath(resolved);
	const realCwd = safeRealpath(cwd);
	if (realFile !== realCwd && !realFile.startsWith(`${realCwd}/`)) {
		return jsonResult({
			score: 10,
			breakdown: {},
			error: "file_path must be within project directory",
		});
	}
	try {
		return jsonResult(computeFileHealthScore(resolved));
	} catch {
		return jsonResult({ score: 10, breakdown: {} });
	}
}

export function handleGetImpactAnalysis(
	args: Record<string, unknown> | undefined,
	cwd: string,
): ToolResult {
	const file = typeof args?.file === "string" ? args.file : "";
	if (!file) return errorResult("Missing file parameter.");
	try {
		const config = loadConfig();
		const consumers = findImporters(file, cwd, config.gates.import_graph_depth);
		return jsonResult({ file, consumers, count: consumers.length });
	} catch {
		return jsonResult({ file, consumers: [], count: 0 });
	}
}

export function handleGetCallCoverage(
	args: Record<string, unknown> | undefined,
	cwd: string,
): ToolResult {
	const testFile = typeof args?.test_file === "string" ? args.test_file : "";
	const implFile = typeof args?.impl_file === "string" ? args.impl_file : "";
	if (!testFile || !implFile) {
		return errorResult("Missing test_file or impl_file parameter.");
	}
	try {
		const covered = validateTestCoversImpl(testFile, "", implFile, cwd);
		return jsonResult({ test_file: testFile, impl_file: implFile, covered });
	} catch {
		return jsonResult({ test_file: testFile, impl_file: implFile, covered: false });
	}
}
