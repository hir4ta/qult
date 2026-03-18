import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyIntent, checkSpecRequired } from '../user-prompt.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'user-prompt-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupAlfred(): void {
  mkdirSync(join(tmpDir, '.alfred'), { recursive: true });
}

function setupSpec(opts: { size?: string; reviewStatus?: string }): void {
  setupAlfred();
  const specsDir = join(tmpDir, '.alfred', 'specs');
  mkdirSync(specsDir, { recursive: true });
  let yaml = `primary: test-task\ntasks:\n  - slug: test-task\n    started_at: 2026-01-01T00:00:00Z\n`;
  if (opts.size) yaml += `    size: ${opts.size}\n`;
  if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
  writeFileSync(join(specsDir, '_active.md'), yaml);
}

describe('classifyIntent', () => {
  // EN keywords
  it('classifies "implement login" as implement', () => {
    expect(classifyIntent('implement login feature')).toBe('implement');
  });

  it('classifies "fix the bug" as bugfix', () => {
    expect(classifyIntent('fix the bug in auth')).toBe('bugfix');
  });

  it('classifies "review code" as review', () => {
    expect(classifyIntent('review the code changes')).toBe('review');
  });

  it('classifies "write tests" as tdd', () => {
    expect(classifyIntent('write tests for the API')).toBe('tdd');
  });

  it('classifies "research patterns" as research', () => {
    expect(classifyIntent('research design patterns for this')).toBe('research');
  });

  // JP keywords
  it('classifies Japanese implement intent', () => {
    expect(classifyIntent('ログイン機能を実装してください')).toBe('implement');
  });

  it('classifies Japanese bugfix intent', () => {
    expect(classifyIntent('バグを修正して')).toBe('bugfix');
  });

  it('classifies Japanese review intent', () => {
    expect(classifyIntent('コードをレビューして')).toBe('review');
  });

  // Edge cases
  it('returns null for unrelated prompt', () => {
    expect(classifyIntent('hello world')).toBeNull();
  });

  it('save-knowledge suppresses research when both match', () => {
    expect(classifyIntent('save this research note')).toBe('save-knowledge');
  });
});

describe('checkSpecRequired', () => {
  it('returns DIRECTIVE when no spec and implement intent', () => {
    setupAlfred();
    const result = checkSpecRequired(tmpDir, 'implement');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('DIRECTIVE');
  });

  it('returns DIRECTIVE when no spec and bugfix intent', () => {
    setupAlfred();
    const result = checkSpecRequired(tmpDir, 'bugfix');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('DIRECTIVE');
  });

  it('returns DIRECTIVE when no spec and tdd intent', () => {
    setupAlfred();
    const result = checkSpecRequired(tmpDir, 'tdd');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('DIRECTIVE');
  });

  it('returns null for review intent (no spec required)', () => {
    setupAlfred();
    expect(checkSpecRequired(tmpDir, 'review')).toBeNull();
  });

  it('returns null for research intent (no spec required)', () => {
    setupAlfred();
    expect(checkSpecRequired(tmpDir, 'research')).toBeNull();
  });

  it('returns DIRECTIVE when M spec is unapproved', () => {
    setupSpec({ size: 'M', reviewStatus: 'pending' });
    const result = checkSpecRequired(tmpDir, 'implement');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('DIRECTIVE');
    expect(result!.message).toContain('requires review approval');
  });

  it('returns null when M spec is approved', () => {
    setupSpec({ size: 'M', reviewStatus: 'approved' });
    expect(checkSpecRequired(tmpDir, 'implement')).toBeNull();
  });

  it('returns null when S spec (exempt)', () => {
    setupSpec({ size: 'S' });
    expect(checkSpecRequired(tmpDir, 'implement')).toBeNull();
  });

  it('returns null when no .alfred/ directory', () => {
    expect(checkSpecRequired(tmpDir, 'implement')).toBeNull();
  });

  it('includes rationalizations in directive', () => {
    setupAlfred();
    const result = checkSpecRequired(tmpDir, 'implement');
    expect(result!.rationalizations).toBeDefined();
    expect(result!.rationalizations!.length).toBeGreaterThan(0);
  });
});
