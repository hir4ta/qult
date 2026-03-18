import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookEvent } from './dispatcher.js';
import { notifyUser } from './dispatcher.js';
import { openDefaultCached } from '../store/index.js';
import { searchKnowledgeFTS, detectKnowledgeConflicts } from '../store/fts.js';
import { readActive, readActiveState, SpecDir } from '../spec/types.js';
import { truncate } from '../mcp/helpers.js';
import { extractSection } from './dispatcher.js';
import type { DirectiveItem } from './directives.js';
import { emitDirectives } from './directives.js';
import { detectProject } from '../store/project.js';
import { upsertKnowledge } from '../store/knowledge.js';
import type { KnowledgeRow } from '../types.js';

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

  // Check spec completion on any tool that might update spec files (Edit, Write, Bash).
  if (['Edit', 'Write', 'Bash'].includes(ev.tool_name)) {
    checkSpecCompletion(ev.cwd!, items);
  }

  emitDirectives('PostToolUse', items);
}

async function handleBashResult(ev: HookEvent, items: DirectiveItem[], signal: AbortSignal): Promise<void> {
  const response = ev.tool_response as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
  if (!response) return;

  // On Bash error: search FTS for similar errors + detect test failures.
  if (response.exitCode && response.exitCode !== 0) {
    const errorText = typeof response.stderr === 'string' ? response.stderr : '';
    const stdout = response.stdout ?? '';
    if (errorText.length > 10) {
      await searchErrorContext(ev.cwd!, errorText, items);
    }

    // FR-4: Test failure rollback suggestion.
    if (isTestFailure(stdout + '\n' + errorText)) {
      items.push({
        level: 'WARNING',
        message: 'Test failure detected. Investigate the root cause before continuing implementation. Consider reverting recent changes with `git stash` or `git diff` to isolate the issue.',
      });
    }
  }

  // On Bash success: auto-check NextSteps + check for git commit.
  if (response.exitCode === 0) {
    const stdout = response.stdout ?? '';
    // Combine stdout + command input for broader matching.
    const commandStr = typeof ev.tool_input === 'object' && ev.tool_input !== null
      ? (ev.tool_input as { command?: string }).command ?? ''
      : '';
    autoCheckNextSteps(ev.cwd!, stdout + '\n' + commandStr);

    if (isGitCommit(stdout) && !signal.aborted) {
      // FR-7: Proactive conflict warning after git commit.
      await checkKnowledgeConflicts(items);

      // Auto-save decisions + session snapshot on git commit (not just PreCompact).
      // This ensures knowledge accumulates even with 1M context (no compact).
      saveKnowledgeOnCommit(ev.cwd!);
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
      // Adaptive threshold: 2+ matches for descriptions with 3+ qualifying words, 1 match for shorter.
      const words = description.split(/\s+/).filter(w => w.length > 3);
      const threshold = words.length >= 3 ? 2 : 1;
      const lowerOut = stdout.toLowerCase();
      const matchCount = words.filter(w => lowerOut.includes(w)).length;
      if (stdout && words.length > 0 && matchCount >= threshold) {
        lines[i] = line.replace('- [ ]', '- [x]');
        changed = true;
      }
    }

    if (changed) {
      const updatedSection = lines.join('\n');
      let updatedSession = session.replace(nextStepsSection, updatedSection);

      // Auto-update "Currently Working On" to the next unchecked step.
      const nextUnchecked = lines.find(l => l.startsWith('- [ ] '));
      if (nextUnchecked) {
        const nextText = nextUnchecked.replace('- [ ] ', '');
        updatedSession = updateCurrentlyWorkingOn(updatedSession, nextText);
      }

      sd.writeFile('session.md', updatedSession);
    }
  } catch { /* fail-open */ }
}

/** Replace only the first non-empty content line after "## Currently Working On", preserving other content. */
function updateCurrentlyWorkingOn(session: string, newFocus: string): string {
  const marker = '## Currently Working On';
  const idx = session.indexOf(marker);
  if (idx === -1) return session;

  const afterMarker = session.indexOf('\n', idx);
  if (afterMarker === -1) return session;

  // Find the first non-empty line after the heading.
  const lines = session.slice(afterMarker + 1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) break; // hit next heading
    if (lines[i]!.trim()) {
      // Replace this line only, keep everything else.
      lines[i] = newFocus;
      return session.slice(0, afterMarker + 1) + lines.join('\n');
    }
  }

  // No content line found — insert after heading.
  return session.slice(0, afterMarker + 1) + '\n' + newFocus + '\n' + session.slice(afterMarker + 1);
}

/**
 * FR-4: Detect test failure patterns in command output.
 */
function isTestFailure(output: string): boolean {
  if (!output) return false;
  const patterns = [
    /FAIL(ED|URE)?\b/i,              // vitest, jest, generic
    /\d+ failed/i,                   // generic "N failed"
    /Tests:\s+\d+ failed/,           // jest summary
    /✗|✘/,                           // unicode failure marks
    /AssertionError/i,               // assertion errors
    /test.*failed/i,                 // generic
    /npm ERR!.*test/i,               // npm test failure
  ];
  return patterns.some(p => p.test(output));
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

/**
 * Check if active spec should be completed after a git commit.
 * Detects: all Next Steps checked OR session status=completed, but spec still active.
 */
function checkSpecCompletion(projectPath: string, items: DirectiveItem[]): void {
  try {
    const slug = readActive(projectPath);
    const state = readActiveState(projectPath);
    const task = state.tasks.find(t => t.slug === slug);
    if (!task || task.status === 'completed') return;

    const sd = new SpecDir(projectPath, slug);
    const session = sd.readFile('session.md');

    // Check completion signals.
    const lower = session.toLowerCase();
    const hasCompletedStatus = lower.includes('status: completed') || lower.includes('status: done');

    // Only check checkboxes in the Next Steps section, not the whole file.
    const nextSteps = extractSection(session, '## Next Steps');
    const allSteps = nextSteps ? nextSteps.match(/^- \[[ x]\] .+$/gm) : null;
    const allChecked = allSteps && allSteps.length > 0 && allSteps.every(s => s.startsWith('- [x]'));

    if (hasCompletedStatus || allChecked) {
      items.push({
        level: 'DIRECTIVE',
        message: `Task '${slug}' appears complete (${hasCompletedStatus ? 'status marker' : 'all steps checked'}). MUST call \`dossier action=complete\` to close the spec.`,
      });
    }
  } catch { /* no active spec or read failure — skip */ }
}

/**
 * Save knowledge from spec on git commit — ensures decisions and session
 * snapshots accumulate even without PreCompact (1M context).
 */
function saveKnowledgeOnCommit(projectPath: string): void {
  let store;
  try { store = openDefaultCached(); } catch { return; }

  let slug: string;
  try { slug = readActive(projectPath); } catch { return; }

  const sd = new SpecDir(projectPath, slug);
  if (!sd.exists()) return;

  const proj = detectProject(projectPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);

  // 1. Save decisions from decisions.md (if exists).
  try {
    const decisions = sd.readFile('decisions.md');
    const decSections = decisions.split(/\n## DEC-\d+/);
    for (let i = 1; i < decSections.length; i++) {
      const section = decSections[i]!;
      const titleMatch = section.match(/^:\s*(.+)/);
      const title = titleMatch ? titleMatch[1]!.trim() : `Decision ${i}`;
      const statusMatch = section.match(/- Status:\s*(\w+)/i);
      if (statusMatch && statusMatch[1]!.toLowerCase() === 'accepted') {
        const row: KnowledgeRow = {
          id: 0,
          filePath: `decisions/spec/${slug}/dec-${i}`,
          contentHash: '', title,
          content: section.slice(0, 1000),
          subType: 'decision',
          projectRemote: proj.remote, projectPath: proj.path,
          projectName: proj.name, branch: proj.branch,
          createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
        };
        upsertKnowledge(store, row);
      }
    }
  } catch { /* decisions.md may not exist */ }

  // 2. Save session snapshot (like PreCompact chapter memory).
  try {
    const session = sd.readFile('session.md');
    const row: KnowledgeRow = {
      id: 0,
      filePath: `snapshots/${slug}/commit-${ts}`,
      contentHash: '', title: `${proj.name} > ${slug} > progress`,
      content: session.slice(0, 2000),
      subType: 'general',
      projectRemote: proj.remote, projectPath: proj.path,
      projectName: proj.name, branch: proj.branch,
      createdAt: '', updatedAt: '', hitCount: 0, lastAccessed: '', enabled: true,
    };
    upsertKnowledge(store, row);
  } catch { /* fail-open */ }
}
