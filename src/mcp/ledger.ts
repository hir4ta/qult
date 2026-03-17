import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import { searchPipeline, trackHitCounts, truncate } from './helpers.js';
import { detectProject } from '../store/project.js';
import {
  upsertKnowledge, getKnowledgeByID, getPromotionCandidates,
  getKnowledgeStats, promoteSubType,
} from '../store/knowledge.js';
import { detectKnowledgeConflicts } from '../store/fts.js';
import type { KnowledgeRow } from '../types.js';

interface LedgerParams {
  action: string;
  id?: number;
  query?: string;
  content?: string;
  label?: string;
  project?: string;
  limit?: number;
  detail?: string;
  sub_type?: string;
  title?: string;
  context_text?: string;
  reasoning?: string;
  alternatives?: string;
  category?: string;
  priority?: string;
  project_path?: string;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

export async function handleLedger(
  store: Store,
  emb: Embedder | null,
  params: LedgerParams,
) {
  switch (params.action) {
    case 'search': return ledgerSearch(store, emb, params);
    case 'save': return ledgerSave(store, emb, params);
    case 'promote': return ledgerPromote(store, params);
    case 'candidates': return ledgerCandidates(store);
    case 'reflect': return ledgerReflect(store, emb, params);
    case 'stale': return jsonResult({ message: 'feature removed in schema V8' });
    case 'audit-conventions': return jsonResult({ status: 'not_implemented' });
    default: return errorResult(`unknown action: ${params.action}`);
  }
}

async function ledgerSearch(store: Store, emb: Embedder | null, params: LedgerParams) {
  const query = params.query ?? '';
  let limit = params.limit ?? 10;
  const detail = params.detail ?? 'summary';
  const warnings: string[] = [];

  if (limit > 100) {
    limit = 100;
    warnings.push('limit capped to 100');
  }
  if (!query.trim()) {
    return errorResult('query is required for search');
  }

  const overRetrieve = Math.max(limit * 3, 30);
  const result = await searchPipeline(store, emb, query, limit, overRetrieve);
  warnings.push(...result.warnings);

  let docs = result.docs;
  if (params.sub_type) {
    docs = docs.filter(d => d.subType === params.sub_type);
  }

  trackHitCounts(store, docs);

  const results = docs.map(d => formatDoc(d, detail));

  return jsonResult({
    query,
    results,
    count: results.length,
    search_method: result.searchMethod,
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  });
}

function formatDoc(d: KnowledgeRow, detail: string) {
  const base: Record<string, unknown> = { title: d.title };
  if (d.subType !== 'general') base['sub_type'] = d.subType;
  if (detail === 'compact') return base;

  base['file_path'] = d.filePath;
  base['saved_at'] = d.createdAt;

  if (detail === 'full') {
    base['content'] = d.content;
  } else {
    base['content'] = truncate(d.content, 200);
  }
  return base;
}

async function ledgerSave(store: Store, emb: Embedder | null, params: LedgerParams) {
  if (!params.content) return errorResult('content is required for save');
  if (!params.label) return errorResult('label is required for save');

  const project = params.project ?? 'general';
  const subType = params.sub_type ?? 'general';
  const projectPath = params.project_path ?? process.cwd();
  const projInfo = detectProject(projectPath);

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
  const filePath = `memories/${project}/manual/${ts}`;
  const title = `${project} > manual > ${params.label}`;

  const row: KnowledgeRow = {
    id: 0,
    filePath,
    contentHash: '',
    title,
    content: params.content,
    subType,
    projectRemote: projInfo.remote,
    projectPath: projInfo.path,
    projectName: projInfo.name,
    branch: projInfo.branch,
    createdAt: '',
    updatedAt: '',
    hitCount: 0,
    lastAccessed: '',
    enabled: true,
  };

  const { id, changed } = upsertKnowledge(store, row);

  let embeddingStatus = 'none';
  if (emb && changed) {
    const model = emb.model;
    emb.embedForStorage(params.content).then(async (vec) => {
      const { insertEmbedding } = await import('../store/vectors.js');
      insertEmbedding(store, 'knowledge', id, model, vec);
    }).catch(err => {
      console.error(`[alfred] embedding failed for ${id}: ${err}`);
    });
    embeddingStatus = 'pending';
  }

  return jsonResult({
    status: changed ? 'saved' : 'unchanged (duplicate)',
    id,
    title,
    file_path: filePath,
    embedding_status: embeddingStatus,
  });
}

async function ledgerPromote(store: Store, params: LedgerParams) {
  if (!params.id) return errorResult('id is required for promote');
  if (!params.sub_type) return errorResult('sub_type is required for promote');

  const doc = getKnowledgeByID(store, params.id);
  if (!doc) return errorResult(`knowledge ${params.id} not found`);

  try {
    promoteSubType(store, params.id, params.sub_type);
  } catch (err) {
    return errorResult(`promote failed: ${err}`);
  }

  return jsonResult({
    id: params.id,
    previous_sub_type: doc.subType,
    new_sub_type: params.sub_type,
    title: doc.title,
  });
}

async function ledgerCandidates(store: Store) {
  const candidates = getPromotionCandidates(store);
  const results = candidates.map(d => ({
    id: d.id,
    title: d.title,
    hit_count: d.hitCount,
    current: d.subType,
    suggested: d.subType === 'general' ? 'pattern' : 'rule',
  }));

  return jsonResult({ candidates: results, count: results.length });
}

async function ledgerReflect(store: Store, emb: Embedder | null, params: LedgerParams) {
  const stats = getKnowledgeStats(store);
  const candidates = getPromotionCandidates(store);

  let duplicates: Array<Record<string, unknown>> = [];
  let contradictions: Array<Record<string, unknown>> = [];

  if (emb) {
    try {
      const conflicts = detectKnowledgeConflicts(store);
      for (const c of conflicts) {
        const entry = {
          doc_a: truncate(c.a.title, 60),
          doc_b: truncate(c.b.title, 60),
          similarity: Math.round(c.similarity * 100) / 100,
          type: c.type,
        };
        if (c.type === 'potential_contradiction') {
          contradictions.push(entry);
        } else {
          duplicates.push(entry);
        }
      }
    } catch (err) {
      // Conflict detection is best-effort.
      console.error(`[alfred] conflict detection failed: ${err}`);
    }
  }

  const promotionCandidates = candidates.map(d => ({
    id: d.id,
    title: d.title,
    hit_count: d.hitCount,
    current: d.subType,
    suggested: d.subType === 'general' ? 'pattern' : 'rule',
  }));

  return jsonResult({
    summary: {
      total_memories: stats.total,
      by_sub_type: stats.bySubType,
      avg_hit_count: Math.round(stats.avgHitCount * 100) / 100,
      most_accessed: stats.topAccessed.map(d => ({
        title: d.title,
        hit_count: d.hitCount,
        sub_type: d.subType,
      })),
    },
    duplicates,
    contradictions,
    promotion_candidates: promotionCandidates,
  });
}
