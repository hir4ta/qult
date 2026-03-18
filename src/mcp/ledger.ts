import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import { searchPipeline, trackHitCounts, truncate } from './helpers.js';
import { detectProject } from '../store/project.js';
import {
  upsertKnowledge, getKnowledgeByID, getPromotionCandidates,
  getKnowledgeStats, promoteSubType,
} from '../store/knowledge.js';
import { detectKnowledgeConflicts } from '../store/fts.js';
import type { KnowledgeRow, DecisionEntry, PatternEntry, RuleEntry } from '../types.js';
import { VALID_SUB_TYPES } from '../types.js';

interface LedgerParams {
  action: string;
  id?: number;
  query?: string;
  label?: string;
  limit?: number;
  detail?: string;
  sub_type?: string;
  title?: string;
  // Decision fields
  decision?: string;
  reasoning?: string;
  alternatives?: string;
  context_text?: string;
  // Pattern fields
  pattern_type?: string;
  pattern?: string;
  application_conditions?: string;
  expected_outcomes?: string;
  // Rule fields
  key?: string;
  text?: string;
  category?: string;
  priority?: string;
  rationale?: string;
  source_ref?: string;
  // Common
  tags?: string;
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

// --- Search ---

async function ledgerSearch(store: Store, emb: Embedder | null, params: LedgerParams) {
  const query = params.query ?? '';
  const lang = process.env['ALFRED_LANG'] || 'en';
  let limit = params.limit ?? 10;
  const detail = params.detail ?? 'summary';
  const warnings: string[] = [];

  if (limit > 100) { limit = 100; warnings.push('limit capped to 100'); }
  if (!query.trim()) return errorResult('query is required for search');

  const overRetrieve = Math.max(limit * 3, 30);
  const result = await searchPipeline(store, emb, query, limit, overRetrieve);
  warnings.push(...result.warnings);

  let scored = result.scoredDocs;
  if (params.sub_type) {
    scored = scored.filter(sd => sd.doc.subType === params.sub_type);
  }
  // Exclude snapshots from search results.
  scored = scored.filter(sd => sd.doc.subType !== 'snapshot');

  trackHitCounts(store, scored);

  const results = scored.map(sd => ({
    ...formatDoc(sd.doc, detail),
    relevance_score: sd.score,
    match_reason: sd.matchReason,
  }));

  return jsonResult({
    query, results, count: results.length,
    search_method: result.searchMethod,
    lang,
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  });
}

function formatDoc(d: KnowledgeRow, detail: string) {
  const base: Record<string, unknown> = { title: d.title, sub_type: d.subType };
  if (detail === 'compact') return base;

  base['file_path'] = d.filePath;
  base['saved_at'] = d.createdAt;

  // Try parsing JSON content for structured display.
  if (detail === 'full' || detail === 'summary') {
    try {
      const parsed = JSON.parse(d.content);
      if (d.subType === 'decision') {
        base['decision'] = parsed.decision;
        base['reasoning'] = detail === 'full' ? parsed.reasoning : truncate(parsed.reasoning ?? '', 200);
        if (detail === 'full' && parsed.alternatives) base['alternatives'] = parsed.alternatives;
        if (parsed.tags) base['tags'] = parsed.tags;
      } else if (d.subType === 'pattern') {
        base['pattern_type'] = parsed.type;
        base['pattern'] = detail === 'full' ? parsed.pattern : truncate(parsed.pattern ?? '', 200);
        if (detail === 'full') {
          base['application_conditions'] = parsed.applicationConditions;
          base['expected_outcomes'] = parsed.expectedOutcomes;
        }
        if (parsed.tags) base['tags'] = parsed.tags;
      } else if (d.subType === 'rule') {
        base['key'] = parsed.key;
        base['text'] = parsed.text;
        base['priority'] = parsed.priority;
        if (detail === 'full') {
          base['rationale'] = parsed.rationale;
          base['source_ref'] = parsed.sourceRef;
        }
        if (parsed.tags) base['tags'] = parsed.tags;
      } else {
        // Fallback for snapshot or unknown types.
        base['content'] = detail === 'full' ? d.content : truncate(d.content, 200);
      }
    } catch {
      // Legacy plain text content — fallback.
      base['content'] = detail === 'full' ? d.content : truncate(d.content, 200);
    }
  }
  return base;
}

// --- Save ---

function toLang(): string {
  return process.env['ALFRED_LANG'] || 'en';
}

function toKebabId(prefix: string, title: string): string {
  // Try ASCII slug first; fall back to hash for non-ASCII titles.
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-$/, '');
  if (ascii.length >= 3) return `${prefix}-${ascii}`;
  // Non-ASCII fallback: use short hash of original title.
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

/**
 * Atomic write: write to temp file then rename (POSIX atomic).
 */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + process.pid;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/**
 * Write knowledge entry JSON to .alfred/knowledge/{type}/{id}.json.
 * Exported for use by dossier saveDecisionsAsKnowledge.
 */
export function writeKnowledgeFile(projectPath: string, subType: string, id: string, entry: unknown): string {
  const typeDir = subType === 'decision' ? 'decisions' : subType === 'pattern' ? 'patterns' : 'rules';
  const knowledgeDir = join(projectPath, '.alfred', 'knowledge', typeDir);
  mkdirSync(knowledgeDir, { recursive: true });
  const filePath = join(typeDir, `${id}.json`);
  atomicWriteSync(join(projectPath, '.alfred', 'knowledge', filePath), JSON.stringify(entry, null, 2) + '\n');
  return filePath;
}

function parseTags(tagsStr: string | undefined): string[] {
  return (tagsStr ?? '').split(',').map(t => t.trim()).filter(Boolean);
}

async function ledgerSave(store: Store, emb: Embedder | null, params: LedgerParams) {
  const subType = params.sub_type;
  if (!subType || !(VALID_SUB_TYPES as readonly string[]).includes(subType)) {
    return errorResult('sub_type must be decision, pattern, or rule');
  }
  if (!params.title) return errorResult('title is required for save');
  if (!params.label) return errorResult('label is required for save');

  const now = new Date().toISOString();
  const lang = toLang();
  const tags = parseTags(params.tags);
  let entry: DecisionEntry | PatternEntry | RuleEntry;
  let id: string;

  switch (subType) {
    case 'decision': {
      if (!params.decision) return errorResult('decision field is required for decision type');
      if (!params.reasoning) return errorResult('reasoning field is required for decision type');
      id = toKebabId('dec', params.title);
      entry = {
        id, title: params.title,
        context: params.context_text ?? '',
        decision: params.decision,
        reasoning: params.reasoning,
        alternatives: (params.alternatives ?? '').split('\n').filter(Boolean),
        tags, createdAt: now, status: 'approved', lang,
      } satisfies DecisionEntry;
      break;
    }
    case 'pattern': {
      if (!params.pattern) return errorResult('pattern field is required for pattern type');
      id = toKebabId('pat', params.title);
      entry = {
        id, title: params.title,
        type: (params.pattern_type as PatternEntry['type']) ?? 'good',
        context: params.context_text ?? '',
        pattern: params.pattern,
        applicationConditions: params.application_conditions ?? '',
        expectedOutcomes: params.expected_outcomes ?? '',
        tags, createdAt: now, status: 'approved', lang,
      } satisfies PatternEntry;
      break;
    }
    case 'rule': {
      if (!params.text) return errorResult('text field is required for rule type');
      if (!params.key) return errorResult('key field is required for rule type');
      id = toKebabId('rule', params.title);
      let sourceRef: RuleEntry['sourceRef'];
      if (params.source_ref) {
        try { sourceRef = JSON.parse(params.source_ref); } catch { /* ignore */ }
      }
      entry = {
        id, title: params.title,
        key: params.key, text: params.text,
        category: params.category ?? '',
        priority: (params.priority as RuleEntry['priority']) ?? 'p1',
        rationale: params.rationale ?? '',
        sourceRef, tags, createdAt: now, status: 'approved', lang,
      } satisfies RuleEntry;
      break;
    }
    default:
      return errorResult('sub_type must be decision, pattern, or rule');
  }

  // Write JSON file to .alfred/knowledge/{type}/{id}.json (atomic).
  const projectPath = params.project_path ?? process.cwd();
  const filePath = writeKnowledgeFile(projectPath, subType, id, entry);

  // DB upsert for search index.
  const projInfo = detectProject(projectPath);
  const row: KnowledgeRow = {
    id: 0, filePath,
    contentHash: '', title: params.title,
    content: JSON.stringify(entry),
    subType,
    projectRemote: projInfo.remote, projectPath: projInfo.path,
    projectName: projInfo.name, branch: projInfo.branch,
    createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
  };
  const { id: dbId, changed } = upsertKnowledge(store, row);

  // Async embedding.
  let embeddingStatus = 'none';
  if (emb && changed) {
    const model = emb.model;
    const embText = `${params.title} ${params.context_text ?? ''} ${params.decision ?? params.pattern ?? params.text ?? ''}`;
    emb.embedForStorage(embText).then(async (vec) => {
      const { insertEmbedding } = await import('../store/vectors.js');
      insertEmbedding(store, 'knowledge', dbId, model, vec);
    }).catch(err => {
      console.error(`[alfred] embedding failed for ${dbId}: ${err}`);
    });
    embeddingStatus = 'pending';
  }

  return jsonResult({
    status: changed ? 'saved' : 'unchanged (duplicate)',
    id: dbId, entry_id: id, title: params.title,
    file_path: filePath, embedding_status: embeddingStatus, lang,
  });
}

// --- Promote ---

async function ledgerPromote(store: Store, params: LedgerParams) {
  if (!params.id) return errorResult('id is required for promote');
  if (!params.sub_type) return errorResult('sub_type is required for promote');
  if (params.sub_type !== 'rule') return errorResult('promotion target must be "rule" (pattern→rule only)');

  const doc = getKnowledgeByID(store, params.id);
  if (!doc) return errorResult(`knowledge ${params.id} not found`);
  if (doc.subType !== 'pattern') return errorResult('only patterns can be promoted to rules');

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

// --- Candidates ---

async function ledgerCandidates(store: Store) {
  const candidates = getPromotionCandidates(store);
  const results = candidates.map(d => ({
    id: d.id, title: d.title, hit_count: d.hitCount,
    current: d.subType, suggested: 'rule',
  }));
  return jsonResult({ candidates: results, count: results.length });
}

// --- Reflect ---

async function ledgerReflect(store: Store, emb: Embedder | null, _params: LedgerParams) {
  const stats = getKnowledgeStats(store);
  const candidates = getPromotionCandidates(store);
  const lang = toLang();

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
        if (c.type === 'potential_contradiction') contradictions.push(entry);
        else duplicates.push(entry);
      }
    } catch (err) {
      console.error(`[alfred] conflict detection failed: ${err}`);
    }
  }

  const promotionCandidates = candidates.map(d => ({
    id: d.id, title: d.title, hit_count: d.hitCount,
    current: d.subType, suggested: 'rule',
  }));

  return jsonResult({
    summary: {
      total_memories: stats.total,
      by_sub_type: stats.bySubType,
      avg_hit_count: Math.round(stats.avgHitCount * 100) / 100,
      most_accessed: stats.topAccessed.map(d => ({
        title: d.title, hit_count: d.hitCount, sub_type: d.subType,
      })),
    },
    duplicates, contradictions, promotion_candidates: promotionCandidates, lang,
  });
}
