/**
 * Living Spec auto-append: after git commit, detect changed source files
 * and append them to the matching component section in design.md.
 *
 * Multi-language: JS/TS, Python, Go, Ruby.
 * Fail-open: all errors silently ignored.
 */

import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { readActive, SpecDir } from "../spec/types.js";
import { shouldAutoAppend } from "./lang-filter.js";

/**
 * Run Living Spec auto-append after a successful git commit.
 * Returns set of auto-appended file paths (for drift detection exclusion).
 */
export function handleLivingSpec(cwd: string): Set<string> {
	const appended = new Set<string>();
	try {
		const slug = readActive(cwd);
		const sd = new SpecDir(cwd, slug);

		let designContent: string;
		try {
			designContent = sd.readFile("design.md");
		} catch {
			return appended; // no design.md → skip
		}

		const changedFiles = extractChangedFiles(cwd);
		if (changedFiles.length === 0) return appended;

		const sourceFiles = changedFiles.filter(shouldAutoAppend);
		if (sourceFiles.length === 0) return appended;

		const componentMap = parseDesignFileRefs(designContent);
		if (componentMap.size === 0) return appended;

		let updatedContent = designContent;
		const appendedComponents: string[] = [];

		for (const file of sourceFiles) {
			// Skip if already tracked in design.md.
			if (designContent.includes(`\`${file}\``)) continue;

			const component = matchComponent(file, componentMap);
			if (!component) continue;

			const result = appendFileToComponent(updatedContent, component, file);
			if (result) {
				updatedContent = result;
				appended.add(file);
				appendedComponents.push(`${component}:${file}`);
			}
		}

		if (appended.size > 0) {
			sd.writeFile("design.md", updatedContent);
		}
	} catch {
		/* fail-open */
	}
	return appended;
}

/**
 * Extract changed files from the last git commit.
 * 2s timeout (within PostToolUse 4.5s budget), warns on timeout via stderr.
 */
export function extractChangedFiles(cwd: string): string[] {
	try {
		const output = execSync("git diff --name-only HEAD~1", {
			cwd,
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch (err: unknown) {
		if (err && typeof err === "object" && "killed" in err && (err as { killed: boolean }).killed) {
			process.stderr.write("[alfred] git diff timed out — design.md not updated for this commit\n");
		}
		return [];
	}
}

/**
 * Parse design.md for component → file references.
 * Looks for `### Component: Name` headings with `**File**: \`path\`` lines.
 */
export function parseDesignFileRefs(content: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	let currentComponent = "";

	for (const line of content.split("\n")) {
		// Match component headings: ### Component: Name or ### Name
		const compMatch = line.match(/^###\s+(?:Component:\s*)?(.+)/);
		if (compMatch) {
			currentComponent = compMatch[1]!.trim();
			if (!map.has(currentComponent)) {
				map.set(currentComponent, []);
			}
			continue;
		}

		// Match file references: - **File**: `path/to/file.ext`
		if (currentComponent) {
			const fileMatch = line.match(/\*\*File\*\*:\s*`([^`]+)`/);
			if (fileMatch) {
				map.get(currentComponent)!.push(fileMatch[1]!);
			}
		}
	}

	return map;
}

/**
 * Match a file to a component by comparing directory paths.
 * Supports hierarchical matching: a file at `src/api/handlers/auth.ts`
 * matches a component with `src/api/server.ts` (ancestor directory).
 * Prefers the most specific (deepest) match when multiple components match.
 */
export function matchComponent(
	filePath: string,
	componentMap: Map<string, string[]>,
): string | null {
	const fileDir = dirname(filePath);
	let bestMatch: string | null = null;
	let bestDepth = -1;

	for (const [component, files] of componentMap) {
		for (const existing of files) {
			const existingDir = dirname(existing);
			// Exact match or ancestor match (fileDir starts with existingDir)
			if (
				fileDir === existingDir ||
				(fileDir.startsWith(existingDir + "/") && existingDir !== ".")
			) {
				const depth = existingDir.split("/").length;
				if (depth > bestDepth) {
					bestDepth = depth;
					bestMatch = component;
				}
			}
		}
	}

	return bestMatch;
}

/**
 * Append a file reference after the last **File**: line in a component section.
 * Returns updated content or null if unable to insert.
 */
export function appendFileToComponent(
	content: string,
	component: string,
	filePath: string,
): string | null {
	const lines = content.split("\n");
	const ts = new Date().toISOString();
	const newLine = `- **File**: \`${filePath}\` <!-- auto-added: ${ts} -->`;

	// Find the component heading.
	let componentIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (
			line.match(/^###\s+/) &&
			(line.includes(`Component: ${component}`) || line.includes(component))
		) {
			componentIdx = i;
			break;
		}
	}
	if (componentIdx === -1) return null;

	// Find the last **File**: line within this component section.
	let lastFileIdx = -1;
	for (let i = componentIdx + 1; i < lines.length; i++) {
		if (lines[i]!.match(/^##/)) break; // hit next section
		if (lines[i]!.includes("**File**:")) {
			lastFileIdx = i;
		}
	}

	if (lastFileIdx === -1) return null; // component has no File: lines

	// Insert after the last File: line.
	lines.splice(lastFileIdx + 1, 0, newLine);
	return lines.join("\n");
}
