import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearReviewGate, readReviewGate } from "../../hooks/review-gate.js";
import { appendAudit } from "../../spec/audit.js";
import { stripTemplate } from "../../spec/templates.js";
import type { SpecFile, SpecSize, SpecType } from "../../spec/types.js";
import {
	readActive,
	readActiveState,
	effectiveStatus,
	reviewStatusFor,
	removeTask,
	SpecDir,
	switchActive,
} from "../../spec/types.js";
import { validateSpec } from "../../spec/validate.js";
import type { Store } from "../../store/index.js";
import { type DossierParams, errorResult, jsonResult, truncateAtNewline } from "./helpers.js";

export function dossierUpdate(projectPath: string, store: Store, params: DossierParams) {
	if (!params.file) return errorResult("file is required for update");
	if (!params.content) return errorResult("content is required for update");
	const mode = params.mode ?? "append";

	// Resolve task slug.
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

	const file = params.file as SpecFile;
	try {
		if (mode === "replace") {
			sd.writeFile(file, params.content);
		} else {
			// Strip template content before appending (FR-16)
			let existing = "";
			try { existing = sd.readFile(file); } catch { /* file may not exist */ }
			const stripped = stripTemplate(existing);
			sd.writeFile(file, stripped + params.content);
		}
	} catch (err) {
		return errorResult(`${mode} failed: ${err}`);
	}

	const result: Record<string, unknown> = { task_slug: taskSlug, file: params.file, mode };

	// design.md pattern auto-extraction removed (FR-6).
	// Knowledge accumulation happens intentionally at Wave boundaries via ledger.

	// Language directive for consistent spec language.
	const lang = process.env.ALFRED_LANG || "en";
	if (lang !== "en") {
		result.lang = lang;
	}

	// Early validation feedback: run validateSpec after write and include hints.
	try {
		const state = readActiveState(projectPath);
		const task = state.tasks.find((t) => t.slug === taskSlug);
		const size = (task?.size ?? "L") as SpecSize;
		const specType = (task?.spec_type ?? "feature") as SpecType;
		const valResult = validateSpec(projectPath, taskSlug, size, specType);
		const issues = valResult.checks
			.filter((c) => c.status === "fail" || c.status === "warn")
			.map((c) => `[${c.status}] ${c.message}`);
		if (issues.length > 0) {
			result.validation_hints = issues;
		}
	} catch {
		/* fail-open: validation errors don't block update */
	}

	return jsonResult(result);
}

export function dossierStatus(projectPath: string) {
	let state;
	try {
		state = readActiveState(projectPath);
	} catch {
		return jsonResult({ active: false });
	}

	const taskSlug = state.primary;
	if (!taskSlug) return jsonResult({ active: false });

	const task = state.tasks.find((t) => t.slug === taskSlug);
	const sd = new SpecDir(projectPath, taskSlug);

	const result: Record<string, unknown> = {
		active: true,
		task_slug: taskSlug,
		spec_dir: sd.dir(),
		lifecycle: effectiveStatus(task?.status),
		started_at: task?.started_at,
		size: task?.size ?? "L",
		spec_type: task?.spec_type ?? "feature",
		review_status: task?.review_status ?? "pending",
	};
	if (task?.completed_at) result.completed_at = task.completed_at;

	result.lang = process.env.ALFRED_LANG || "en";

	// Steering summary for context restoration after compaction.
	const steeringDir = join(projectPath, ".alfred", "steering");
	const steeringSummary: string[] = [];
	for (const sf of ["product.md", "structure.md", "tech.md"]) {
		const sfPath = join(steeringDir, sf);
		if (existsSync(sfPath)) {
			try {
				steeringSummary.push(truncateAtNewline(readFileSync(sfPath, "utf-8"), 800));
			} catch { /* ignore */ }
		}
	}
	if (steeringSummary.length > 0) {
		result.steering_summary = steeringSummary.join("\n---\n");
	}

	// Read all spec file contents.
	if (sd.exists()) {
		for (const section of sd.allSections()) {
			const key = section.file.replace(".md", "");
			result[key] = section.content;
		}
	}

	return jsonResult(result);
}

export function dossierSwitch(projectPath: string, params: DossierParams) {
	if (!params.task_slug) return errorResult("task_slug is required for switch");
	try {
		switchActive(projectPath, params.task_slug);
	} catch (err) {
		return errorResult(`${err}`);
	}
	return jsonResult({ task_slug: params.task_slug, switched: true });
}

export function dossierDelete(projectPath: string, params: DossierParams) {
	if (!params.task_slug) return errorResult("task_slug is required for delete");

	const sd = new SpecDir(projectPath, params.task_slug);

	if (!params.confirm) {
		// Dry-run preview.
		const sections = sd.exists() ? sd.allSections() : [];
		return jsonResult({
			task_slug: params.task_slug,
			exists: sd.exists(),
			file_count: sections.length,
			files: sections.map((s) => s.file),
			warning: "This will permanently remove the spec directory. Pass confirm=true to proceed.",
		});
	}

	try {
		const allRemoved = removeTask(projectPath, params.task_slug);
		// FR-8: Clean up review gate if it belongs to the deleted spec.
		try {
			const gate = readReviewGate(projectPath);
			if (gate && gate.slug === params.task_slug) {
				clearReviewGate(projectPath);
			}
		} catch {
			/* fail-open */
		}

		appendAudit(projectPath, { action: "spec.delete", target: params.task_slug, user: "mcp" });
		return jsonResult({
			task_slug: params.task_slug,
			deleted: true,
			active_md_removed: allRemoved,
		});
	} catch (err) {
		return errorResult(`${err}`);
	}
}

export function dossierHistory(projectPath: string, params: DossierParams) {
	if (!params.file) return errorResult("file is required for history");

	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	const histDir = join(sd.dir(), ".history");
	const file = params.file;

	let versions: Array<{ timestamp: string; size: number }> = [];
	try {
		const entries = readdirSync(histDir)
			.filter((e) => e.startsWith(`${file}.`))
			.sort()
			.reverse();
		versions = entries.map((e) => {
			const ts = e.slice(file.length + 1);
			let size = 0;
			try {
				size = readFileSync(join(histDir, e), "utf-8").length;
			} catch {
				/* ignore */
			}
			return { timestamp: ts, size };
		});
	} catch {
		/* no history */
	}

	return jsonResult({ task_slug: taskSlug, file, versions, count: versions.length });
}

export function dossierRollback(projectPath: string, params: DossierParams) {
	if (!params.file) return errorResult("file is required for rollback");
	if (!params.version)
		return errorResult("version is required for rollback (use history to list versions)");

	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	const histDir = join(sd.dir(), ".history");
	const histPath = join(histDir, `${params.file}.${params.version}`);

	let content: string;
	try {
		content = readFileSync(histPath, "utf-8");
	} catch {
		return errorResult(`version not found: ${params.version}`);
	}

	try {
		sd.writeFile(params.file as SpecFile, content);
	} catch (err) {
		return errorResult(`rollback failed: ${err}`);
	}

	return jsonResult({
		task_slug: taskSlug,
		file: params.file,
		version: params.version,
		rolled_back: true,
	});
}

export function dossierReview(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const status = reviewStatusFor(projectPath, taskSlug);

	// Check for review files.
	const sd = new SpecDir(projectPath, taskSlug);
	const reviewsDir = join(sd.dir(), "reviews");
	let latestReview: unknown = null;
	let unresolvedCount = 0;

	try {
		const files = readdirSync(reviewsDir)
			.filter((f) => f.startsWith("review-"))
			.sort()
			.reverse();
		if (files[0]) {
			const reviewData = JSON.parse(readFileSync(join(reviewsDir, files[0]), "utf-8"));
			latestReview = reviewData;
			if (Array.isArray(reviewData.comments)) {
				unresolvedCount = reviewData.comments.filter(
					(c: { resolved?: boolean }) => !c.resolved,
				).length;
			}
		}
	} catch {
		/* no reviews */
	}

	return jsonResult({
		task_slug: taskSlug,
		review_status: status || "pending",
		latest_review: latestReview,
		unresolved_count: unresolvedCount,
	});
}

export function dossierValidate(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	const size = (task?.size ?? "L") as SpecSize;
	const specType = (task?.spec_type ?? "feature") as SpecType;

	const result = validateSpec(projectPath, taskSlug, size, specType);
	const blocking = result.checks.filter((c) => c.status === "fail");
	const warnings = result.checks.filter((c) => c.status === "warn");

	return jsonResult({
		task_slug: taskSlug,
		size,
		spec_type: specType,
		checks: result.checks,
		summary: result.summary,
		blocking_issues: blocking.map((c) => c.message),
		warnings: warnings.map((c) => c.message),
	});
}
