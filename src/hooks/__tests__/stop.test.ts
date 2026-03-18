import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookEvent } from '../dispatcher.js';
import { stop } from '../stop.js';

let tmpDir: string;
let stdoutData: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stop-'));
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

function setupSpec(opts: {
  size?: string;
  reviewStatus?: string;
  status?: string;
  sessionContent?: string;
}): void {
  const slug = 'test-task';
  const specsDir = join(tmpDir, '.alfred', 'specs');
  mkdirSync(join(specsDir, slug), { recursive: true });

  let yaml = `primary: ${slug}\ntasks:\n  - slug: ${slug}\n    started_at: 2026-01-01T00:00:00Z\n`;
  if (opts.size) yaml += `    size: ${opts.size}\n`;
  if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
  if (opts.status) yaml += `    status: ${opts.status}\n`;
  writeFileSync(join(specsDir, '_active.md'), yaml);

  if (opts.sessionContent) {
    writeFileSync(join(specsDir, slug, 'session.md'), opts.sessionContent);
  }
}

function makeEvent(opts?: { stopHookActive?: boolean }): HookEvent {
  return {
    cwd: tmpDir,
    stop_hook_active: opts?.stopHookActive,
  };
}

function getBlockOutput(): { decision?: string } | null {
  for (const line of stdoutData) {
    try { return JSON.parse(line.trim()); } catch { continue; }
  }
  return null;
}

describe('stop', () => {
  it('allows stop when stop_hook_active=true (DEC-4 infinite loop prevention)', async () => {
    setupSpec({ size: 'M', sessionContent: '## Next Steps\n- [ ] Unchecked\n' });
    await stop(makeEvent({ stopHookActive: true }));
    expect(stdoutData.length).toBe(0);
  });

  it('blocks when unchecked Next Steps remain', async () => {
    setupSpec({
      size: 'M',
      sessionContent: '## Next Steps\n- [x] Done\n- [ ] Todo 1\n- [ ] Todo 2\n',
    });
    await stop(makeEvent());
    const out = getBlockOutput();
    expect(out?.decision).toBe('block');
  });

  it('blocks when self-review is unchecked (Japanese)', async () => {
    setupSpec({
      size: 'M',
      sessionContent: '## Next Steps\n- [ ] セルフレビュー\n',
    });
    await stop(makeEvent());
    const out = getBlockOutput();
    expect(out?.decision).toBe('block');
  });

  it('blocks when self-review is unchecked (English)', async () => {
    setupSpec({
      size: 'M',
      sessionContent: '## Next Steps\n- [ ] self-review\n',
    });
    await stop(makeEvent());
    const out = getBlockOutput();
    expect(out?.decision).toBe('block');
  });

  it('blocks with dossier complete message when all items checked', async () => {
    setupSpec({
      size: 'M',
      sessionContent: '## Next Steps\n- [x] All done\n',
    });
    await stop(makeEvent());
    const out = getBlockOutput();
    expect(out?.decision).toBe('block');
    // Should mention dossier complete
    const reason = stdoutData.join('');
    expect(reason).toContain('dossier action=complete');
  });

  it('allows stop when no active spec', async () => {
    await stop(makeEvent());
    expect(stdoutData.length).toBe(0);
  });

  it('allows stop when spec is completed', async () => {
    setupSpec({
      size: 'M',
      status: 'completed',
      sessionContent: '## Next Steps\n- [ ] Something unchecked\n',
    });
    await stop(makeEvent());
    expect(stdoutData.length).toBe(0);
  });

  it('blocks with dossier-complete when session.md is missing (fail-open on next-steps)', async () => {
    // Setup spec without session content — no session.md file
    const specsDir = join(tmpDir, '.alfred', 'specs');
    mkdirSync(join(specsDir, 'test-task'), { recursive: true });
    const yaml = `primary: test-task\ntasks:\n  - slug: test-task\n    started_at: 2026-01-01T00:00:00Z\n`;
    writeFileSync(join(specsDir, '_active.md'), yaml);
    // No session.md written → countUncheckedNextSteps returns 0 (fail-open)
    // But spec is still active → blocks with dossier complete message

    await stop(makeEvent());
    const out = getBlockOutput();
    expect(out?.decision).toBe('block');
  });
});
