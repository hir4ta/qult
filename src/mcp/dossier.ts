import { resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import {
  SpecDir, readActive, readActiveState, switchActive,
  completeTask, removeTask, reviewStatusFor, verifyReviewFile,
  filesForSize, VALID_SLUG,
} from '../spec/types.js';
import type { SpecFile, SpecSize, SpecType } from '../spec/types.js';
import { initSpec } from '../spec/init.js';
import { appendAudit } from '../spec/audit.js';
import { syncTaskStatus, unlinkTaskFromAllEpics } from '../epic/index.js';
import { searchPipeline, truncate } from './helpers.js';
import { writeKnowledgeFile } from './ledger.js';
import { upsertKnowledge } from '../store/knowledge.js';
import { detectProject } from '../store/project.js';
import type { KnowledgeRow, DecisionEntry } from '../types.js';
import { vectorSearchKnowledge } from '../store/vectors.js';
import { getKnowledgeByIDs } from '../store/knowledge.js';
import { searchKnowledgeFTS } from '../store/fts.js';
import { subTypeBoost } from '../store/fts.js';

interface DossierParams {
  action: string;
  project_path?: string;
  task_slug?: string;
  description?: string;
  file?: string;
  content?: string;
  mode?: string;
  size?: string;
  spec_type?: string;
  version?: string;
  confirm?: boolean;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

function resolveProjectPath(raw?: string): string {
  if (!raw) return process.cwd();
  const cleaned = resolve(raw);
  return cleaned;
}

export async function handleDossier(
  store: Store,
  emb: Embedder | null,
  params: DossierParams,
) {
  const projectPath = resolveProjectPath(params.project_path);

  switch (params.action) {
    case 'init': return dossierInit(projectPath, store, emb, params);
    case 'update': return dossierUpdate(projectPath, params);
    case 'status': return dossierStatus(projectPath);
    case 'switch': return dossierSwitch(projectPath, params);
    case 'complete': return dossierComplete(projectPath, store, params);
    case 'delete': return dossierDelete(projectPath, params);
    case 'history': return dossierHistory(projectPath, params);
    case 'rollback': return dossierRollback(projectPath, params);
    case 'review': return dossierReview(projectPath, params);
    case 'validate': return dossierValidate(projectPath, params);
    default: return errorResult(`unknown action: ${params.action}`);
  }
}

async function dossierInit(
  projectPath: string,
  store: Store,
  emb: Embedder | null,
  params: DossierParams,
) {
  if (!params.task_slug) return errorResult('task_slug is required for init');

  const sizeOpt = params.size ? (params.size.toUpperCase() as SpecSize) : undefined;
  const specTypeOpt = params.spec_type ? (params.spec_type.toLowerCase() as SpecType) : undefined;

  let initResult;
  try {
    initResult = initSpec(projectPath, params.task_slug, params.description ?? '', {
      size: sizeOpt,
      specType: specTypeOpt,
    });
  } catch (err) {
    return errorResult(`init failed: ${err}`);
  }

  appendAudit(projectPath, { action: 'spec.init', target: params.task_slug, detail: params.description, user: 'mcp' });

  const result: Record<string, unknown> = {
    task_slug: params.task_slug,
    spec_dir: initResult.specDir.dir(),
    size: initResult.size,
    spec_type: initResult.specType,
    files: initResult.files,
  };

  // Search related knowledge.
  if (params.description && emb) {
    const suggestions = await searchRelatedKnowledge(store, emb, params.description, 5);
    if (suggestions.length > 0) result['suggested_knowledge'] = suggestions;
  }

  // Steering context.
  const steeringDir = join(projectPath, '.alfred', 'steering');
  if (existsSync(join(steeringDir, 'product.md'))) {
    try {
      const summary = readFileSync(join(steeringDir, 'product.md'), 'utf-8').slice(0, 500);
      result['steering_context'] = summary;
    } catch { /* ignore */ }
  } else {
    result['steering_hint'] = 'project steering docs not found — run `/alfred:init` to set up project context';
  }

  if (params.description) {
    result['suggested_search'] = `Before writing specs, search past experience: ledger action=search query="${truncate(params.description, 80)}"`;
  }

  return jsonResult(result);
}

async function searchRelatedKnowledge(
  store: Store,
  emb: Embedder,
  description: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    const vec = await emb.embedForSearch(description);
    const matches = vectorSearchKnowledge(store, vec, limit * 3);
    if (matches.length > 0) {
      const ids = matches.map(m => m.sourceId);
      const scores = new Map(matches.map(m => [m.sourceId, m.score]));
      const docs = getKnowledgeByIDs(store, ids);
      return docs
        .map(d => ({
          label: d.title,
          source: d.subType,
          sub_type: d.subType,
          content: truncate(d.content, 500),
          relevance_score: Math.round((scores.get(d.id) ?? 0) * subTypeBoost(d.subType) * 100) / 100,
        }))
        .sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
        .slice(0, limit);
    }
  } catch { /* vector search failed, try FTS */ }

  try {
    const docs = searchKnowledgeFTS(store, description, limit);
    return docs.map((d, i) => ({
      label: d.title,
      source: d.subType,
      sub_type: d.subType,
      content: truncate(d.content, 500),
      relevance_score: Math.round((1.0 / (i + 1)) * subTypeBoost(d.subType) * 100) / 100,
    }));
  } catch { return []; }
}

function dossierUpdate(projectPath: string, params: DossierParams) {
  if (!params.file) return errorResult('file is required for update');
  if (!params.content) return errorResult('content is required for update');
  const mode = params.mode ?? 'append';

  // Resolve task slug.
  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  const sd = new SpecDir(projectPath, taskSlug);
  if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

  const file = params.file as SpecFile;
  try {
    if (mode === 'replace') {
      sd.writeFile(file, params.content);
    } else {
      sd.appendFile(file, params.content);
    }
  } catch (err) {
    return errorResult(`${mode} failed: ${err}`);
  }

  return jsonResult({ task_slug: taskSlug, file: params.file, mode });
}

function dossierStatus(projectPath: string) {
  let state;
  try { state = readActiveState(projectPath); } catch {
    return jsonResult({ active: false });
  }

  const taskSlug = state.primary;
  if (!taskSlug) return jsonResult({ active: false });

  const task = state.tasks.find(t => t.slug === taskSlug);
  const sd = new SpecDir(projectPath, taskSlug);

  const result: Record<string, unknown> = {
    active: true,
    task_slug: taskSlug,
    spec_dir: sd.dir(),
    lifecycle: task?.status ?? 'active',
    started_at: task?.started_at,
    size: task?.size ?? 'L',
    spec_type: task?.spec_type ?? 'feature',
    review_status: task?.review_status ?? 'pending',
  };
  if (task?.completed_at) result['completed_at'] = task.completed_at;

  result['lang'] = process.env['ALFRED_LANG'] || 'en';

  // Read all spec file contents.
  if (sd.exists()) {
    for (const section of sd.allSections()) {
      const key = section.file.replace('.md', '');
      result[key] = section.content;
    }
  }

  return jsonResult(result);
}

function dossierSwitch(projectPath: string, params: DossierParams) {
  if (!params.task_slug) return errorResult('task_slug is required for switch');
  try {
    switchActive(projectPath, params.task_slug);
  } catch (err) {
    return errorResult(`${err}`);
  }
  return jsonResult({ task_slug: params.task_slug, switched: true });
}

function dossierComplete(projectPath: string, store: Store, params: DossierParams) {
  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  // Approval gate for M+ specs.
  const state = readActiveState(projectPath);
  const task = state.tasks.find(t => t.slug === taskSlug);
  if (task) {
    const size = task.size ?? 'L';
    if (['M', 'L', 'XL'].includes(size)) {
      const reviewStatus = reviewStatusFor(projectPath, taskSlug);
      if (reviewStatus !== 'approved') {
        return errorResult(`completion requires review_status="approved" for ${size} specs (current: "${reviewStatus || 'pending'}"). Review in alfred dashboard.`);
      }
      // Verify review JSON file exists with approved status (FR-1).
      const verification = verifyReviewFile(projectPath, taskSlug);
      if (!verification.valid) {
        return errorResult(`approval gate: ${verification.reason}. Review in alfred dashboard.`);
      }
    }
  }

  // FR-3: Check closing wave completion.
  let closingWarning: string | undefined;
  try {
    const sd = new SpecDir(projectPath, taskSlug);
    const tasksContent = sd.readFile('tasks.md');
    closingWarning = checkClosingWave(tasksContent);
  } catch { /* tasks.md may not exist for all sizes */ }

  try {
    const newPrimary = completeTask(projectPath, taskSlug);
    appendAudit(projectPath, { action: 'spec.complete', target: taskSlug, user: 'mcp' });
    syncTaskStatus(projectPath, taskSlug, 'completed');

    // Auto-save decisions.md entries as permanent knowledge.
    saveDecisionsAsKnowledge(store, projectPath, taskSlug);

    const result: Record<string, unknown> = { task_slug: taskSlug, completed: true, new_primary: newPrimary };
    if (closingWarning) result['closing_wave_warning'] = closingWarning;
    return jsonResult(result);
  } catch (err) {
    return errorResult(`${err}`);
  }
}

function dossierDelete(projectPath: string, params: DossierParams) {
  if (!params.task_slug) return errorResult('task_slug is required for delete');

  const sd = new SpecDir(projectPath, params.task_slug);

  if (!params.confirm) {
    // Dry-run preview.
    const sections = sd.exists() ? sd.allSections() : [];
    return jsonResult({
      task_slug: params.task_slug,
      exists: sd.exists(),
      file_count: sections.length,
      files: sections.map(s => s.file),
      warning: 'This will permanently remove the spec directory. Pass confirm=true to proceed.',
    });
  }

  try {
    const allRemoved = removeTask(projectPath, params.task_slug);
    unlinkTaskFromAllEpics(projectPath, params.task_slug);
    appendAudit(projectPath, { action: 'spec.delete', target: params.task_slug, user: 'mcp' });
    return jsonResult({
      task_slug: params.task_slug,
      deleted: true,
      active_md_removed: allRemoved,
    });
  } catch (err) {
    return errorResult(`${err}`);
  }
}

function dossierHistory(projectPath: string, params: DossierParams) {
  if (!params.file) return errorResult('file is required for history');

  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  const sd = new SpecDir(projectPath, taskSlug);
  const histDir = join(sd.dir(), '.history');
  const file = params.file;

  let versions: Array<{ timestamp: string; size: number }> = [];
  try {
    const entries = readdirSync(histDir)
      .filter(e => e.startsWith(file + '.'))
      .sort()
      .reverse();
    versions = entries.map(e => {
      const ts = e.slice(file.length + 1);
      let size = 0;
      try { size = readFileSync(join(histDir, e), 'utf-8').length; } catch { /* ignore */ }
      return { timestamp: ts, size };
    });
  } catch { /* no history */ }

  return jsonResult({ task_slug: taskSlug, file, versions, count: versions.length });
}

function dossierRollback(projectPath: string, params: DossierParams) {
  if (!params.file) return errorResult('file is required for rollback');
  if (!params.version) return errorResult('version is required for rollback (use history to list versions)');

  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  const sd = new SpecDir(projectPath, taskSlug);
  const histDir = join(sd.dir(), '.history');
  const histPath = join(histDir, `${params.file}.${params.version}`);

  let content: string;
  try {
    content = readFileSync(histPath, 'utf-8');
  } catch {
    return errorResult(`version not found: ${params.version}`);
  }

  try {
    sd.writeFile(params.file as SpecFile, content);
  } catch (err) {
    return errorResult(`rollback failed: ${err}`);
  }

  return jsonResult({ task_slug: taskSlug, file: params.file, version: params.version, rolled_back: true });
}

function dossierReview(projectPath: string, params: DossierParams) {
  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  const status = reviewStatusFor(projectPath, taskSlug);

  // Check for review files.
  const sd = new SpecDir(projectPath, taskSlug);
  const reviewsDir = join(sd.dir(), 'reviews');
  let latestReview: unknown = null;
  let unresolvedCount = 0;

  try {
    const files = readdirSync(reviewsDir).filter(f => f.startsWith('review-')).sort().reverse();
    if (files[0]) {
      const reviewData = JSON.parse(readFileSync(join(reviewsDir, files[0]), 'utf-8'));
      latestReview = reviewData;
      if (Array.isArray(reviewData.comments)) {
        unresolvedCount = reviewData.comments.filter((c: { resolved?: boolean }) => !c.resolved).length;
      }
    }
  } catch { /* no reviews */ }

  return jsonResult({
    task_slug: taskSlug,
    review_status: status || 'pending',
    latest_review: latestReview,
    unresolved_count: unresolvedCount,
  });
}

function dossierValidate(projectPath: string, params: DossierParams) {
  let taskSlug = params.task_slug;
  if (!taskSlug) {
    try { taskSlug = readActive(projectPath); } catch (err) {
      return errorResult(`no active spec: ${err}`);
    }
  }

  // Placeholder: full 22-check validation will be implemented later.
  // For now, run basic structural checks.
  const sd = new SpecDir(projectPath, taskSlug);
  if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

  const state = readActiveState(projectPath);
  const task = state.tasks.find(t => t.slug === taskSlug);
  const size = (task?.size ?? 'L') as SpecSize;
  const specType = (task?.spec_type ?? 'feature') as SpecType;
  const expectedFiles = filesForSize(size, specType);

  const checks: Array<{ name: string; status: string; message: string }> = [];

  // Check required files exist.
  for (const f of expectedFiles) {
    try {
      sd.readFile(f);
      checks.push({ name: `file_exists:${f}`, status: 'pass', message: `${f} exists` });
    } catch {
      checks.push({ name: `file_exists:${f}`, status: 'fail', message: `${f} missing` });
    }
  }

  // Check closing wave in tasks.md.
  try {
    const tasksContent = sd.readFile('tasks.md');
    if (tasksContent.includes('## Wave: Closing') || tasksContent.includes('## Wave: closing')) {
      checks.push({ name: 'closing_wave', status: 'pass', message: 'Closing wave found in tasks.md' });
    } else {
      checks.push({ name: 'closing_wave', status: 'fail', message: 'No closing wave in tasks.md' });
    }
  } catch { /* tasks.md may not exist for all sizes */ }

  const passed = checks.filter(c => c.status === 'pass').length;
  return jsonResult({
    task_slug: taskSlug,
    size,
    spec_type: specType,
    checks,
    summary: `${passed}/${checks.length} checks passed`,
  });
}

/**
 * FR-3: Check if Closing Wave has at least 1 checked item.
 * Returns warning message if not, undefined if ok.
 */
function checkClosingWave(tasksContent: string): string | undefined {
  const closingIdx = tasksContent.search(/## Wave:\s*[Cc]losing/);
  if (closingIdx === -1) return 'No Closing Wave found in tasks.md. Add self-review, CLAUDE.md update, and test verification items.';

  const closingSection = tasksContent.slice(closingIdx);
  const nextSection = closingSection.indexOf('\n##', 1);
  const body = nextSection === -1 ? closingSection : closingSection.slice(0, nextSection);
  const checkedItems = body.match(/^- \[x\] .+$/gm);
  if (!checkedItems || checkedItems.length === 0) {
    return 'Closing Wave has no checked items. Complete self-review, CLAUDE.md update, and test verification before finishing.';
  }

  return undefined;
}

/**
 * Save accepted decisions from decisions.md as permanent knowledge entries.
 * Called on spec completion to persist architectural decisions.
 */
function saveDecisionsAsKnowledge(store: Store, projectPath: string, taskSlug: string): void {
  try {
    const sd = new SpecDir(projectPath, taskSlug);
    const decisions = sd.readFile('decisions.md');
    const proj = detectProject(projectPath);
    const lang = process.env['ALFRED_LANG'] || 'en';
    const now = new Date().toISOString();

    const sections = decisions.split(/\n## DEC-\d+/);
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i]!;
      const titleMatch = section.match(/^:\s*(.+)/);
      const title = titleMatch ? titleMatch[1]!.trim() : `Decision ${i}`;
      const statusMatch = section.match(/(?:- |\*\*)?Status:?\*?\*?\s*(\w+)/i);
      if (statusMatch && statusMatch[1]!.toLowerCase() === 'accepted') {
        // Parse structured fields from Markdown.
        const decisionMatch = section.match(/\*\*Decision:\*\*\s*(.+)/i);
        const reasoningMatch = section.match(/\*\*Rationale:\*\*\s*(.+)/i) ?? section.match(/\*\*Reasoning:\*\*\s*(.+)/i);
        const alternativesMatch = section.match(/\*\*Alternatives rejected:\*\*\s*(.+)/i);

        const entry: DecisionEntry = {
          id: `dec-spec-${taskSlug}-${i}`,
          title,
          context: (section.match(/\*\*Context:\*\*\s*(.+)/i)?.[1] ?? '').trim(),
          decision: (decisionMatch?.[1] ?? '').trim(),
          reasoning: (reasoningMatch?.[1] ?? '').trim(),
          alternatives: alternativesMatch
            ? alternativesMatch[1]!.split(/[;,]/).map(a => a.trim()).filter(Boolean)
            : [],
          tags: [taskSlug],
          createdAt: now,
          status: 'approved',
          lang,
        };

        // Write JSON file to disk (source of truth).
        const filePath = writeKnowledgeFile(projectPath, 'decision', entry.id, entry);

        const row: KnowledgeRow = {
          id: 0, filePath,
          contentHash: '', title,
          content: JSON.stringify(entry),
          subType: 'decision',
          projectRemote: proj.remote, projectPath: proj.path,
          projectName: proj.name, branch: proj.branch,
          createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
        };
        upsertKnowledge(store, row);
      }
    }
  } catch { /* decisions.md may not exist for all spec sizes */ }
}
