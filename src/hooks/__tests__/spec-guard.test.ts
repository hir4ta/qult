import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryReadActiveSpec, isSpecFilePath, countUncheckedNextSteps, hasUncheckedSelfReview } from '../spec-guard.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'spec-guard-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupSpec(opts: {
  primary?: string;
  size?: string;
  reviewStatus?: string;
  status?: string;
  sessionContent?: string;
}): void {
  const slug = opts.primary ?? 'test-task';
  const specsDir = join(tmpDir, '.alfred', 'specs');
  mkdirSync(specsDir, { recursive: true });

  let yaml = `primary: ${slug}\ntasks:\n  - slug: ${slug}\n    started_at: 2026-01-01T00:00:00Z\n`;
  if (opts.size) yaml += `    size: ${opts.size}\n`;
  if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
  if (opts.status) yaml += `    status: ${opts.status}\n`;
  writeFileSync(join(specsDir, '_active.md'), yaml);

  if (opts.sessionContent) {
    const taskDir = join(specsDir, slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'session.md'), opts.sessionContent);
  }
}

describe('tryReadActiveSpec', () => {
  it('returns spec state from _active.md', () => {
    setupSpec({ size: 'M', reviewStatus: 'approved', status: 'active' });
    const spec = tryReadActiveSpec(tmpDir);
    expect(spec).not.toBeNull();
    expect(spec!.slug).toBe('test-task');
    expect(spec!.size).toBe('M');
    expect(spec!.reviewStatus).toBe('approved');
  });

  it('returns null when _active.md missing (fail-open)', () => {
    expect(tryReadActiveSpec(tmpDir)).toBeNull();
  });

  it('returns null when cwd is undefined', () => {
    expect(tryReadActiveSpec(undefined)).toBeNull();
  });

  it('returns null when primary is empty', () => {
    const specsDir = join(tmpDir, '.alfred', 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, '_active.md'), 'primary: ""\ntasks: []\n');
    expect(tryReadActiveSpec(tmpDir)).toBeNull();
  });
});

describe('isSpecFilePath', () => {
  it('returns true for .alfred/ paths', () => {
    expect(isSpecFilePath(tmpDir, join(tmpDir, '.alfred', 'specs', 'task', 'design.md'))).toBe(true);
  });

  it('returns true for relative .alfred/ paths', () => {
    expect(isSpecFilePath(tmpDir, '.alfred/specs/task/design.md')).toBe(true);
  });

  it('returns false for src/ paths', () => {
    expect(isSpecFilePath(tmpDir, join(tmpDir, 'src', 'index.ts'))).toBe(false);
  });

  it('returns false for .alfred-sibling directories', () => {
    expect(isSpecFilePath(tmpDir, join(tmpDir, '.alfred-backup', 'secrets.ts'))).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isSpecFilePath(undefined, 'foo')).toBe(false);
    expect(isSpecFilePath(tmpDir, '')).toBe(false);
  });
});

describe('countUncheckedNextSteps', () => {
  it('counts unchecked items', () => {
    setupSpec({
      sessionContent: '# Session\n## Next Steps\n- [x] Done\n- [ ] Todo 1\n- [ ] Todo 2\n## Other\n',
    });
    expect(countUncheckedNextSteps(tmpDir, 'test-task')).toBe(2);
  });

  it('returns 0 when all checked', () => {
    setupSpec({
      sessionContent: '# Session\n## Next Steps\n- [x] Done 1\n- [x] Done 2\n',
    });
    expect(countUncheckedNextSteps(tmpDir, 'test-task')).toBe(0);
  });

  it('returns 0 when no session.md', () => {
    expect(countUncheckedNextSteps(tmpDir, 'nonexistent')).toBe(0);
  });
});

describe('hasUncheckedSelfReview', () => {
  it('detects unchecked self-review (Japanese)', () => {
    setupSpec({
      sessionContent: '## Next Steps\n- [x] Implementation\n- [ ] Wave 1 セルフレビュー\n',
    });
    expect(hasUncheckedSelfReview(tmpDir, 'test-task')).toBe(true);
  });

  it('detects unchecked self-review (English)', () => {
    setupSpec({
      sessionContent: '## Next Steps\n- [ ] Wave 1 self-review\n',
    });
    expect(hasUncheckedSelfReview(tmpDir, 'test-task')).toBe(true);
  });

  it('returns false when self-review is checked', () => {
    setupSpec({
      sessionContent: '## Next Steps\n- [x] Wave 1 セルフレビュー\n- [ ] Other task\n',
    });
    expect(hasUncheckedSelfReview(tmpDir, 'test-task')).toBe(false);
  });

  it('returns false when no self-review item', () => {
    setupSpec({
      sessionContent: '## Next Steps\n- [ ] Implementation\n',
    });
    expect(hasUncheckedSelfReview(tmpDir, 'test-task')).toBe(false);
  });
});
