import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookEvent } from './dispatcher.js';
import { notifyUser, extractSection } from './dispatcher.js';
import { openDefaultCached } from '../store/index.js';
import { detectProject } from '../store/project.js';
import { upsertKnowledge, countKnowledge, getRecentDecisions } from '../store/knowledge.js';
import { readActive, readActiveState, SpecDir } from '../spec/types.js';
import type { KnowledgeRow } from '../types.js';
import type { DirectiveItem } from './directives.js';
import { emitDirectives } from './directives.js';
import { truncate } from '../mcp/helpers.js';

export async function sessionStart(ev: HookEvent, _signal: AbortSignal): Promise<void> {
  if (!ev.cwd) return;

  let store;
  try {
    store = openDefaultCached();
  } catch (err) {
    notifyUser('warning: store open failed: %s', err);
    return;
  }

  // Run independent operations (fail-open, synchronous — Node.js single-threaded).
  try { ingestProjectClaudeMD(store, ev.cwd); } catch (err) {
    notifyUser('warning: CLAUDE.md ingest failed: %s', err);
  }
  try { syncKnowledgeIndex(store, ev.cwd); } catch (err) {
    notifyUser('warning: knowledge sync failed: %s', err);
  }

  // Suggest /alfred:init if steering docs are missing.
  const steeringDir = join(ev.cwd, '.alfred', 'steering');
  if (!existsSync(join(steeringDir, 'product.md'))) {
    notifyUser('tip: run `/alfred:init` to set up project steering docs, templates, and knowledge index');
  }

  // Suggest ledger reflect when knowledge base has grown.
  suggestLedgerReflect(store);

  // Collect all directive items for single emit (NFR-4).
  const items: DirectiveItem[] = [];

  // FR-5: 1% rule — fires regardless of active spec, only needs .alfred/.
  if (existsSync(join(ev.cwd, '.alfred'))) {
    items.push({
      level: 'CONTEXT',
      message: 'If there is even a small chance an alfred skill applies to this task, invoke it. Check /alfred:concierge for available skills.',
    });
  }

  // Spec context + decision replay (returns items, does not emit).
  items.push(...buildSpecContextItems(ev.cwd, ev.source ?? '', store));

  if (items.length > 0) {
    emitDirectives('SessionStart', items);
  }
}

function ingestProjectClaudeMD(store: ReturnType<typeof openDefaultCached>, projectPath: string): void {
  const claudeMD = join(projectPath, 'CLAUDE.md');
  let content: string;
  try {
    content = readFileSync(claudeMD, 'utf-8');
  } catch { return; }

  const sections = splitMarkdownSections(content);
  if (sections.length === 0) return;

  const proj = detectProject(projectPath);
  for (const sec of sections) {
    const row: KnowledgeRow = {
      id: 0, filePath: `CLAUDE.md#${sec.path}`, contentHash: '', title: sec.path,
      content: sec.content, subType: 'project',
      projectRemote: proj.remote, projectPath: proj.path,
      projectName: proj.name, branch: proj.branch,
      createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
    };
    upsertKnowledge(store, row);
  }
}

function splitMarkdownSections(md: string): Array<{ path: string; content: string }> {
  const lines = md.split('\n');
  const sections: Array<{ path: string; content: string }> = [];
  let currentPath = '';
  let buf: string[] = [];

  const flush = () => {
    const content = buf.join('\n').trim();
    if (currentPath && content) {
      sections.push({ path: currentPath, content });
    }
    buf = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentPath = line.slice(3).trim();
    } else if (line.startsWith('# ') && !currentPath) {
      currentPath = line.slice(2).trim();
    } else if (currentPath) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function syncKnowledgeIndex(store: ReturnType<typeof openDefaultCached>, projectPath: string): void {
  const knowledgeDir = join(projectPath, '.alfred', 'knowledge');
  let files: string[];
  try {
    files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
  } catch { return; }

  if (files.length === 0) return;

  const proj = detectProject(projectPath);
  let synced = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(knowledgeDir, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const row: KnowledgeRow = {
        id: 0,
        filePath: file,
        contentHash: '',
        title: frontmatter.id ?? file.replace('.md', ''),
        content: body,
        subType: frontmatter.type ?? 'general',
        projectRemote: proj.remote,
        projectPath: proj.path,
        projectName: proj.name,
        branch: proj.branch,
        createdAt: frontmatter.created_at ?? '',
        updatedAt: '',
        hitCount: 0,
        lastAccessed: '',
        enabled: true,
      };
      const { changed } = upsertKnowledge(store, row);
      if (changed) synced++;
    } catch { continue; }
  }

  if (synced > 0) {
    notifyUser('synced %d knowledge files to index', synced);
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!content.startsWith('---')) return { frontmatter: fm, body: content };

  const end = content.indexOf('---', 3);
  if (end === -1) return { frontmatter: fm, body: content };

  const fmBlock = content.slice(3, end).trim();
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: content.slice(end + 3).trim() };
}

function suggestLedgerReflect(store: ReturnType<typeof openDefaultCached>): void {
  try {
    const count = countKnowledge(store, '', '');
    if (count < 20) return;
    notifyUser(
      'knowledge health: %d memories. Consider `ledger action=reflect` for a health report.',
      count,
    );
  } catch { /* ignore */ }
}

function buildSpecContextItems(projectPath: string, source: string, store: ReturnType<typeof openDefaultCached>): DirectiveItem[] {
  let taskSlug: string;
  try { taskSlug = readActive(projectPath); } catch { return []; }

  // Skip completed tasks.
  try {
    const state = readActiveState(projectPath);
    const task = state.tasks.find(t => t.slug === taskSlug);
    if (task?.status === 'completed') return [];
  } catch { /* ignore */ }

  const sd = new SpecDir(projectPath, taskSlug);
  if (!sd.exists()) return [];

  let buf = '';

  if (source === 'compact') {
    let session = '';
    try { session = sd.readFile('session.md'); } catch { return []; }
    const compactCount = (session.match(/## Compact Marker \[/g) ?? []).length;

    buf += `\n--- Alfred Protocol: Recovering Task '${taskSlug}' (post-compact #${compactCount}) ---\n`;

    if (compactCount <= 1) {
      buf += 'Full context recovery (first compact):\n\n';
      for (const section of sd.allSections()) {
        if (section.content.trim()) {
          buf += `### ${section.file}\n${section.content}\n\n`;
        }
      }
    } else {
      buf += 'Lightweight recovery (use dossier action=status for full spec):\n\n';
      buf += `### session.md\n${session}\n\n`;
    }

    buf += '--- End Alfred Protocol ---\n';

    const items: DirectiveItem[] = [{ level: 'CONTEXT', message: buf }];
    items.push(...injectRecentDecisions(store, projectPath));
    notifyUser("recovered task '%s' (compact #%d)", taskSlug, compactCount);
    return items;
  }

  // Normal startup/resume: adaptive context.
  let session: string;
  try { session = sd.readFile('session.md'); } catch { return []; }
  if (!session) return [];

  const proj = detectProject(projectPath);
  const memoryCount = countKnowledge(store, proj.remote, proj.path);

  buf += `\n--- Alfred Protocol: Active Task '${taskSlug}' ---\n`;

  if (memoryCount <= 5) {
    buf += '(Full context — new project)\n\n';
    for (const section of sd.allSections()) {
      if (section.content.trim()) {
        buf += `### ${section.file}\n${section.content}\n\n`;
      }
    }
  } else if (memoryCount <= 20) {
    buf += session + '\n';
    try {
      const req = sd.readFile('requirements.md');
      const goal = extractSection(req, '## Goal');
      if (goal) buf += '\nGoal: ' + goal + '\n';
    } catch { /* ignore */ }
  } else {
    buf += session + '\n';
  }

  buf += '--- End Alfred Protocol ---\n';

  const decisionItems = injectRecentDecisions(store, projectPath);
  const items: DirectiveItem[] = [
    { level: 'CONTEXT', message: buf },
    ...decisionItems,
  ];
  notifyUser("injected context for task '%s' (memories: %d, decisions: %d)", taskSlug, memoryCount, decisionItems.length);
  return items;
}

/**
 * FR-9: Search for recent decision-type knowledge entries and return as CONTEXT items.
 * Only fires when an active spec exists. Scoped to current project.
 */
function injectRecentDecisions(
  store: ReturnType<typeof openDefaultCached>,
  projectPath: string,
): DirectiveItem[] {
  // Guard: only inject if active spec exists.
  try { readActive(projectPath); } catch { return []; }

  const proj = detectProject(projectPath);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const rows = getRecentDecisions(store, proj.remote, proj.path, sevenDaysAgo, 5);
    if (rows.length === 0) return [];

    const lines = rows.map(r => `- ${r.title}: ${truncate(r.content, 150)}`);
    return [{
      level: 'CONTEXT',
      message: 'Recent decisions (last 7 days):\n' + lines.join('\n'),
    }];
  } catch { return []; }
}
