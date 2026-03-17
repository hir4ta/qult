import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from 'node:fs';
import { stringify, parse } from 'yaml';
import { VALID_SLUG } from '../spec/types.js';

export function epicsDir(projectPath: string): string {
  return join(projectPath, '.alfred', 'epics');
}

function epicActivePath(projectPath: string): string {
  return join(epicsDir(projectPath), '_active.yaml');
}

export const STATUS_DRAFT = 'draft';
export const STATUS_IN_PROGRESS = 'in-progress';
export const STATUS_COMPLETED = 'completed';
export const STATUS_BLOCKED = 'blocked';
export const STATUS_ARCHIVED = 'archived';
export const STATUS_NOT_STARTED = 'not-started';

export interface Epic {
  name: string;
  status: string;
  created_at: string;
  tasks?: EpicTask[];
}

export interface EpicTask {
  slug: string;
  status: string;
  depends_on?: string[];
}

interface ActiveEpics {
  primary?: string;
  epics?: string[];
}

export interface EpicSummary {
  slug: string;
  name: string;
  status: string;
  completed: number;
  total: number;
  tasks: EpicTask[];
}

export class EpicDir {
  readonly projectPath: string;
  readonly slug: string;

  constructor(projectPath: string, slug: string) {
    this.projectPath = projectPath;
    this.slug = slug;
  }

  dir(): string { return join(epicsDir(this.projectPath), this.slug); }
  epicPath(): string { return join(this.dir(), 'epic.yaml'); }
  exists(): boolean {
    try { return statSync(this.dir()).isDirectory(); } catch { return false; }
  }

  read(): Epic {
    const data = readFileSync(this.epicPath(), 'utf-8');
    return parse(data) as Epic;
  }

  save(ep: Epic): void {
    const data = stringify(ep);
    const tmp = this.epicPath() + '.tmp';
    writeFileSync(tmp, data);
    renameSync(tmp, this.epicPath());
  }

  link(taskSlug: string, dependsOn: string[]): void {
    const ep = this.read();
    const tasks = ep.tasks ?? [];

    if (tasks.some(t => t.slug === taskSlug)) {
      throw new Error(`task "${taskSlug}" already linked to epic "${this.slug}"`);
    }
    const taskSet = new Set(tasks.map(t => t.slug));
    for (const dep of dependsOn) {
      if (!taskSet.has(dep)) {
        throw new Error(`dependency "${dep}" not found in epic "${this.slug}"`);
      }
    }

    tasks.push({ slug: taskSlug, status: STATUS_NOT_STARTED, depends_on: dependsOn.length > 0 ? dependsOn : undefined });
    ep.tasks = tasks;
    if (ep.status === STATUS_DRAFT) ep.status = STATUS_IN_PROGRESS;
    this.save(ep);
  }

  unlink(taskSlug: string): void {
    const ep = this.read();
    const tasks = ep.tasks ?? [];
    const idx = tasks.findIndex(t => t.slug === taskSlug);
    if (idx === -1) throw new Error(`task "${taskSlug}" not linked to epic "${this.slug}"`);

    tasks.splice(idx, 1);
    // Remove dangling dependency references.
    for (const t of tasks) {
      if (t.depends_on) {
        t.depends_on = t.depends_on.filter(d => d !== taskSlug);
        if (t.depends_on.length === 0) t.depends_on = undefined;
      }
    }
    ep.tasks = tasks;
    this.save(ep);
  }

  progress(): { completed: number; total: number } {
    const ep = this.read();
    const tasks = ep.tasks ?? [];
    const completed = tasks.filter(t => t.status === STATUS_COMPLETED).length;
    return { completed, total: tasks.length };
  }
}

export function initEpic(projectPath: string, slug: string, name: string): EpicDir {
  if (!VALID_SLUG.test(slug)) {
    throw new Error(`invalid epic_slug "${slug}": must be lowercase alphanumeric with hyphens`);
  }
  const ed = new EpicDir(projectPath, slug);
  if (ed.exists()) throw new Error(`epic already exists: ${slug}`);

  mkdirSync(ed.dir(), { recursive: true });
  const ep: Epic = {
    name,
    status: STATUS_DRAFT,
    created_at: new Date().toISOString(),
  };
  ed.save(ep);

  // Update _active.yaml.
  let state: ActiveEpics;
  try { state = readActiveEpics(projectPath); } catch { state = {}; }
  const epics = state.epics ?? [];
  if (!epics.includes(slug)) epics.push(slug);
  state.epics = epics;
  if (!state.primary) state.primary = slug;
  writeActiveEpics(projectPath, state);

  return ed;
}

export function topologicalOrder(tasks: EpicTask[]): string[] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    if (!inDeg.has(t.slug)) inDeg.set(t.slug, 0);
    for (const dep of t.depends_on ?? []) {
      adj.set(dep, [...(adj.get(dep) ?? []), t.slug]);
      inDeg.set(t.slug, (inDeg.get(t.slug) ?? 0) + 1);
    }
  }

  const queue = tasks.filter(t => (inDeg.get(t.slug) ?? 0) === 0).map(t => t.slug).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    const neighbors = (adj.get(cur) ?? []).sort();
    for (const next of neighbors) {
      const deg = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (order.length !== tasks.length) throw new Error('dependency cycle detected');
  return order;
}

export function nextActionable(tasks: EpicTask[]): string[] {
  const statusMap = new Map(tasks.map(t => [t.slug, t.status]));
  return tasks
    .filter(t => t.status === STATUS_NOT_STARTED && (t.depends_on ?? []).every(d => statusMap.get(d) === STATUS_COMPLETED))
    .map(t => t.slug);
}

export function listAllEpics(projectPath: string): EpicSummary[] {
  const dir = epicsDir(projectPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch { return []; }

  const summaries: EpicSummary[] = [];
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    try {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
    } catch { continue; }

    const ed = new EpicDir(projectPath, entry);
    try {
      const ep = ed.read();
      const tasks = ep.tasks ?? [];
      const completed = tasks.filter(t => t.status === STATUS_COMPLETED).length;
      summaries.push({ slug: entry, name: ep.name, status: ep.status, completed, total: tasks.length, tasks });
    } catch { continue; }
  }
  return summaries;
}

export function removeEpic(projectPath: string, slug: string): void {
  const ed = new EpicDir(projectPath, slug);
  if (!ed.exists()) throw new Error(`epic "${slug}" not found`);
  rmSync(ed.dir(), { recursive: true, force: true });

  try {
    const state = readActiveEpics(projectPath);
    state.epics = (state.epics ?? []).filter(e => e !== slug);
    if (state.primary === slug) {
      state.primary = state.epics[0] ?? '';
    }
    writeActiveEpics(projectPath, state);
  } catch { /* best effort */ }
}

export function unlinkTaskFromAllEpics(projectPath: string, taskSlug: string): void {
  for (const s of listAllEpics(projectPath)) {
    if (s.tasks.some(t => t.slug === taskSlug)) {
      const ed = new EpicDir(projectPath, s.slug);
      try { ed.unlink(taskSlug); } catch { /* best effort */ }
    }
  }
}

export function syncTaskStatus(projectPath: string, taskSlug: string, newStatus: string): boolean {
  for (const s of listAllEpics(projectPath)) {
    const task = s.tasks.find(t => t.slug === taskSlug);
    if (!task) continue;
    if (task.status === newStatus) return false;

    const ed = new EpicDir(projectPath, s.slug);
    try {
      const ep = ed.read();
      const tasks = ep.tasks ?? [];
      const target = tasks.find(t => t.slug === taskSlug);
      if (target) target.status = newStatus;

      // Auto-update epic status.
      const allCompleted = tasks.length > 0 && tasks.every(t => t.status === STATUS_COMPLETED);
      const anyInProgress = tasks.some(t => t.status === STATUS_IN_PROGRESS);
      if (allCompleted) ep.status = STATUS_COMPLETED;
      else if (anyInProgress) ep.status = STATUS_IN_PROGRESS;

      ed.save(ep);
      return true;
    } catch { return false; }
  }
  return false;
}

function readActiveEpics(projectPath: string): ActiveEpics {
  const data = readFileSync(epicActivePath(projectPath), 'utf-8');
  return parse(data) as ActiveEpics;
}

function writeActiveEpics(projectPath: string, state: ActiveEpics): void {
  mkdirSync(epicsDir(projectPath), { recursive: true });
  const data = stringify(state);
  const path = epicActivePath(projectPath);
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
