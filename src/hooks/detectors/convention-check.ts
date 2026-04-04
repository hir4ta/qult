import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { sanitizeForStderr } from "../sanitize.ts";

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const CAMEL_RE = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;
const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/;

function classify(name: string): string {
	if (KEBAB_RE.test(name)) return "kebab-case";
	if (SNAKE_RE.test(name)) return "snake_case";
	if (PASCAL_RE.test(name)) return "PascalCase";
	if (CAMEL_RE.test(name)) return "camelCase";
	return "other";
}

/** Detect naming convention drift for a new file. Returns warning strings. */
export function detectConventionDrift(file: string): string[] {
	const dir = dirname(file);
	const fileName = basename(file);
	const stem = basename(fileName, extname(fileName));

	let siblings: string[];
	try {
		siblings = readdirSync(dir)
			.filter((f) => {
				try {
					return f !== fileName && statSync(join(dir, f)).isFile();
				} catch {
					return false;
				}
			})
			.map((f) => basename(f, extname(f)));
	} catch {
		return [];
	}

	if (siblings.length < 3) return [];

	const counts = new Map<string, number>();
	for (const s of siblings) {
		const c = classify(s);
		if (c !== "other") counts.set(c, (counts.get(c) ?? 0) + 1);
	}

	let dominant: string | null = null;
	let dominantCount = 0;
	for (const [conv, count] of counts) {
		if (count > dominantCount) {
			dominant = conv;
			dominantCount = count;
		}
	}

	const classifiableCount = [...counts.values()].reduce((a, b) => a + b, 0);
	if (!dominant || classifiableCount === 0 || dominantCount <= classifiableCount * 0.5) return [];

	const fileConvention = classify(stem);
	if (fileConvention === dominant || fileConvention === "other") return [];

	return [
		sanitizeForStderr(
			`${fileName} uses ${fileConvention} but siblings use ${dominant} (${dominantCount}/${classifiableCount})`,
		),
	];
}
