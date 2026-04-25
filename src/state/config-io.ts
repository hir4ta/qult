/**
 * Shared `.qult/config.json` read/write helpers used by `qult init`,
 * `qult add-agent`, and `qult update`.
 *
 * Critical safety property: when the existing config is unparseable, the
 * caller must NOT silently overwrite it (doing so destroys user-set
 * `review.*` / `gates.*` overrides). `readConfigOrThrow` surfaces parse
 * errors so the CLI can refuse to proceed.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./fs.ts";
import { configJsonPath } from "./paths.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `.qult/config.json` as a plain object. Returns `{}` only if the file
 * does not exist; throws on parse failure or non-object top-level value.
 */
export function readConfigOrThrow(): Record<string, unknown> {
	const path = configJsonPath();
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf8");
	if (raw.trim().length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`refusing to overwrite ${path}: existing JSON is malformed (${(err as Error).message}). Fix or delete the file before re-running qult.`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`refusing to overwrite ${path}: top-level value is not an object`);
	}
	return parsed;
}

export type EnabledMode = "set" | "append";

/**
 * Update the `integrations.enabled` array in `.qult/config.json`.
 *
 * - `mode: "set"` replaces the list entirely (used by `qult init`).
 * - `mode: "append"` adds each key only if it is not already present
 *   (used by `qult add-agent`).
 *
 * Throws if the existing config cannot be safely round-tripped (preserves
 * user-set `review.*` / `gates.*` etc.).
 */
export function updateEnabledIntegrations(keys: string[], mode: EnabledMode): void {
	const raw = readConfigOrThrow();
	const ints = isPlainObject(raw.integrations) ? raw.integrations : ({} as Record<string, unknown>);
	const current = Array.isArray(ints.enabled)
		? (ints.enabled as unknown[]).filter((k): k is string => typeof k === "string")
		: [];
	let next: string[];
	if (mode === "set") {
		next = [...keys];
	} else {
		next = [...current];
		for (const k of keys) if (!next.includes(k)) next.push(k);
	}
	ints.enabled = next;
	raw.integrations = ints;
	atomicWrite(configJsonPath(), `${JSON.stringify(raw, null, 2)}\n`);
}

/** Read just the `integrations.enabled` list; returns `[]` when missing. */
export function readEnabledIntegrations(): string[] {
	let raw: Record<string, unknown>;
	try {
		raw = readConfigOrThrow();
	} catch {
		return [];
	}
	if (!isPlainObject(raw.integrations)) return [];
	const enabled = (raw.integrations as Record<string, unknown>).enabled;
	if (!Array.isArray(enabled)) return [];
	return enabled.filter((k): k is string => typeof k === "string");
}
