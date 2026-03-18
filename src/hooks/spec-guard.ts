import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractSection } from './dispatcher.js';

export interface SpecState {
  slug: string;
  size: string;
  reviewStatus: string;
  status: string;
}

/**
 * Read active spec state from _active.md. Returns null on any error (NFR-2: fail-open).
 */
export function tryReadActiveSpec(cwd: string | undefined): SpecState | null {
  if (!cwd) return null;
  try {
    const content = readFileSync(join(cwd, '.alfred', 'specs', '_active.md'), 'utf-8');
    // Parse YAML-like structure: primary + tasks array.
    let primary = '';
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('primary:')) {
        primary = line.slice(8).trim();
        break;
      }
    }
    if (!primary) return null;

    // Find the task entry for primary.
    let inTask = false;
    let slug = '', size = '', reviewStatus = '', status = '';
    for (const line of lines) {
      if (line.trim().startsWith('- slug:')) {
        const s = line.trim().slice(8).trim();
        inTask = s === primary;
        if (inTask) slug = s;
      } else if (inTask) {
        if (line.trim().startsWith('size:')) size = line.trim().slice(5).trim();
        else if (line.trim().startsWith('review_status:')) reviewStatus = line.trim().slice(14).trim();
        else if (line.trim().startsWith('status:')) status = line.trim().slice(7).trim();
        else if (line.trim().startsWith('- slug:')) break; // next task
      }
    }
    if (!slug) return null;
    return { slug, size, reviewStatus, status };
  } catch {
    return null; // NFR-2: fail-open
  }
}

/**
 * Check if file_path is under .alfred/ directory (spec/config files should not be blocked).
 */
export function isSpecFilePath(cwd: string | undefined, filePath: string): boolean {
  if (!cwd || !filePath) return false;
  const resolved = resolve(cwd, filePath);
  const alfredDir = join(cwd, '.alfred');
  return resolved.startsWith(alfredDir + '/') || resolved === alfredDir;
}

/**
 * Count unchecked Next Steps (`- [ ]`) in session.md.
 */
export function countUncheckedNextSteps(cwd: string | undefined, slug: string): number {
  if (!cwd) return 0;
  try {
    const session = readFileSync(join(cwd, '.alfred', 'specs', slug, 'session.md'), 'utf-8');
    const section = extractSection(session, '## Next Steps');
    if (!section) return 0;
    return (section.match(/^- \[ \] /gm) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Check if session.md has unchecked self-review items.
 */
export function hasUncheckedSelfReview(cwd: string | undefined, slug: string): boolean {
  if (!cwd) return false;
  try {
    const session = readFileSync(join(cwd, '.alfred', 'specs', slug, 'session.md'), 'utf-8');
    const section = extractSection(session, '## Next Steps');
    if (!section) return false;
    const lines = section.split('\n');
    return lines.some(line =>
      line.startsWith('- [ ] ') &&
      (/セルフレビュー/i.test(line) || /self-review/i.test(line)),
    );
  } catch {
    return false;
  }
}

/**
 * PreToolUse: deny tool via permissionDecision JSON (exit 0).
 */
export function denyTool(reason: string): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

/**
 * Stop: block Claude from stopping via decision JSON.
 */
export function blockStop(reason: string): void {
  const out = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(out) + '\n');
}
