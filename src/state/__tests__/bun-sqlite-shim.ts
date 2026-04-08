/**
 * Compatibility shim: re-exports better-sqlite3 as bun:sqlite named exports.
 * Used by vitest (Node.js workers) via resolve.alias in vitest.config.ts.
 * Production code uses bun:sqlite directly (Bun runtime).
 */
import BetterSqlite3 from "better-sqlite3";

export const Database = BetterSqlite3;
