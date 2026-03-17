import type { Store } from './index.js';
import type { VectorMatch } from '../types.js';

const MIN_SIMILARITY = 0.3;
const DEFAULT_MAX_VECTOR_CANDIDATES = 10_000;
const EARLY_STOP_THRESHOLD = 0.7;

function envIntOrDefault(key: string, fallback: number): number {
  const v = process.env[key];
  if (v) {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}

export function insertEmbedding(
  store: Store,
  source: string,
  sourceId: number,
  model: string,
  vector: number[],
): void {
  if (store.expectedDims > 0 && vector.length !== store.expectedDims) {
    throw new Error(`store: insert embedding: dimension mismatch: got ${vector.length}, expected ${store.expectedDims}`);
  }
  const blob = serializeFloat32(vector);
  store.db.prepare(`
    INSERT OR REPLACE INTO embeddings (source, source_id, model, dims, vector)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, sourceId, model, vector.length, blob);
}

export function cleanOrphanedEmbeddings(store: Store): number {
  const result = store.db.prepare(`
    DELETE FROM embeddings WHERE source = 'knowledge'
    AND source_id NOT IN (SELECT id FROM knowledge_index)
  `).run();
  return result.changes;
}

export function vectorSearchKnowledge(
  store: Store,
  queryVec: number[],
  limit: number,
): VectorMatch[] {
  if (!queryVec || queryVec.length === 0) return [];
  if (limit <= 0) limit = 10;

  const maxCandidates = envIntOrDefault('ALFRED_MAX_VECTOR_CANDIDATES', DEFAULT_MAX_VECTOR_CANDIDATES);
  const earlyStopCount = Math.max(limit * 3, 50);

  const rows = store.db.prepare(`
    SELECT e.source_id, e.vector FROM embeddings e
    JOIN knowledge_index k ON k.id = e.source_id
    WHERE e.source = 'knowledge' AND k.enabled = 1
    LIMIT ?
  `).all(maxCandidates) as Array<{ source_id: number; vector: Buffer }>;

  const candidates: VectorMatch[] = [];
  let highQualityCount = 0;

  for (const row of rows) {
    const vec = deserializeFloat32(row.vector);
    if (vec.length !== queryVec.length) continue;

    const sim = cosineSimilarity(queryVec, vec);
    if (sim < MIN_SIMILARITY) continue;

    candidates.push({ sourceId: row.source_id, score: sim });
    if (sim >= EARLY_STOP_THRESHOLD) {
      highQualityCount++;
      if (highQualityCount >= earlyStopCount) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function serializeFloat32(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, i * 4);
  }
  return buf;
}

export function deserializeFloat32(blob: Buffer): number[] {
  const n = blob.length / 4;
  const vec: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    vec[i] = blob.readFloatLE(i * 4);
  }
  return vec;
}
