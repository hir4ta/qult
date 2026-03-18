import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HookEvent } from './dispatcher.js';
import { openDefaultCached } from '../store/index.js';
import { Embedder } from '../embedder/index.js';
import { searchPipeline, trackHitCounts, truncate } from '../mcp/helpers.js';
import { readActiveState } from '../spec/types.js';
import type { DirectiveItem } from './directives.js';
import { emitDirectives } from './directives.js';

// Intent classification for skill nudge.
const INTENT_KEYWORDS: Record<string, string[]> = {
  research: ['research', 'investigate', 'understand', 'explore', 'learn', 'pattern', '調べ', '調査', '理解', '質問'],
  plan: ['plan', 'design', 'architect', 'how to', 'approach', 'アーキテクチャ', '設計', '計画'],
  implement: ['implement', 'add', 'create', 'build', 'refactor', '追加', '実装', 'リファクタ'],
  bugfix: ['fix', 'bug', 'error', 'broken', 'failing', '修正', 'バグ', 'エラー'],
  review: ['review', 'check', 'audit', 'inspect', 'レビュー', '確認'],
  tdd: ['test', 'tdd', 'spec', 'テスト'],
  'save-knowledge': ['remember', 'save', 'note', 'record', '覚え', '保存', 'メモ'],
};

const INTENT_TO_SKILL: Record<string, string> = {
  research: '/alfred:brief',
  plan: '/alfred:attend',
  implement: '/alfred:attend',
  bugfix: '/alfred:mend',
  review: '/alfred:inspect',
  tdd: '/alfred:tdd',
};

const INTENT_DESCRIPTIONS: Record<string, string> = {
  research: 'Investigating, researching, understanding code or concepts',
  plan: 'Planning, designing, architecting a solution or approach',
  implement: 'Implementing, adding, creating, building, refactoring code',
  bugfix: 'Fixing a bug, resolving an error, debugging a problem',
  review: 'Reviewing, checking, auditing, inspecting, validating code quality',
  tdd: 'Writing tests, test-driven development, creating test specs',
  'save-knowledge': 'Saving, remembering, recording information for later use',
};

export async function userPromptSubmit(ev: HookEvent, signal: AbortSignal): Promise<void> {
  if (!ev.prompt || !ev.cwd) return;

  const prompt = ev.prompt.trim();
  if (!prompt) return;

  let store;
  try { store = openDefaultCached(); } catch { return; }

  // Embed prompt once — reuse for intent classification + knowledge search.
  let emb: Embedder | null = null;
  let promptVec: number[] | null = null;
  try {
    emb = Embedder.create();
    promptVec = await emb.embedForSearch(prompt, signal);
  } catch { /* no Voyage key — FTS fallback */ }

  const items: DirectiveItem[] = [];

  // Intent classification: semantic (if Voyage) → keyword fallback.
  let intent: string | null = null;
  if (emb && promptVec) {
    intent = await classifyIntentSemantic(emb, promptVec, signal);
  }
  if (!intent) {
    intent = classifyIntent(prompt);
  }

  // FR-5: Spec creation enforcement.
  const specDirective = checkSpecRequired(ev.cwd, intent);
  if (specDirective) {
    items.push(specDirective);
  }

  // FR-1: Skill nudge with dismissal suppression.
  if (intent && intent !== 'save-knowledge') {
    const skill = INTENT_TO_SKILL[intent];
    if (skill) {
      const impressions = getNudgeImpressions(ev.cwd, intent);
      if (impressions < 3) {
        items.push({
          level: 'CONTEXT',
          message: `Skill suggestion: ${skill} — ${intentDescription(intent)}`,
        });
        // Track that we nudged this intent (will be checked next time).
        recordNudge(ev.cwd, intent);
      }
      // If dismissed 3+ times, suppress silently.
    }
  }

  // Knowledge search — reuse promptVec to avoid double Voyage API call (DEC-2).
  const limit = 5;
  const result = await searchPipeline(store, emb, prompt, limit, limit * 3, promptVec ?? undefined);

  // FR-2: Knowledge results with natural language relevance explanation.
  if (result.scoredDocs.length > 0) {
    trackHitCounts(store, result.scoredDocs);
    const contextLines = result.scoredDocs.map(sd => {
      const sub = sd.doc.subType !== 'snapshot' ? sd.doc.subType : '';
      const scoreStr = sd.score.toFixed(2);
      const prefix = sub ? `[${sub}|${scoreStr}|${sd.matchReason}]` : `[${scoreStr}|${sd.matchReason}]`;
      const explanation = buildRelevanceExplanation(sd);
      return `- ${prefix} ${sd.doc.title}: ${truncate(sd.doc.content, 150)}${explanation}`;
    });
    items.push({
      level: 'CONTEXT',
      message: 'Related knowledge:\n' + contextLines.join('\n'),
    });
  }

  emitDirectives('UserPromptSubmit', items);
}

/**
 * Semantic intent classification using Voyage embeddings.
 * Embeds intent descriptions in batch, compares with prompt vector.
 */
async function classifyIntentSemantic(
  emb: Embedder, promptVec: number[], signal: AbortSignal,
): Promise<string | null> {
  try {
    const intents = Object.keys(INTENT_DESCRIPTIONS);
    const descriptions = intents.map(k => INTENT_DESCRIPTIONS[k]!);
    // Intent descriptions embedded as documents, prompt as query — correct asymmetric usage
    // for Voyage's query-document embedding model.
    const intentVecs = await emb.embedBatchForStorage(descriptions, signal);

    let bestIntent = '';
    let bestScore = 0;
    for (let i = 0; i < intents.length; i++) {
      const score = cosineSim(promptVec, intentVecs[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intents[i]!;
      }
    }

    return bestScore >= 0.5 ? bestIntent : null;
  } catch {
    return null; // Voyage failure → fall through to keyword
  }
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function classifyIntent(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  let bestIntent = '';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  // save-knowledge suppresses research when both match.
  if (bestIntent === 'research') {
    let saveScore = 0;
    for (const kw of INTENT_KEYWORDS['save-knowledge']!) {
      if (lower.includes(kw)) saveScore++;
    }
    if (saveScore > 0) return 'save-knowledge';
  }

  return bestScore > 0 ? bestIntent : null;
}

/**
 * FR-5/FR-7: Check if spec is required or unapproved before implementation.
 * Stage 1: No spec exists → DIRECTIVE to create one.
 * Stage 2: Spec exists but not approved (M/L/XL) → DIRECTIVE to get review.
 */
export function checkSpecRequired(cwd: string, intent: string | null): DirectiveItem | null {
  if (!intent || !['implement', 'bugfix', 'tdd'].includes(intent)) return null;

  // Only enforce in alfred-initialized projects.
  if (!existsSync(join(cwd, '.alfred'))) return null;

  // Read active state once for both Stage 1 and Stage 2.
  let state;
  try {
    state = readActiveState(cwd);
  } catch {
    // Stage 1: No active spec (_active.md missing or unparseable).
    return {
      level: 'DIRECTIVE',
      message: 'MUST create a spec first via /alfred:brief or dossier action=init before implementing. No active spec found.',
      rationalizations: [
        '"I already have enough context to proceed" → Specs catch assumptions you don\'t know you\'re making',
        '"The spec would just restate the request" → Specs add structure, traceability, and test criteria',
        '"Creating a spec would slow things down" → S-size adds <2min. Bugs from no spec cost hours',
      ],
      spiritVsLetter: true,
    };
  }

  // Stage 2 (FR-7): Spec exists but not approved (M/L/XL only).
  try {
    const taskSlug = state.primary;
    const task = taskSlug ? state.tasks.find(t => t.slug === taskSlug) : undefined;
    if (task && ['M', 'L', 'XL'].includes(task.size ?? '') && task.review_status !== 'approved') {
      return {
        level: 'DIRECTIVE',
        message: `Spec '${taskSlug}' (size ${task.size}) requires review approval before implementation. Submit review via \`alfred dashboard\` or run spec self-review first.`,
        rationalizations: [
          '"The spec is obvious, review is overkill" → Review catches design bugs that waste 10x more implementation time',
          '"I\'ll fix issues during implementation" → The approval gate at complete will block you anyway',
          '"I already ran self-review mentally" → Self-review requires 3 parallel agents, not mental evaluation',
        ],
        spiritVsLetter: true,
      };
    }
  } catch { /* ignore parse errors — graceful fallback */ }

  return null;
}

function intentDescription(intent: string): string {
  switch (intent) {
    case 'research': return 'Research and investigation structuring';
    case 'plan': return 'Spec creation → approval → implementation';
    case 'implement': return 'Spec creation → approval → implementation';
    case 'bugfix': return 'Reproduce → analyze → fix → verify';
    case 'review': return '6-profile quality review';
    case 'tdd': return 'Red → Green → Refactor autonomous TDD';
    default: return '';
  }
}

// --- FR-1: Nudge dismissal tracking via .alfred/.state/ (survives across short-lived hook processes) ---

import { readStateJSON, writeStateJSON } from './state.js';

interface NudgeCounts {
  [intent: string]: { count: number; lastNudged: string };
}

/** Get how many times this intent's nudge was shown. Suppressed after 3 impressions. */
function getNudgeImpressions(cwd: string, intent: string): number {
  const counts = readStateJSON<NudgeCounts>(cwd, 'nudge-dismissals.json', {});
  return counts[intent]?.count ?? 0;
}

/** Record that we nudged this intent. If the user doesn't act on it, this counts as a dismissal. */
function recordNudge(cwd: string, intent: string): void {
  const counts = readStateJSON<NudgeCounts>(cwd, 'nudge-dismissals.json', {});
  const entry = counts[intent] ?? { count: 0, lastNudged: '' };
  entry.count++;
  entry.lastNudged = new Date().toISOString();
  counts[intent] = entry;
  writeStateJSON(cwd, 'nudge-dismissals.json', counts);
}

/** Reset nudge count for an intent (called when user actually follows the nudge). */
export function resetNudgeCount(cwd: string, intent: string): void {
  const counts = readStateJSON<NudgeCounts>(cwd, 'nudge-dismissals.json', {});
  delete counts[intent];
  writeStateJSON(cwd, 'nudge-dismissals.json', counts);
}

// --- FR-2: Natural language relevance explanation ---

import type { ScoredDoc } from '../mcp/helpers.js';
import { subTypeBoost } from '../store/fts.js';

function buildRelevanceExplanation(sd: ScoredDoc): string {
  const parts: string[] = [];

  // Search method explanation.
  if (sd.matchReason === 'vector+rerank') {
    parts.push('semantic match (reranked)');
  } else if (sd.matchReason === 'vector') {
    parts.push('semantic match');
  } else if (sd.matchReason === 'fts5') {
    parts.push('keyword match');
  }

  // Sub-type boost.
  const boost = subTypeBoost(sd.doc.subType);
  if (boost > 1.0) {
    parts.push(`${sd.doc.subType} boost ${boost}x`);
  }

  // Age context.
  const ageDays = Math.floor((Date.now() - Date.parse(sd.doc.createdAt)) / (1000 * 60 * 60 * 24));
  if (ageDays <= 1) {
    parts.push('today');
  } else if (ageDays <= 7) {
    parts.push(`${ageDays}d ago`);
  } else if (ageDays <= 30) {
    parts.push(`${Math.floor(ageDays / 7)}w ago`);
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
