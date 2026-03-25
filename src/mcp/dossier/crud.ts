import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearReviewGate, readReviewGate } from "../../hooks/review-gate.js";
import { stripTemplate } from "../../spec/templates.js";
import type { SpecFile, SpecSize, SpecType } from "../../spec/types.js";
import {
	parseTasksFile,
	readActive,
	readActiveState,
	effectiveStatus,
	removeTask,
	SpecDir,
	switchActive,
} from "../../spec/types.js";
import { validateSpec } from "../../spec/validate.js";
import type { Store } from "../../store/index.js";
import { type DossierParams, errorResult, jsonResult } from "./helpers.js";
import { getReadyTasks } from "./lifecycle.js";

export function dossierUpdate(projectPath: string, store: Store, params: DossierParams) {
	if (!params.file) return errorResult("file is required for update");
	if (!params.content) return errorResult("content is required for update");
	// FR-10: JSON files MUST use replace mode — append creates invalid JSON.
	const isJson = typeof params.file === "string" && params.file.endsWith(".json");
	const mode = isJson ? "replace" : (params.mode ?? "append");

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
	};
	if (task?.completed_at) result.completed_at = task.completed_at;

	result.lang = process.env.ALFRED_LANG || "en";

	// Read all spec file contents.
	if (sd.exists()) {
		for (const section of sd.allSections()) {
			const key = section.file.replace(".md", "");
			result[key] = section.content;
		}

		// Show tasks ready to work on (all depends satisfied, not yet checked).
		try {
			const tasksData = parseTasksFile(sd.readFile("tasks.json"));
			const ready = getReadyTasks(tasksData);
			if (ready.length > 0) {
				result.ready_tasks = ready.map((t) => ({
					id: t.id,
					title: t.title,
					depends: t.depends ?? [],
				}));
			}
		} catch { /* tasks.json may not exist */ }
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

		return jsonResult({
			task_slug: params.task_slug,
			deleted: true,
			active_md_removed: allRemoved,
		});
	} catch (err) {
		return errorResult(`${err}`);
	}
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
