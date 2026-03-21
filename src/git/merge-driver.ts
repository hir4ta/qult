import { readFileSync, writeFileSync } from "node:fs";

/**
 * Git merge driver for knowledge JSON files.
 * Called by git as: alfred merge-driver %O %A %B
 *
 * %O = ancestor (base), %A = current (ours), %B = other (theirs)
 * Exit: 0 = merge success, 1 = conflict remains → git fallback
 */
export function mergeKnowledgeFiles(
	basePath: string,
	oursPath: string,
	theirsPath: string,
): number {
	let base: Record<string, unknown>;
	let ours: Record<string, unknown>;
	let theirs: Record<string, unknown>;

	try {
		base = JSON.parse(readFileSync(basePath, "utf-8"));
		ours = JSON.parse(readFileSync(oursPath, "utf-8"));
		theirs = JSON.parse(readFileSync(theirsPath, "utf-8"));
	} catch (err) {
		process.stderr.write(
			`alfred merge-driver: JSON parse error, falling back to git merge: ${err}\n`,
		);
		return 1;
	}

	// Validate basic knowledge JSON structure (must have id + title)
	if (!isKnowledgeEntry(base) || !isKnowledgeEntry(ours) || !isKnowledgeEntry(theirs)) {
		process.stderr.write(
			"alfred merge-driver: not a valid knowledge entry, falling back to git merge\n",
		);
		return 1;
	}

	const result: Record<string, unknown> = {};
	let hasConflict = false;
	const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);

	for (const key of allKeys) {
		const baseVal = base[key];
		const oursVal = ours[key];
		const theirsVal = theirs[key];

		// Numeric fields: take max
		if (NUMERIC_MAX_FIELDS.has(key)) {
			result[key] = Math.max(Number(oursVal ?? 0), Number(theirsVal ?? 0));
			continue;
		}

		// Timestamp fields: take newer
		if (TIMESTAMP_FIELDS.has(key)) {
			result[key] = String(oursVal ?? "") >= String(theirsVal ?? "") ? oursVal : theirsVal;
			continue;
		}

		// Array fields: union
		if (Array.isArray(baseVal) || Array.isArray(oursVal) || Array.isArray(theirsVal)) {
			const oursArr = Array.isArray(oursVal) ? oursVal : (Array.isArray(baseVal) ? baseVal : []);
			const theirsArr = Array.isArray(theirsVal) ? theirsVal : (Array.isArray(baseVal) ? baseVal : []);
			result[key] = [...new Set([...oursArr, ...theirsArr])];
			continue;
		}

		// Author field: keep ours (created_by semantics)
		if (key === "author") {
			result[key] = oursVal ?? theirsVal ?? baseVal ?? "";
			continue;
		}

		// Content fields: 3-way merge
		const baseStr = JSON.stringify(baseVal);
		const oursStr = JSON.stringify(oursVal);
		const theirsStr = JSON.stringify(theirsVal);

		if (oursStr === theirsStr) {
			// Both same → use either
			result[key] = oursVal;
		} else if (oursStr === baseStr) {
			// Ours unchanged → take theirs
			result[key] = theirsVal;
		} else if (theirsStr === baseStr) {
			// Theirs unchanged → take ours
			result[key] = oursVal;
		} else {
			// Both changed → conflict
			hasConflict = true;
			result[key] = {
				"<<<<<<< ours": oursVal,
				"=======": null,
				">>>>>>> theirs": theirsVal,
			};
		}
	}

	try {
		writeFileSync(oursPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
	} catch (err) {
		process.stderr.write(`alfred merge-driver: write error: ${err}\n`);
		return 1;
	}

	return hasConflict ? 1 : 0;
}

const NUMERIC_MAX_FIELDS = new Set(["hit_count", "hitCount", "last_accessed_count"]);
const TIMESTAMP_FIELDS = new Set(["updatedAt", "updated_at", "lastAccessed", "last_accessed"]);

function isKnowledgeEntry(obj: unknown): obj is Record<string, unknown> {
	if (typeof obj !== "object" || obj === null) return false;
	const o = obj as Record<string, unknown>;
	return typeof o.id === "string" && typeof o.title === "string";
}
