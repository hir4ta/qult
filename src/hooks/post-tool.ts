import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookEvent } from './dispatcher.js';
import { notifyUser } from './dispatcher.js';
import { openDefaultCached } from '../store/index.js';
import { searchKnowledgeFTS, detectKnowledgeConflicts } from '../store/fts.js';
import { readActive, SpecDir } from '../spec/types.js';
import { truncate } from '../mcp/helpers.js';
import { extractSection } from './dispatcher.js';
import type { DirectiveItem } from './directives.js';
import { emitDirectives } from './directives.js';

const EXPLORE_COUNTER_PATH = join(tmpdir(), 'alfred-explore-count');

function readExploreCount(): number {
  try { return parseInt(readFileSync(EXPLORE_COUNTER_PATH, 'utf-8'), 10) || 0; } catch { return 0; }
}

function writeExploreCount(n: number): void {
  try { writeFileSync(EXPLORE_COUNTER_PATH, String(n)); } catch { /* best effort */ }
}

export async function postToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
  if (!ev.cwd || !ev.tool_name) return;

  const items: DirectiveItem[] = [];

  // Exploration detection (persisted across short-lived hook processes via /tmp).
  if (ev.tool_name === 'Read' || ev.tool_name === 'Grep' || ev.tool_name === 'Glob') {
    const count = readExploreCount() + 1;
    writeExploreCount(count);
    if (count >= 5) {
      try {
        readActive(ev.cwd); // has active spec → don't suggest
      } catch {
        items.push({
          level: 'WARNING',
          message: `5+ consecutive ${ev.tool_name} calls without a spec. Consider \`/alfred:survey\` to reverse-engineer a spec from the code.`,
        });
        writeExploreCount(0);
      }
    }
    emitDirectives('PostToolUse', items);
    return;
  }
  writeExploreCount(0);

  if (ev.tool_name === 'Bash' && !signal.aborted) {
    await handleBashResult(ev, items, signal);
  }

  emitDirectives('PostToolUse', items);
}

async function handleBashResult(ev: HookEvent, items: DirectiveItem[], signal: AbortSignal): Promise<void> {
  const response = ev.tool_response as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
  if (!response) return;

  // On Bash error: search FTS for similar errors.
  if (response.exitCode && response.exitCode !== 0 && response.stderr) {
    const errorText = typeof response.stderr === 'string' ? response.stderr : '';
    if (errorText.length > 10) {
      await searchErrorContext(ev.cwd!, errorText, items);
    }
  }

  // On Bash success: auto-check NextSteps + check for git commit.
  if (response.exitCode === 0) {
    const stdout = response.stdout ?? '';
    autoCheckNextSteps(ev.cwd!, stdout);

    // FR-7: Proactive conflict warning after git commit.
    if (isGitCommit(stdout) && !signal.aborted) {
      await checkKnowledgeConflicts(items);
    }
  }
}

async function searchErrorContext(projectPath: string, errorText: string, items: DirectiveItem[]): Promise<void> {
  let store;
  try { store = openDefaultCached(); } catch { return; }

  const query = errorText.slice(0, 200);
  try {
    const docs = searchKnowledgeFTS(store, query, 3);
    if (docs.length > 0) {
      const context = docs.map(d =>
        `- ${d.title}: ${truncate(d.content, 150)}`
      ).join('\n');
      items.push({
        level: 'CONTEXT',
        message: `Related knowledge for this error:\n${context}`,
      });
    }
  } catch { /* search failure is non-fatal */ }
}

function autoCheckNextSteps(projectPath: string, stdout: string): void {
  try {
    const taskSlug = readActive(projectPath);
    const sd = new SpecDir(projectPath, taskSlug);
    const session = sd.readFile('session.md');

    const nextStepsSection = extractSection(session, '## Next Steps');
    if (!nextStepsSection) return;

    const lines = nextStepsSection.split('\n');
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = line.match(/^- \[ \] (.+)$/);
      if (!match) continue;

      const description = match[1]!.toLowerCase();
      // Require 2+ word matches to avoid false positives from common words like "test", "build".
      const words = description.split(/\s+/).filter(w => w.length > 3);
      const matchCount = words.filter(w => stdout.toLowerCase().includes(w)).length;
      if (stdout && matchCount >= 2) {
        lines[i] = line.replace('- [ ]', '- [x]');
        changed = true;
      }
    }

    if (changed) {
      const updatedSection = lines.join('\n');
      const updatedSession = session.replace(nextStepsSection, updatedSection);
      sd.writeFile('session.md', updatedSession);
    }
  } catch { /* fail-open */ }
}

/**
 * Detect git commit from Bash stdout.
 * Checks for common git commit output patterns.
 */
function isGitCommit(stdout: string): boolean {
  if (!stdout) return false;
  // Common patterns in git commit output.
  return /\[[\w./-]+ [0-9a-f]+\]/.test(stdout) || // [main abc1234], [feature-branch abc1234], etc.
    (stdout.includes('files changed') && (stdout.includes('insertion') || stdout.includes('deletion')));
}

/**
 * FR-7: Check for knowledge conflicts and emit warnings.
 */
async function checkKnowledgeConflicts(items: DirectiveItem[]): Promise<void> {
  let store;
  try { store = openDefaultCached(); } catch { return; }

  try {
    // Use limit=500 (not default 1000) to stay within 5s PostToolUse timeout budget.
    const conflicts = detectKnowledgeConflicts(store, 0.70, 500);
    if (conflicts.length === 0) return;

    // Include contradictions (>= 0.70) and high-similarity duplicates (>= 0.90).
    const significant = conflicts.filter(c =>
      c.type === 'potential_contradiction' || c.similarity >= 0.90
    );

    for (const conflict of significant.slice(0, 3)) {
      const typeLabel = conflict.type === 'potential_contradiction' ? 'CONTRADICTION' : 'DUPLICATE';
      items.push({
        level: 'WARNING',
        message: `Knowledge ${typeLabel} detected (${Math.round(conflict.similarity * 100)}% similar): "${conflict.a.title}" vs "${conflict.b.title}". Consider resolving via \`ledger action=reflect\`.`,
      });
    }
  } catch { /* conflict detection failure is non-fatal */ }
}
