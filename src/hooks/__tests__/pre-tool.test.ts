import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookEvent } from '../dispatcher.js';
import { preToolUse } from '../pre-tool.js';

let tmpDir: string;
let stdoutData: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pre-tool-'));
  stdoutData = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutData.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setupSpec(opts: { size?: string; reviewStatus?: string; status?: string }): void {
  const specsDir = join(tmpDir, '.alfred', 'specs');
  mkdirSync(specsDir, { recursive: true });
  let yaml = `primary: test-task\ntasks:\n  - slug: test-task\n    started_at: 2026-01-01T00:00:00Z\n`;
  if (opts.size) yaml += `    size: ${opts.size}\n`;
  if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
  if (opts.status) yaml += `    status: ${opts.status}\n`;
  writeFileSync(join(specsDir, '_active.md'), yaml);
}

function makeEvent(toolName: string, filePath?: string): HookEvent {
  return {
    cwd: tmpDir,
    tool_name: toolName,
    tool_input: filePath ? { file_path: filePath } : {},
  };
}

function getDenyOutput(): { hookSpecificOutput?: { permissionDecision?: string } } | null {
  for (const line of stdoutData) {
    try { return JSON.parse(line.trim()); } catch { continue; }
  }
  return null;
}

describe('preToolUse', () => {
  it('denies Edit on M unapproved spec', async () => {
    setupSpec({ size: 'M', reviewStatus: 'pending' });
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    const out = getDenyOutput();
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies Write on L unapproved spec', async () => {
    setupSpec({ size: 'L', reviewStatus: 'pending' });
    await preToolUse(makeEvent('Write', join(tmpDir, 'src/new.ts')));
    const out = getDenyOutput();
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows Edit on M approved spec', async () => {
    setupSpec({ size: 'M', reviewStatus: 'approved' });
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    expect(stdoutData.length).toBe(0);
  });

  it('allows Edit on S spec regardless of review status', async () => {
    setupSpec({ size: 'S' });
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    expect(stdoutData.length).toBe(0);
  });

  it('allows Edit on D spec regardless of review status', async () => {
    setupSpec({ size: 'D' });
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    expect(stdoutData.length).toBe(0);
  });

  it('allows Edit to .alfred/ paths (spec exempt)', async () => {
    setupSpec({ size: 'M', reviewStatus: 'pending' });
    await preToolUse(makeEvent('Edit', join(tmpDir, '.alfred/specs/test-task/design.md')));
    expect(stdoutData.length).toBe(0);
  });

  it('allows Edit when no active spec exists', async () => {
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    expect(stdoutData.length).toBe(0);
  });

  it('allows non-blockable tools (Read)', async () => {
    setupSpec({ size: 'M', reviewStatus: 'pending' });
    await preToolUse(makeEvent('Read'));
    expect(stdoutData.length).toBe(0);
  });

  it('allows non-blockable tools (Bash)', async () => {
    setupSpec({ size: 'M', reviewStatus: 'pending' });
    await preToolUse(makeEvent('Bash'));
    expect(stdoutData.length).toBe(0);
  });

  it('denies XL unapproved spec', async () => {
    setupSpec({ size: 'XL', reviewStatus: 'changes_requested' });
    await preToolUse(makeEvent('Edit', join(tmpDir, 'src/index.ts')));
    const out = getDenyOutput();
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});
