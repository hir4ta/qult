import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync, statSync } from 'node:fs';
import { stringify, parse } from 'yaml';

export type SpecFile = 'requirements.md' | 'design.md' | 'tasks.md' | 'test-specs.md' |
  'decisions.md' | 'research.md' | 'session.md' | 'bugfix.md' | 'delta.md';
export type SpecSize = 'S' | 'M' | 'L' | 'XL' | 'D';
export type SpecType = 'feature' | 'bugfix' | 'delta';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | '';

export const VALID_SLUG = /^[a-z0-9][a-z0-9\-]{0,63}$/;

export interface ActiveTask {
  slug: string;
  started_at: string;
  status?: string;
  completed_at?: string;
  review_status?: ReviewStatus;
  size?: SpecSize;
  spec_type?: SpecType;
}

export interface ActiveState {
  primary: string;
  tasks: ActiveTask[];
}

export interface Section {
  file: SpecFile;
  content: string;
  url: string;
}

export interface InitResult {
  specDir: SpecDir;
  size: SpecSize;
  specType: SpecType;
  files: SpecFile[];
}

export function parseSize(s: string): SpecSize {
  const upper = s.toUpperCase();
  if (['S', 'M', 'L', 'XL', 'D'].includes(upper)) return upper as SpecSize;
  throw new Error(`invalid spec size "${s}" (valid: S, M, L, XL, D)`);
}

export function parseSpecType(s: string): SpecType {
  const lower = s.toLowerCase();
  if (lower === '' || lower === 'feature') return 'feature';
  if (lower === 'bugfix') return 'bugfix';
  if (lower === 'delta') return 'delta';
  throw new Error(`invalid spec type "${s}" (valid: feature, bugfix, delta)`);
}

export function detectSize(description: string): SpecSize {
  const n = [...description].length;
  if (n < 100) return 'S';
  if (n < 300) return 'M';
  return 'L';
}

export function filesForSize(size: SpecSize, specType: SpecType): SpecFile[] {
  if (size === 'D') return ['delta.md', 'session.md'];

  const primary: SpecFile = specType === 'bugfix' ? 'bugfix.md' : 'requirements.md';
  switch (size) {
    case 'S': return [primary, 'tasks.md', 'session.md'];
    case 'M':
      if (specType === 'bugfix') return [primary, 'tasks.md', 'test-specs.md', 'session.md'];
      return [primary, 'design.md', 'tasks.md', 'test-specs.md', 'session.md'];
    default: // L, XL
      return [primary, 'design.md', 'tasks.md', 'test-specs.md', 'decisions.md', 'research.md', 'session.md'];
  }
}

// Path helpers
export function rootDir(projectPath: string): string { return join(projectPath, '.alfred'); }
export function specsDir(projectPath: string): string { return join(projectPath, '.alfred', 'specs'); }
export function activePath(projectPath: string): string { return join(projectPath, '.alfred', 'specs', '_active.md'); }

export class SpecDir {
  readonly projectPath: string;
  readonly taskSlug: string;

  constructor(projectPath: string, taskSlug: string) {
    this.projectPath = projectPath;
    this.taskSlug = taskSlug;
  }

  dir(): string { return join(specsDir(this.projectPath), this.taskSlug); }
  filePath(f: SpecFile): string { return join(this.dir(), f); }
  exists(): boolean {
    try { return statSync(this.dir()).isDirectory(); } catch { return false; }
  }

  readFile(f: SpecFile): string {
    return readFileSync(this.filePath(f), 'utf-8');
  }

  writeFile(f: SpecFile, content: string): void {
    this.saveHistory(f);
    this.writeFileRaw(f, content);
  }

  appendFile(f: SpecFile, content: string): void {
    let existing = '';
    try { existing = readFileSync(this.filePath(f), 'utf-8'); } catch { /* file may not exist */ }
    this.writeFile(f, existing + content);
  }

  private writeFileRaw(f: SpecFile, content: string): void {
    const path = this.filePath(f);
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }

  private saveHistory(f: SpecFile): void {
    try {
      const path = this.filePath(f);
      if (!existsSync(path)) return;
      const histDir = join(this.dir(), '.history');
      mkdirSync(histDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const histPath = join(histDir, `${f}.${ts}`);
      const content = readFileSync(path, 'utf-8');
      writeFileSync(histPath, content);
      // Purge old versions (keep max 20).
      const entries = readdirSync(histDir)
        .filter(e => e.startsWith(f + '.'))
        .sort();
      while (entries.length > 20) {
        const old = entries.shift()!;
        try { rmSync(join(histDir, old)); } catch { /* best effort */ }
      }
    } catch { /* fail-open: history save errors don't prevent writes */ }
  }

  allSections(): Section[] {
    const projectBase = basename(this.projectPath);
    const allFiles: SpecFile[] = [
      'requirements.md', 'design.md', 'tasks.md', 'test-specs.md',
      'decisions.md', 'research.md', 'session.md', 'bugfix.md', 'delta.md',
    ];
    const sections: Section[] = [];
    for (const f of allFiles) {
      try {
        const content = this.readFile(f);
        const url = `spec://${projectBase}/${this.taskSlug}/${f}`;
        sections.push({ file: f, content, url });
      } catch { /* skip missing files */ }
    }
    return sections;
  }
}

// _active.md management

export function readActive(projectPath: string): string {
  const state = readActiveState(projectPath);
  if (!state.primary) throw new Error('no primary task in _active.md');
  return state.primary;
}

export function readActiveState(projectPath: string): ActiveState {
  const path = activePath(projectPath);
  let data: string;
  try {
    data = readFileSync(path, 'utf-8');
  } catch {
    throw new Error('read _active.md: file not found');
  }

  // Try YAML first.
  try {
    const state = parse(data) as ActiveState;
    if (state?.primary) return state;
  } catch { /* fall through to legacy */ }

  // Legacy format.
  let slug = '', startedAt = '';
  for (const line of data.split('\n')) {
    if (line.startsWith('task: ')) slug = line.slice(6);
    if (line.startsWith('started_at: ')) startedAt = line.slice(12);
  }
  if (!slug) throw new Error('no task field in _active.md');
  return { primary: slug, tasks: [{ slug, started_at: startedAt }] };
}

export function writeActiveState(projectPath: string, state: ActiveState): void {
  mkdirSync(specsDir(projectPath), { recursive: true });
  const data = stringify(state);
  writeFileSync(activePath(projectPath), data);
}

export function switchActive(projectPath: string, taskSlug: string): void {
  const state = readActiveState(projectPath);
  const task = state.tasks.find(t => t.slug === taskSlug);
  if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
  if (task.status === 'completed') throw new Error(`task "${taskSlug}" is completed`);
  state.primary = taskSlug;
  writeActiveState(projectPath, state);
}

export function completeTask(projectPath: string, taskSlug: string): string {
  const state = readActiveState(projectPath);
  const task = state.tasks.find(t => t.slug === taskSlug);
  if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
  if (task.status === 'completed') throw new Error(`task "${taskSlug}" is already completed`);
  task.status = 'completed';
  task.completed_at = new Date().toISOString();

  if (state.primary === taskSlug) {
    state.primary = state.tasks.find(t => t.status !== 'completed' && t.slug !== taskSlug)?.slug ?? '';
  }
  writeActiveState(projectPath, state);
  return state.primary;
}

export function setReviewStatus(projectPath: string, taskSlug: string, status: ReviewStatus): void {
  const state = readActiveState(projectPath);
  const task = state.tasks.find(t => t.slug === taskSlug);
  if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
  task.review_status = status;
  writeActiveState(projectPath, state);
}

export function reviewStatusFor(projectPath: string, taskSlug: string): ReviewStatus {
  try {
    const state = readActiveState(projectPath);
    return state.tasks.find(t => t.slug === taskSlug)?.review_status ?? '';
  } catch {
    return '';
  }
}

export interface ReviewVerification {
  valid: boolean;
  reason: string;
}

/**
 * Verify that a valid review JSON file exists with status=approved and zero unresolved comments.
 * Does NOT read _active.md (no overlap with reviewStatusFor).
 *
 * Legacy mode: if reviews/ directory is absent → valid (backward compat).
 * If reviews/ exists but is empty → invalid.
 */
export function verifyReviewFile(projectPath: string, taskSlug: string): ReviewVerification {
  const reviewsDir = join(specsDir(projectPath), taskSlug, 'reviews');

  // Legacy mode: no reviews/ directory = pre-enforcement era.
  if (!existsSync(reviewsDir)) {
    return { valid: true, reason: 'legacy: no reviews/ directory' };
  }

  let files: string[];
  try {
    files = readdirSync(reviewsDir)
      .filter(f => f.startsWith('review-') && f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return { valid: false, reason: 'failed to read reviews/ directory' };
  }

  if (files.length === 0) {
    return { valid: false, reason: 'no review JSON files found in reviews/' };
  }

  // Parse the latest review file.
  const latestFile = files[0]!;
  let reviewData: { status?: string; comments?: Array<{ resolved?: boolean }> };
  try {
    reviewData = JSON.parse(readFileSync(join(reviewsDir, latestFile), 'utf-8'));
  } catch {
    return { valid: false, reason: `failed to parse ${latestFile}` };
  }

  if (reviewData.status !== 'approved') {
    return { valid: false, reason: `latest review status is "${reviewData.status ?? 'unknown'}", not "approved"` };
  }

  // Check for unresolved comments (missing resolved field → treated as unresolved).
  if (Array.isArray(reviewData.comments)) {
    const unresolved = reviewData.comments.filter(c => !c.resolved).length;
    if (unresolved > 0) {
      return { valid: false, reason: `${unresolved} unresolved review comment(s) remain` };
    }
  }

  return { valid: true, reason: `verified via ${latestFile}` };
}

export function removeTask(projectPath: string, taskSlug: string): boolean {
  const state = readActiveState(projectPath);
  const filtered = state.tasks.filter(t => t.slug !== taskSlug);
  if (filtered.length === state.tasks.length) {
    throw new Error(`task "${taskSlug}" not found in _active.md`);
  }

  const sd = new SpecDir(projectPath, taskSlug);
  if (sd.exists()) {
    rmSync(sd.dir(), { recursive: true, force: true });
  }

  if (filtered.length === 0) {
    try { rmSync(activePath(projectPath)); } catch { /* ignore */ }
    return true;
  }

  state.tasks = filtered;
  if (state.primary === taskSlug) {
    state.primary = filtered[0]!.slug;
  }
  writeActiveState(projectPath, state);
  return false;
}
