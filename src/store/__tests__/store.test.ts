import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../index.js';
import { SCHEMA_VERSION } from '../schema.js';
import {
  upsertKnowledge, getKnowledgeByID, listKnowledge, deleteKnowledge,
  setKnowledgeEnabled, incrementHitCount, promoteSubType,
  getPromotionCandidates, searchKnowledgeKeyword, countKnowledge,
  contentHash, getKnowledgeStats,
} from '../knowledge.js';
import {
  insertEmbedding, vectorSearchKnowledge, cleanOrphanedEmbeddings,
  cosineSimilarity, serializeFloat32, deserializeFloat32,
} from '../vectors.js';
import { searchKnowledgeFTS, expandAliases, levenshtein, fuzzyMatch, subTypeHalfLife, subTypeBoost } from '../fts.js';
import { linkSession, resolveMasterSession, getSessionContinuity } from '../session-links.js';
import { detectProject, normalizeRemoteURL } from '../project.js';
import type { KnowledgeRow, SessionLink } from '../../types.js';

let store: Store;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alfred-test-'));
  store = Store.open(join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Store', () => {
  it('opens and migrates to V8', () => {
    expect(store.schemaVersionCurrent()).toBe(SCHEMA_VERSION);
  });

  it('opens same DB twice without error', () => {
    const store2 = Store.open(join(tmpDir, 'test.db'));
    expect(store2.schemaVersionCurrent()).toBe(SCHEMA_VERSION);
    store2.close();
  });
});

describe('Knowledge CRUD', () => {
  const makeRow = (overrides?: Partial<KnowledgeRow>): KnowledgeRow => ({
    id: 0,
    filePath: 'test.md',
    contentHash: '',
    title: 'Test Entry',
    content: 'This is test content',
    subType: 'general',
    projectRemote: 'github.com/user/repo',
    projectPath: '/tmp/repo',
    projectName: 'repo',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    hitCount: 0,
    lastAccessed: '',
    enabled: true,
    ...overrides,
  });

  it('upserts and retrieves knowledge', () => {
    const row = makeRow();
    const { id, changed } = upsertKnowledge(store, row);
    expect(id).toBeGreaterThan(0);
    expect(changed).toBe(true);

    const fetched = getKnowledgeByID(store, id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Test Entry');
    expect(fetched!.enabled).toBe(true);
  });

  it('skips update when content unchanged', () => {
    const row = makeRow();
    const { id: id1 } = upsertKnowledge(store, row);
    const { id: id2, changed } = upsertKnowledge(store, makeRow());
    expect(id2).toBe(id1);
    expect(changed).toBe(false);
  });

  it('updates when content changes', () => {
    const row = makeRow();
    upsertKnowledge(store, row);
    const { changed } = upsertKnowledge(store, makeRow({ content: 'Updated content' }));
    expect(changed).toBe(true);
  });

  it('deletes knowledge and its embeddings', () => {
    const row = makeRow();
    const { id } = upsertKnowledge(store, row);
    insertEmbedding(store, 'knowledge', id, 'test-model', [0.1, 0.2, 0.3]);

    deleteKnowledge(store, id);
    expect(getKnowledgeByID(store, id)).toBeUndefined();
  });

  it('lists knowledge for a project', () => {
    upsertKnowledge(store, makeRow({ filePath: 'a.md', title: 'A' }));
    upsertKnowledge(store, makeRow({ filePath: 'b.md', title: 'B' }));
    upsertKnowledge(store, makeRow({ filePath: 'c.md', title: 'C', projectPath: '/other' }));

    const rows = listKnowledge(store, 'github.com/user/repo', '/tmp/repo', 10);
    expect(rows).toHaveLength(2);
  });

  it('toggles enabled flag', () => {
    const row = makeRow();
    const { id } = upsertKnowledge(store, row);
    setKnowledgeEnabled(store, id, false);

    const fetched = getKnowledgeByID(store, id);
    expect(fetched!.enabled).toBe(false);
  });

  it('increments hit count', () => {
    const row = makeRow();
    const { id } = upsertKnowledge(store, row);
    incrementHitCount(store, [id]);

    const fetched = getKnowledgeByID(store, id);
    expect(fetched!.hitCount).toBe(1);
  });

  it('promotes sub_type', () => {
    const row = makeRow({ subType: 'general' });
    const { id } = upsertKnowledge(store, row);
    promoteSubType(store, id, 'pattern');

    const fetched = getKnowledgeByID(store, id);
    expect(fetched!.subType).toBe('pattern');
  });

  it('counts knowledge', () => {
    upsertKnowledge(store, makeRow({ filePath: 'a.md' }));
    upsertKnowledge(store, makeRow({ filePath: 'b.md' }));
    expect(countKnowledge(store, 'github.com/user/repo', '/tmp/repo')).toBe(2);
  });

  it('returns knowledge stats', () => {
    upsertKnowledge(store, makeRow({ filePath: 'a.md', subType: 'general' }));
    upsertKnowledge(store, makeRow({ filePath: 'b.md', subType: 'decision' }));
    const stats = getKnowledgeStats(store);
    expect(stats.total).toBe(2);
    expect(stats.bySubType['general']).toBe(1);
    expect(stats.bySubType['decision']).toBe(1);
    expect(stats.avgHitCount).toBe(0);
    expect(stats.topAccessed).toHaveLength(2);
  });

  it('content hash is deterministic', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('keyword search works', () => {
    upsertKnowledge(store, makeRow({ filePath: 'a.md', content: 'React hooks pattern' }));
    upsertKnowledge(store, makeRow({ filePath: 'b.md', content: 'Go concurrency' }));

    const results = searchKnowledgeKeyword(store, 'hooks', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('hooks');
  });
});

describe('Vectors', () => {
  it('serializes and deserializes float32', () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
    const blob = serializeFloat32(vec);
    const restored = deserializeFloat32(blob);
    expect(restored.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('validates dimensions on insert', () => {
    store.expectedDims = 3;
    expect(() => insertEmbedding(store, 'knowledge', 1, 'test', [0.1, 0.2])).toThrow('dimension mismatch');
  });

  it('vector search returns sorted results', () => {
    const row1: KnowledgeRow = {
      id: 0, filePath: 'a.md', contentHash: '', title: 'A', content: 'A',
      subType: 'general', projectRemote: '', projectPath: '/tmp', projectName: 'test',
      branch: '', createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
    };
    const row2 = { ...row1, filePath: 'b.md', title: 'B', content: 'B' };

    upsertKnowledge(store, row1);
    upsertKnowledge(store, row2);

    insertEmbedding(store, 'knowledge', row1.id, 'test', [1, 0, 0]);
    insertEmbedding(store, 'knowledge', row2.id, 'test', [0.9, 0.1, 0]);

    const results = vectorSearchKnowledge(store, [1, 0, 0], 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[results.length - 1]!.score);
  });

  it('cleans orphaned embeddings', () => {
    const row: KnowledgeRow = {
      id: 0, filePath: 'a.md', contentHash: '', title: 'A', content: 'A',
      subType: 'general', projectRemote: '', projectPath: '/tmp', projectName: 'test',
      branch: '', createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
    };
    const { id } = upsertKnowledge(store, row);
    insertEmbedding(store, 'knowledge', id, 'test', [0.1, 0.2, 0.3]);
    insertEmbedding(store, 'knowledge', 99999, 'test', [0.4, 0.5, 0.6]); // orphan

    const cleaned = cleanOrphanedEmbeddings(store);
    expect(cleaned).toBe(1);
  });
});

describe('FTS', () => {
  it('searches with FTS5', () => {
    upsertKnowledge(store, {
      id: 0, filePath: 'hooks.md', contentHash: '', title: 'React Hooks Guide',
      content: 'useCallback and useMemo patterns', subType: 'pattern',
      projectRemote: '', projectPath: '/tmp', projectName: 'test',
      branch: '', createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
    });

    const results = searchKnowledgeFTS(store, 'hooks', 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it('expands tag aliases', () => {
    const expanded = expandAliases(store, ['auth']);
    expect(expanded).toContain('auth');
    expect(expanded).toContain('authentication');
    expect(expanded).toContain('login');
    expect(expanded).toContain('認証');
  });

  it('sub type half life values', () => {
    expect(subTypeHalfLife('rule')).toBe(120);
    expect(subTypeHalfLife('general')).toBe(60);
    expect(subTypeHalfLife('assumption')).toBe(30);
  });

  it('sub type boost values', () => {
    expect(subTypeBoost('rule')).toBe(2.0);
    expect(subTypeBoost('decision')).toBe(1.5);
    expect(subTypeBoost('general')).toBe(1.0);
  });
});

describe('Levenshtein & fuzzy', () => {
  it('computes levenshtein distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abc', 'abd')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('fuzzy match works', () => {
    expect(fuzzyMatch('hooks', 'hook')).toBe(true);
    expect(fuzzyMatch('hooks', 'books')).toBe(true);
    expect(fuzzyMatch('ab', 'cd')).toBe(false); // too short
    expect(fuzzyMatch('react', 'angular')).toBe(false);
  });
});

describe('Session Links', () => {
  it('links and resolves sessions', () => {
    const link: SessionLink = {
      claudeSessionId: 'session-2',
      masterSessionId: 'session-1',
      projectRemote: '', projectPath: '/tmp', taskSlug: 'task-a',
      branch: 'main', linkedAt: '',
    };
    linkSession(store, link);

    const master = resolveMasterSession(store, 'session-2');
    expect(master).toBe('session-1');
  });

  it('follows session chains', () => {
    linkSession(store, {
      claudeSessionId: 'session-2', masterSessionId: 'session-1',
      projectRemote: '', projectPath: '/tmp', taskSlug: '', branch: '', linkedAt: '',
    });
    linkSession(store, {
      claudeSessionId: 'session-3', masterSessionId: 'session-2',
      projectRemote: '', projectPath: '/tmp', taskSlug: '', branch: '', linkedAt: '',
    });

    expect(resolveMasterSession(store, 'session-3')).toBe('session-1');
  });

  it('gets session continuity', () => {
    linkSession(store, {
      claudeSessionId: 'session-2', masterSessionId: 'session-1',
      projectRemote: '', projectPath: '/tmp', taskSlug: '', branch: '', linkedAt: '',
    });
    linkSession(store, {
      claudeSessionId: 'session-3', masterSessionId: 'session-1',
      projectRemote: '', projectPath: '/tmp', taskSlug: '', branch: '', linkedAt: '',
    });

    const sc = getSessionContinuity(store, 'session-1');
    expect(sc.compactCount).toBe(2);
    expect(sc.linkedSessions).toContain('session-2');
    expect(sc.linkedSessions).toContain('session-3');
  });
});

describe('Project', () => {
  it('normalizes remote URLs', () => {
    expect(normalizeRemoteURL('git@github.com:user/repo.git')).toBe('github.com/user/repo');
    expect(normalizeRemoteURL('https://github.com/user/repo.git')).toBe('github.com/user/repo');
    expect(normalizeRemoteURL('https://github.com/user/repo')).toBe('github.com/user/repo');
  });

  it('detects current project', () => {
    const info = detectProject(process.cwd());
    expect(info.path).toBeTruthy();
    expect(info.name).toBeTruthy();
  });
});
