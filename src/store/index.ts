import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrate, SCHEMA_VERSION } from './schema.js';

export class Store {
  readonly db: Database.Database;
  readonly dbPath: string;
  expectedDims = 0;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static open(dbPath: string): Store {
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000');
    db.pragma('mmap_size = 268435456');
    db.pragma('temp_store = MEMORY');

    const uv = db.pragma('user_version', { simple: true }) as number;
    if (uv !== SCHEMA_VERSION) {
      migrate(db);
    }

    return new Store(db, dbPath);
  }

  static openDefault(): Store {
    return Store.open(defaultDBPath());
  }

  close(): void {
    this.db.close();
  }

  schemaVersionCurrent(): number {
    try {
      const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
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

export function defaultDBPath(): string {
  return join(homedir(), '.claude-alfred', 'alfred.db');
}
