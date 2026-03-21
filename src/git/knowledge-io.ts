import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { contentHash } from "../store/knowledge.js";
import { levenshtein } from "../store/fts.js";

// ── Export ──

export interface ExportResult {
	entries: Record<string, unknown>[];
	count: number;
}

export function exportKnowledge(projectPath: string): ExportResult {
	const knowledgeDir = join(projectPath, ".alfred", "knowledge");
	if (!existsSync(knowledgeDir)) return { entries: [], count: 0 };

	const entries: Record<string, unknown>[] = [];
	for (const subType of ["decisions", "patterns", "rules"]) {
		const dir = join(knowledgeDir, subType);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			try {
				const content = readFileSync(join(dir, file), "utf-8");
				entries.push(JSON.parse(content));
			} catch {
				process.stderr.write(`warning: skipping invalid JSON: ${subType}/${file}\n`);
			}
		}
	}
	return { entries, count: entries.length };
}

// ── Import ──

export interface ImportResult {
	imported: number;
	skipped: number;
	similar: number;
}

export function importKnowledge(
	projectPath: string,
	entries: unknown[],
): ImportResult {
	const knowledgeDir = join(projectPath, ".alfred", "knowledge");
	const result: ImportResult = { imported: 0, skipped: 0, similar: 0 };

	// Collect existing entries for dedup
	const existingHashes = new Set<string>();
	const existingTitles: Array<{ title: string; path: string }> = [];
	if (existsSync(knowledgeDir)) {
		for (const subType of ["decisions", "patterns", "rules"]) {
			const dir = join(knowledgeDir, subType);
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
				try {
					const content = readFileSync(join(dir, file), "utf-8");
					existingHashes.add(contentHash(content));
					const parsed = JSON.parse(content) as Record<string, unknown>;
					if (typeof parsed.title === "string") {
						existingTitles.push({ title: parsed.title, path: join(dir, file) });
					}
				} catch { /* skip invalid */ }
			}
		}
	}

	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const obj = entry as Record<string, unknown>;

		if (typeof obj.id !== "string" || typeof obj.title !== "string") {
			process.stderr.write(`warning: skipping entry without id/title\n`);
			continue;
		}

		const entryJson = JSON.stringify(obj, null, 2) + "\n";
		const hash = contentHash(entryJson);

		// Check content_hash dedup
		if (existingHashes.has(hash)) {
			result.skipped++;
			continue;
		}

		// Check title similarity (normalized Levenshtein <= 0.3)
		const title = obj.title as string;
		for (const existing of existingTitles) {
			const maxLen = Math.max(title.length, existing.title.length);
			if (maxLen === 0) continue;
			const dist = levenshtein(title.toLowerCase(), existing.title.toLowerCase());
			const normalized = dist / maxLen;
			if (normalized <= 0.3) {
				process.stderr.write(
					`similar entry found:\n  import: "${title}"\n  existing: "${existing.title}" (${relative(projectPath, existing.path)})\n`,
				);
				result.similar++;
			}
		}

		// Sanitize id to prevent path traversal
		const safeId = (obj.id as string).replace(/[^a-zA-Z0-9_\-]/g, "-");
		if (!safeId) continue;

		// Determine sub_type from entry structure
		const subType = detectSubType(obj);
		const dir = join(knowledgeDir, subType);
		mkdirSync(dir, { recursive: true });

		const fileName = `${safeId}.json`;
		writeFileSync(join(dir, fileName), entryJson, "utf-8");
		existingHashes.add(hash);
		result.imported++;
	}

	return result;
}

function detectSubType(entry: Record<string, unknown>): string {
	if ("decision" in entry && "reasoning" in entry) return "decisions";
	if ("pattern" in entry && "applicationConditions" in entry) return "patterns";
	if ("key" in entry && "text" in entry && "priority" in entry) return "rules";
	return "decisions"; // default
}

// ── Diff ──

export interface FieldDiff {
	field: string;
	before: string;
	after: string;
}

export interface DiffResult {
	added: string[];
	modified: Array<{ path: string; changes: FieldDiff[] }>;
	deleted: string[];
}

export function showKnowledgeDiff(projectPath: string): DiffResult {
	const knowledgePath = ".alfred/knowledge";
	const result: DiffResult = { added: [], modified: [], deleted: [] };

	let statusOutput: string;
	try {
		statusOutput = execSync(
			`git diff --name-status HEAD -- "${knowledgePath}"`,
			{ cwd: projectPath, encoding: "utf-8", timeout: 5000 },
		).trim();
	} catch {
		return result;
	}

	if (!statusOutput) return result;

	for (const line of statusOutput.split("\n")) {
		const [status, filePath] = line.split("\t");
		if (!filePath) continue;

		if (status === "A") {
			result.added.push(filePath);
		} else if (status === "D") {
			result.deleted.push(filePath);
		} else if (status === "M") {
			try {
				const oldContent = execFileSync(
					"git", ["show", `HEAD:${filePath}`],
					{ cwd: projectPath, encoding: "utf-8", timeout: 5000 },
				);
				const newContent = readFileSync(join(projectPath, filePath), "utf-8");
				const oldObj = JSON.parse(oldContent) as Record<string, unknown>;
				const newObj = JSON.parse(newContent) as Record<string, unknown>;
				const changes: FieldDiff[] = [];
				const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
				for (const key of allKeys) {
					const oldVal = JSON.stringify(oldObj[key]);
					const newVal = JSON.stringify(newObj[key]);
					if (oldVal !== newVal) {
						changes.push({ field: key, before: oldVal ?? "undefined", after: newVal ?? "undefined" });
					}
				}
				if (changes.length > 0) {
					result.modified.push({ path: filePath, changes });
				}
			} catch {
				result.modified.push({ path: filePath, changes: [] });
			}
		}
	}

	return result;
}
