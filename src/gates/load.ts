import { getDb, getProjectId } from "../state/db.ts";
import type { GateDefinition, GatesConfig } from "../types.ts";

// Process-scoped cache (read-only, no dirty flag needed)
let _cache: GatesConfig | null | undefined;

/** Load gates from DB for the current project. Returns null if not found (fail-open). */
export function loadGates(): GatesConfig | null {
	if (_cache !== undefined) return _cache;
	try {
		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare(
				"SELECT phase, gate_name, command, timeout, run_once_per_batch, extensions FROM gate_configs WHERE project_id = ?",
			)
			.all(projectId) as {
			phase: string;
			gate_name: string;
			command: string;
			timeout: number | null;
			run_once_per_batch: number;
			extensions: string | null;
		}[];

		if (rows.length === 0) {
			_cache = null;
			return null;
		}

		const config: GatesConfig = {};
		for (const row of rows) {
			const phase = row.phase as keyof GatesConfig;
			if (!config[phase]) config[phase] = {};
			const gate: GateDefinition = { command: row.command };
			if (row.timeout !== null) gate.timeout = row.timeout;
			if (row.run_once_per_batch) gate.run_once_per_batch = true;
			if (row.extensions) {
				try {
					gate.extensions = JSON.parse(row.extensions);
				} catch {
					/* ignore invalid JSON */
				}
			}
			config[phase]![row.gate_name] = gate;
		}

		_cache = config;
		return config;
	} catch {
		_cache = null;
		return null;
	}
}

/** Write detected gates to DB for the current project. */
export function saveGates(gates: GatesConfig): void {
	const db = getDb();
	const projectId = getProjectId();

	db.exec("BEGIN");
	try {
		db.prepare("DELETE FROM gate_configs WHERE project_id = ?").run(projectId);
		const insert = db.prepare(
			"INSERT INTO gate_configs (project_id, phase, gate_name, command, timeout, run_once_per_batch, extensions) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		for (const [phase, gateMap] of Object.entries(gates)) {
			if (!gateMap) continue;
			for (const [name, gate] of Object.entries(gateMap) as [string, GateDefinition][]) {
				insert.run(
					projectId,
					phase,
					name,
					gate.command,
					gate.timeout ?? null,
					gate.run_once_per_batch ? 1 : 0,
					gate.extensions ? JSON.stringify(gate.extensions) : null,
				);
			}
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}

	// Invalidate cache
	_cache = undefined;
}

/** Reset cache — for testing only. */
export function resetGatesCache(): void {
	_cache = undefined;
}
