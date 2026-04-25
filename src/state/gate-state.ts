/**
 * File-based gate state — replaces the SQLite `disabled_gates` table.
 *
 * Stored in `.qult/state/gates.json`:
 * ```json
 * {
 *   "schema_version": 1,
 *   "disabled": [{ "gate": "test", "reason": "...", "disabled_at": "..." }]
 * }
 * ```
 *
 * Wave 3 migration target: `isGateDisabled` consumers (detectors and
 * mcp-server.ts handlers) read from here instead of session-state.ts.
 */

import { resolve } from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { qultDir } from "./paths.ts";

const SCHEMA_VERSION = 1;

export interface DisabledGate {
	gate: string;
	reason: string;
	disabled_at: string;
}

interface GateState {
	schema_version: number;
	disabled: DisabledGate[];
}

const DEFAULT_STATE: GateState = { schema_version: SCHEMA_VERSION, disabled: [] };

export function gatesJsonPath(): string {
	return resolve(qultDir(), "state", "gates.json");
}

export function readGateState(): GateState {
	const got = readJson<GateState>(gatesJsonPath(), SCHEMA_VERSION);
	return got ?? structuredClone(DEFAULT_STATE);
}

export function isGateDisabled(gateName: string): boolean {
	try {
		return readGateState().disabled.some((g) => g.gate === gateName);
	} catch {
		// Fail open — if state file is unreadable, treat the gate as enabled.
		return false;
	}
}

export function disableGate(
	gateName: string,
	reason: string,
	now: string = new Date().toISOString(),
): GateState {
	const cur = readGateState();
	const idx = cur.disabled.findIndex((g) => g.gate === gateName);
	if (idx >= 0) {
		cur.disabled[idx] = { gate: gateName, reason, disabled_at: now };
	} else {
		cur.disabled.push({ gate: gateName, reason, disabled_at: now });
	}
	writeJson(gatesJsonPath(), cur);
	return cur;
}

export function enableGate(gateName: string): GateState {
	const cur = readGateState();
	const next: GateState = {
		schema_version: SCHEMA_VERSION,
		disabled: cur.disabled.filter((g) => g.gate !== gateName),
	};
	writeJson(gatesJsonPath(), next);
	return next;
}

/** List currently-disabled gate names (used to enforce the per-session cap). */
export function listDisabledGateNames(): string[] {
	return readGateState().disabled.map((g) => g.gate);
}
