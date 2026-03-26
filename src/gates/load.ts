import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GatesConfig } from "../types.ts";

/** Load gates.json from .alfred/ directory. Returns null if not found (fail-open). */
export function loadGates(): GatesConfig | null {
	try {
		const path = join(process.cwd(), ".alfred", "gates.json");
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}
