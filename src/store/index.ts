import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DbDatabase, openDatabaseSync, pragmaSet } from "./db.js";
import { migrate, SCHEMA_VERSION } from "./schema.js";

export class Store {
	readonly db: DbDatabase;
	readonly dbPath: string;
	expectedDims = 0;

	private constructor(db: DbDatabase, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	static open(dbPath: string): Store {
		mkdirSync(dirname(dbPath), { recursive: true });

		const db = openDatabaseSync(dbPath);

		pragmaSet(db, "journal_mode = WAL");
		pragmaSet(db, "foreign_keys = ON");
		pragmaSet(db, "synchronous = NORMAL");
		pragmaSet(db, "cache_size = -8000");
		pragmaSet(db, "mmap_size = 268435456");
		pragmaSet(db, "temp_store = MEMORY");

		const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
		const uv = row?.user_version ?? 0;
		if (uv !== SCHEMA_VERSION) {
			migrate(db);
		}

		const store = new Store(db, dbPath);
		store.initExpectedDims();
		return store;
	}

	/**
	 * Initialize expectedDims from existing embeddings.
	 * If multiple dimensions exist (model migration), warn and use the most common.
	 */
	private initExpectedDims(): void {
		try {
			const rows = this.db
				.prepare("SELECT dims, COUNT(*) as cnt FROM embeddings GROUP BY dims ORDER BY cnt DESC LIMIT 2")
				.all() as Array<{ dims: number; cnt: number }>;
			if (rows.length === 0) return;
			this.expectedDims = rows[0]!.dims;
			if (rows.length > 1) {
				process.stderr.write(
					`[alfred] WARNING: mixed embedding dimensions detected (${rows.map((r) => `${r.dims}d×${r.cnt}`).join(", ")}). ` +
					`Using ${this.expectedDims}d. Consider re-embedding with a single model.\n`,
				);
			}
		} catch {
			/* fail-open: don't block startup */
		}
	}

	static openDefault(): Store {
		return Store.open(defaultDBPath());
	}

	close(): void {
		this.db.close();
	}

	schemaVersionCurrent(): number {
		try {
			const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
				| { version: number }
				| undefined;
			return row?.version ?? 0;
		} catch {
			return 0;
		}
	}
}

let cachedStore: Store | undefined;

export function openDefaultCached(): Store {
	if (!cachedStore) {
		cachedStore = Store.openDefault();
	}
	return cachedStore;
}

/** @internal Test-only: override the cached store instance */
export function _setStoreForTest(s: Store | undefined): void {
	cachedStore = s;
}

export function defaultDBPath(): string {
	return join(homedir(), ".claude-alfred", "alfred.db");
}
