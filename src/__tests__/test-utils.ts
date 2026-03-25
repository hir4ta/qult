import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbDatabase } from "../store/db.js";
import { Store } from "../store/index.js";
import type { KnowledgeRowV1 as KnowledgeRow } from "../types.js";

export const TEST_PROJECT_ID = "test-project-id";

/** Insert a test project into the projects table. Accepts Store or raw Database. */
export function insertTestProject(
	storeOrDb: Store | DbDatabase,
	id = TEST_PROJECT_ID,
	path = "/test",
): string {
	const db = "db" in storeOrDb ? storeOrDb.db : storeOrDb;
	db.prepare(`
		INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
		VALUES (?, 'test', '', ?, '', datetime('now'), datetime('now'), 'active')
	`).run(id, path);
	return id;
}

/** Build a KnowledgeRow with sensible defaults, overridable. */
export function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0,
		filePath: "decisions/test.json",
		contentHash: "",
		title: "Test Entry",
		content: '{"id":"test","decision":"use X","reasoning":"because Y"}',
		subType: "decision",
		projectId: TEST_PROJECT_ID,
		branch: "main",
		createdAt: new Date().toISOString(),
		updatedAt: "",
		hitCount: 0,
		lastAccessed: "",
		enabled: true,
		author: "",
		...overrides,
	};
}

/** Parse MCP tool result JSON. */
export function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
	return JSON.parse(result.content[0]!.text);
}

/** Create a temp dir + Store, returning cleanup function. */
export function createTestEnv(prefix = "alfred-test-"): {
	tmpDir: string;
	store: Store;
	cleanup: () => void;
} {
	const tmpDir = mkdtempSync(join(tmpdir(), prefix));
	const store = Store.open(join(tmpDir, "test.db"));
	return {
		tmpDir,
		store,
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

/** Suppress stdout/stderr, capturing output. */
export function suppressIO(): {
	restore: () => void;
	stdout: string[];
	stderr: string[];
} {
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	const origOut = process.stdout.write;
	const origErr = process.stderr.write;
	process.stdout.write = ((chunk: string | Buffer) => {
		stdoutLines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Buffer) => {
		stderrLines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
		stdout: stdoutLines,
		stderr: stderrLines,
	};
}
