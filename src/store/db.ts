/**
 * Database layer — bun:sqlite direct usage.
 */
import { Database } from "bun:sqlite";

/** Minimal statement interface covering what the store needs. */
export interface DbStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

/** Minimal database interface covering what the store needs. */
export interface DbDatabase {
	prepare(sql: string): DbStatement;
	exec(sql: string): void;
	transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
	close(): void;
}

/**
 * Open a SQLite database using bun:sqlite.
 */
export function openDatabaseSync(dbPath: string): DbDatabase {
	const db = new Database(dbPath);
	return {
		prepare(sql: string): DbStatement {
			const stmt = db.prepare(sql);
			return {
				run(...params: unknown[]) {
					return stmt.run(...(params as any[])) as { changes: number; lastInsertRowid: number | bigint };
				},
				get(...params: unknown[]) {
					return stmt.get(...(params as any[]));
				},
				all(...params: unknown[]) {
					return stmt.all(...(params as any[]));
				},
			};
		},
		exec(sql: string): void {
			db.run(sql);
		},
		transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
			return db.transaction(fn) as (...args: unknown[]) => T;
		},
		close(): void {
			db.close();
		},
	};
}

/**
 * Run a PRAGMA and return the result.
 */
export function pragma(db: DbDatabase, statement: string): unknown {
	return db.prepare(`PRAGMA ${statement}`).get();
}

/**
 * Set a PRAGMA (fire-and-forget).
 */
export function pragmaSet(db: DbDatabase, statement: string): void {
	db.exec(`PRAGMA ${statement}`);
}
