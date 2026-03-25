import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { getGitUserName } from "../git/user.js";
import type { TemplateData } from "./templates.js";
import { renderForSize } from "./templates.js";
import type { InitResult, SpecSize, SpecType } from "./types.js";
import {
	cancelPath,
	completePath,
	detectSize,
	filesForSize,
	readActiveState,
	SpecDir,
	VALID_SLUG,
	writeActiveState,
} from "./types.js";

interface InitOptions {
	size?: SpecSize;
	specType?: SpecType;
}

export function initSpec(
	projectPath: string,
	taskSlug: string,
	description: string,
	opts?: InitOptions,
): InitResult {
	if (!VALID_SLUG.test(taskSlug)) {
		throw new Error(
			`invalid task_slug "${taskSlug}": must be lowercase alphanumeric with hyphens (e.g., 'add-auth')`,
		);
	}

	const size = opts?.size ?? detectSize(description);
	const specType: SpecType = opts?.specType ?? "feature";

	const sd = new SpecDir(projectPath, taskSlug);
	if (sd.exists()) {
		throw new Error(`spec already exists for '${taskSlug}'; use dossier action=update to modify`);
	}

	// Check _active.json for ghost entries (slug exists in state but dir was deleted).
	try {
		const state = readActiveState(projectPath);
		if (state.tasks.some((t) => t.slug === taskSlug)) {
			throw new Error(`slug '${taskSlug}' already in _active.json; use dossier action=switch to resume`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes("already in _active.json")) throw err;
		/* fail-open: state read errors don't block init */
	}

	mkdirSync(sd.dir(), { recursive: true });

	const data: TemplateData = {
		taskSlug,
		description,
		date: new Date().toISOString().slice(0, 10),
		specType,
	};

	const rendered = renderForSize(size, specType, data);
	const files = filesForSize(size, specType);

	try {
		for (const f of files) {
			const content = rendered.get(f) ?? "";
			writeFileSync(sd.filePath(f), content);
		}
	} catch (err) {
		rmSync(sd.dir(), { recursive: true, force: true });
		throw new Error(`write template files: ${err}`);
	}

	// Update _active.json + ensure _complete.json / _cancel.json exist.
	const now = new Date().toISOString();
	const state = readActiveState(projectPath);
	state.primary = taskSlug;
	if (!state.tasks.some((t) => t.slug === taskSlug)) {
		state.tasks.push({
			slug: taskSlug,
			started_at: now,
			status: "pending",
			size,
			spec_type: specType,
			owner: getGitUserName(projectPath),
		});
	}
	writeActiveState(projectPath, state);

	// Ensure terminal state files exist (empty if new)
	for (const p of [completePath(projectPath), cancelPath(projectPath)]) {
		if (!existsSync(p)) {
			writeFileSync(p, JSON.stringify({ tasks: [] }, null, 2) + "\n");
		}
	}

	return { specDir: sd, size, specType, files };
}
