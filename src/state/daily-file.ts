import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const QULT_DIR = ".qult";

/** Get today's date as YYYY-MM-DD. */
export function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get year-month directory: .qult/<base>/YYYY-MM */
function dirForDate(base: string, date: string): string {
	const yearMonth = date.slice(0, 7); // "2026-03"
	return join(process.cwd(), QULT_DIR, base, yearMonth);
}

/** Get full path for a date: .qult/<base>/YYYY-MM/YYYY-MM-DD.json */
export function pathForDate(base: string, date: string): string {
	return join(dirForDate(base, date), `${date}.json`);
}

/** Get full path for today. */
export function pathForToday(base: string): string {
	return pathForDate(base, today());
}

/** Read a single day's JSON file. Returns fallback on missing/error. */
export function readDaily<T>(base: string, date: string, fallback: T): T {
	try {
		const path = pathForDate(base, date);
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}

/** Write data to a day's JSON file (atomic). */
export function writeDaily<T>(base: string, date: string, data: T): void {
	atomicWriteJson(pathForDate(base, date), data);
}

/** List all day files under base, sorted ascending by filename. */
export function listDayFiles(base: string): string[] {
	const baseDir = join(process.cwd(), QULT_DIR, base);
	if (!existsSync(baseDir)) return [];
	const files: string[] = [];
	try {
		for (const month of readdirSync(baseDir).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
			const monthDir = join(baseDir, month);
			try {
				for (const file of readdirSync(monthDir)) {
					if (file.endsWith(".json")) {
						files.push(join(monthDir, file));
					}
				}
			} catch {
				// skip non-directories or read errors
			}
		}
	} catch {
		return [];
	}
	return files.sort();
}

/** Read all day files and concatenate arrays. For metrics (T = Entry[]). */
export function readAllDaysArray<T>(base: string): T[] {
	const result: T[] = [];
	for (const file of listDayFiles(base)) {
		try {
			const data = JSON.parse(readFileSync(file, "utf-8"));
			if (Array.isArray(data)) {
				result.push(...data);
			}
		} catch {
			// skip corrupt files
		}
	}
	return result;
}

/** Read all day files and merge objects with array fields. For gate-history ({gates:[], commits:[]}). */
export function readAllDaysMerge(base: string, keys: string[]): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	for (const key of keys) {
		result[key] = [];
	}
	for (const file of listDayFiles(base)) {
		try {
			const data = JSON.parse(readFileSync(file, "utf-8"));
			for (const key of keys) {
				const arr = data[key];
				if (Array.isArray(arr)) {
					result[key]!.push(...arr);
				}
			}
		} catch {
			// skip corrupt files
		}
	}
	return result;
}

/** Migrate old single-file state to today's daily file, then remove old file. */
export function migrateIfNeeded(oldPath: string, base: string): boolean {
	if (!existsSync(oldPath)) return false;
	try {
		const data = readFileSync(oldPath, "utf-8");
		const parsed = JSON.parse(data);
		const todayPath = pathForToday(base);
		// Merge with existing today file if it exists
		if (existsSync(todayPath)) {
			const existing = JSON.parse(readFileSync(todayPath, "utf-8"));
			if (Array.isArray(parsed) && Array.isArray(existing)) {
				atomicWriteJson(todayPath, [...parsed, ...existing]);
			} else if (typeof parsed === "object" && typeof existing === "object") {
				// Merge object with array fields (gate-history style)
				const merged = { ...parsed };
				for (const key of Object.keys(merged)) {
					if (Array.isArray(merged[key]) && Array.isArray(existing[key])) {
						merged[key] = [...merged[key], ...existing[key]];
					}
				}
				atomicWriteJson(todayPath, merged);
			}
		} else {
			atomicWriteJson(todayPath, parsed);
		}
		rmSync(oldPath);
		return true;
	} catch {
		return false;
	}
}
