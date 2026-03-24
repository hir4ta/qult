/**
 * Drift detection: warn when committed source files are not referenced in the active spec.
 * Runs after git commit in PostToolUse, after Living Spec auto-append.
 *
 * Reuses extractChangedFiles + parseDesignFileRefs from living-spec.ts.
 * Budget: ~600ms within PostToolUse 4.5s internal timeout.
 */

import { readActive, SpecDir } from "../spec/types.js";
import type { DirectiveItem } from "./directives.js";
import { shouldAutoAppend } from "./lang-filter.js";
import { extractChangedFiles, parseDesignFileRefs } from "./living-spec.js";

/** Config files that are expected to change without spec tracking. */
const CONFIG_BASENAMES = new Set([
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"tsconfig.json",
	"vitest.config.ts",
	"vite.config.ts",
	"biome.json",
	"Taskfile.yml",
	"Makefile",
	"README.md",
	"CLAUDE.md",
	"LICENSE",
	".gitignore",
	".npmignore",
]);

/**
 * Detect source files changed in the last commit that are not referenced in the active spec.
 * @param projectPath - project root
 * @param appendedFiles - files just tracked by living-spec (exclude from warnings)
 * @param items - directive items to append warnings to
 */
export function detectDrift(
	projectPath: string,
	appendedFiles: Set<string>,
	items: DirectiveItem[],
): void {
	try {
		const slug = readActive(projectPath);
		const sd = new SpecDir(projectPath, slug);

		// Collect all file references from spec.
		const specRefs = new Set<string>();

		// design.md File: references.
		try {
			const designContent = sd.readFile("design.md");
			const componentMap = parseDesignFileRefs(designContent);
			for (const files of componentMap.values()) {
				for (const f of files) specRefs.add(f);
			}
		} catch {
			/* no design.md */
		}

		// tasks.json file references (task.files arrays).
		try {
			const data = JSON.parse(sd.readFile("tasks.json"));
			const allTasks = [...(data.waves ?? []).flatMap((w: any) => w.tasks), ...(data.closing?.tasks ?? [])];
			for (const t of allTasks) {
				for (const f of (t.files ?? [])) specRefs.add(f);
			}
		} catch { /* no tasks.json */ }

		if (specRefs.size === 0) return; // no file refs in spec — skip

		// Get changed files from last commit.
		const changedFiles = extractChangedFiles(projectPath);
		if (changedFiles.length === 0) return;

		// Filter to untracked source files.
		const drifted: string[] = [];
		for (const file of changedFiles) {
			if (appendedFiles.has(file)) continue; // just tracked by living-spec
			if (!shouldTrackDrift(file)) continue; // not a trackable source file
			if (specRefs.has(file)) continue; // referenced in spec
			drifted.push(file);
		}

		if (drifted.length === 0) return;

		// Emit warning (max 5 files to keep message concise).
		const shown = drifted.slice(0, 5);
		const extra = drifted.length > 5 ? ` (+${drifted.length - 5} more)` : "";
		items.push({
			level: "WARNING",
			message: `Source file(s) changed but not referenced in spec '${slug}':\n${shown.map((f) => `- ${f}`).join("\n")}${extra}\nConsider adding to design.md \`**File**:\` references or tasks.json \`files\` array.`,
		});

	} catch {
		/* fail-open: drift detection errors don't affect PostToolUse */
	}
}

/** Check if a file should be tracked for drift (source files only, not config/test/generated). */
function shouldTrackDrift(filePath: string): boolean {
	if (filePath.startsWith(".alfred/")) return false;
	const base = filePath.split("/").pop() ?? "";
	if (CONFIG_BASENAMES.has(base)) return false;
	if (base.startsWith(".")) return false; // dotfiles
	return shouldAutoAppend(filePath);
}
