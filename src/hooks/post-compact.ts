import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadGates } from "../gates/load.ts";
import { getDb, getSessionId } from "../state/db.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { readSessionState } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { sanitizeForStderr } from "./sanitize.ts";

/**
 * PostCompact: re-inject qult state summary into Claude's context after compaction.
 * Outputs to stdout (PostCompact stdout goes to Claude's context).
 * This is the primary instruction drift defense after context compression.
 */
export default async function postCompact(_ev: HookEvent): Promise<void> {
	try {
		const parts: string[] = [];

		// Pending fixes (with up to 3 error details per file)
		const fixes = readPendingFixes();
		if (fixes.length > 0) {
			parts.push(`[qult] ${fixes.length} pending fix(es):`);
			for (const fix of fixes) {
				parts.push(`  [${fix.gate}] ${fix.file}`);
				if (fix.errors?.length > 0) {
					const shown = fix.errors
						.slice(0, 3)
						.map((e) => `    ${sanitizeForStderr(e.slice(0, 200))}`);
					parts.push(...shown);
					if (fix.errors.length > 3) {
						parts.push(`    ... and ${fix.errors.length - 3} more error(s)`);
					}
				}
			}
		}

		// Session state summary
		const state = readSessionState();
		const summary: string[] = [];
		const hasGates = loadGates() !== null;
		if (state.test_passed_at) summary.push(`test_passed_at: ${state.test_passed_at}`);
		else if (hasGates) summary.push("tests: NOT PASSED");
		if (state.review_completed_at)
			summary.push(`review_completed_at: ${state.review_completed_at}`);
		else if (hasGates) summary.push("review: NOT DONE");
		if (state.changed_file_paths.length > 0)
			summary.push(`${state.changed_file_paths.length} file(s) changed`);
		if (state.disabled_gates.length > 0)
			summary.push(`disabled gates: ${state.disabled_gates.join(", ")}`);
		if (state.review_iteration > 0) summary.push(`review iteration: ${state.review_iteration}`);
		if (state.security_warning_count > 0)
			summary.push(`security warnings: ${state.security_warning_count}`);
		if (state.test_quality_warning_count > 0)
			summary.push(`test quality warnings: ${state.test_quality_warning_count}`);
		if (state.drift_warning_count > 0) summary.push(`drift warnings: ${state.drift_warning_count}`);
		if (state.dead_import_warning_count > 0)
			summary.push(`dead import warnings: ${state.dead_import_warning_count}`);
		if (summary.length > 0) {
			parts.push(`[qult] Session: ${summary.join(", ")}`);
		}

		// Plan task status
		try {
			const planDir = join(process.cwd(), ".claude", "plans");
			if (existsSync(planDir)) {
				const planFiles = readdirSync(planDir)
					.filter((f) => f.endsWith(".md"))
					.map((f) => ({ name: f, mtime: statSync(join(planDir, f)).mtimeMs }))
					.sort((a, b) => b.mtime - a.mtime);
				if (planFiles.length > 0) {
					const content = readFileSync(join(planDir, planFiles[0]!.name), "utf-8");
					const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
					const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
					if (taskCount > 0) {
						parts.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
					}
				}
			}
		} catch {
			/* fail-open */
		}

		// Recent review findings from DB
		try {
			const db = getDb();
			const sid = getSessionId();
			const findings = db
				.prepare(
					"SELECT file, severity, description FROM review_findings WHERE session_id = ? ORDER BY id DESC LIMIT 5",
				)
				.all(sid) as { file: string; severity: string; description: string }[];
			if (findings.length > 0) {
				parts.push("[qult] Recent review findings:");
				for (const f of findings) {
					parts.push(
						`  [${sanitizeForStderr(f.severity)}] ${sanitizeForStderr(f.file)} — ${sanitizeForStderr(f.description.slice(0, 150))}`,
					);
				}
			}
		} catch {
			/* fail-open */
		}

		// Config overrides
		try {
			const { DEFAULTS, loadConfig } = await import("../config.ts");
			const config = loadConfig();
			const d = DEFAULTS;
			const overrides: string[] = [];
			if (config.review.score_threshold !== d.review.score_threshold)
				overrides.push(`score_threshold=${config.review.score_threshold}`);
			if (config.review.dimension_floor !== d.review.dimension_floor)
				overrides.push(`dimension_floor=${config.review.dimension_floor}`);
			if (config.review.required_changed_files !== d.review.required_changed_files)
				overrides.push(`required_changed_files=${config.review.required_changed_files}`);
			if (config.review.require_human_approval) overrides.push("require_human_approval=true");
			if (config.gates.test_on_edit) overrides.push("test_on_edit=true");
			if (overrides.length > 0) {
				parts.push(`[qult] Config overrides: ${overrides.join(", ")}`);
			}
		} catch {
			/* fail-open */
		}

		if (parts.length > 0) {
			process.stdout.write(parts.join("\n"));
		}
	} catch {
		/* fail-open */
	}
}
