import type { KnowledgeRow } from '../types.js';
import { subTypeHalfLife, subTypeBoost, searchKnowledgeFTS } from '../store/fts.js';
import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import { vectorSearchKnowledge } from '../store/vectors.js';
import { getKnowledgeByIDs, incrementHitCount, searchKnowledgeKeyword } from '../store/knowledge.js';

const RECENCY_FLOOR = 0.5;

export function truncate(s: string, maxLen: number): string {
  const runes = [...s];
  if (runes.length <= maxLen) return s;
  return runes.slice(0, maxLen).join('') + '...';
}

export function recencyFactor(createdAt: string, subType: string, now: Date): number {
  const halfLife = subTypeHalfLife(subType);
  if (halfLife <= 0) return 1.0;

  const parsed = Date.parse(createdAt);
  if (isNaN(parsed)) return 1.0;

  const ageDays = (now.getTime() - parsed) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;

  const factor = Math.exp(-Math.LN2 * ageDays / halfLife);
  return factor < RECENCY_FLOOR ? RECENCY_FLOOR : factor;
}

export function applyRecencySignal(docs: KnowledgeRow[], now: Date): KnowledgeRow[] {
  if (docs.length === 0) return docs;

  const scored = docs.map((doc, i) => {
    const posScore = 1.0 / (i + 1);
    const rf = recencyFactor(doc.createdAt, doc.subType, now);
    const stb = subTypeBoost(doc.subType);
    return { doc, score: posScore * rf * stb };
  });

  if (scored.length > 1) {
    scored.sort((a, b) => b.score - a.score);
  }

  return scored.map(s => s.doc);
}

export interface SearchResult {
  docs: KnowledgeRow[];
  searchMethod: string;
  warnings: string[];
}

export async function searchPipeline(
  store: Store,
  emb: Embedder | null,
  query: string,
  limit: number,
  overRetrieve: number,
): Promise<SearchResult> {
  const res: SearchResult = { docs: [], searchMethod: '', warnings: [] };

  if (emb) {
    try {
      const queryVec = await emb.embedForSearch(query);
      const matches = vectorSearchKnowledge(store, queryVec, overRetrieve);
      if (matches.length > 0) {
        const ids = matches.map(m => m.sourceId);
        const docs = getKnowledgeByIDs(store, ids);
        // Preserve vector similarity ordering.
        const docMap = new Map(docs.map(d => [d.id, d]));
        const ordered: KnowledgeRow[] = [];
        for (const id of ids) {
          const d = docMap.get(id);
          if (d) ordered.push(d);
        }
        res.docs = ordered;
        res.searchMethod = 'vector';

        // Rerank if we have more results than needed.
        if (res.docs.length > limit) {
          try {
            const contents = res.docs.map(d => d.title + '\n' + d.content);
            const reranked = await emb.rerank(query, contents, limit);
            if (reranked.length > 0) {
              const reorderedDocs: KnowledgeRow[] = [];
              for (const r of reranked) {
                if (r.index >= 0 && r.index < res.docs.length) {
                  reorderedDocs.push(res.docs[r.index]!);
                }
              }
              res.docs = reorderedDocs;
              res.searchMethod = 'vector+rerank';
            }
          } catch (err) {
            res.warnings.push(`rerank failed: ${err}`);
          }
        }
      }
    } catch (err) {
      res.warnings.push(`vector embedding failed: ${err}`);
    }
  }

  // Fallback to FTS5 search if no vector results.
  if (res.docs.length === 0) {
    res.searchMethod = 'fts5';
    try {
      res.docs = searchKnowledgeFTS(store, query, limit);
    } catch (err) {
      res.warnings.push(`fts5 search failed: ${err}`);
      res.searchMethod = 'keyword';
      try {
        res.docs = searchKnowledgeKeyword(store, query, limit);
      } catch (err2) {
        res.warnings.push(`keyword search failed: ${err2}`);
      }
    }
  }

  // Apply recency signal.
  res.docs = applyRecencySignal(res.docs, new Date());

  if (res.docs.length > limit) {
    res.docs = res.docs.slice(0, limit);
  }

  return res;
}

export function trackHitCounts(store: Store, docs: KnowledgeRow[]): void {
  if (docs.length === 0) return;
  const ids = docs.filter(d => d.id > 0).map(d => d.id);
  incrementHitCount(store, ids);
}
