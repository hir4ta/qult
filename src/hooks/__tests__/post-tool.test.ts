import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStateText, writeStateText } from '../state.js';
import { isTestFailure, isGitCommit } from '../post-tool.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'post-tool-'));
  mkdirSync(join(tmpDir, '.alfred'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('explore count via state', () => {
  it('starts at 0', () => {
    const count = parseInt(readStateText(tmpDir, 'explore-count', '0'), 10) || 0;
    expect(count).toBe(0);
  });

  it('increments correctly', () => {
    writeStateText(tmpDir, 'explore-count', '1');
    const count = parseInt(readStateText(tmpDir, 'explore-count', '0'), 10);
    expect(count).toBe(1);
  });

  it('resets to 0', () => {
    writeStateText(tmpDir, 'explore-count', '5');
    writeStateText(tmpDir, 'explore-count', '0');
    const count = parseInt(readStateText(tmpDir, 'explore-count', '0'), 10);
    expect(count).toBe(0);
  });

  it('reaches threshold at 5', () => {
    for (let i = 1; i <= 5; i++) {
      writeStateText(tmpDir, 'explore-count', String(i));
    }
    const count = parseInt(readStateText(tmpDir, 'explore-count', '0'), 10);
    expect(count).toBe(5);
    expect(count >= 5).toBe(true);
  });
});

describe('isTestFailure', () => {
  it('detects FAIL', () => {
    expect(isTestFailure('FAIL src/test.ts')).toBe(true);
  });

  it('detects FAILED', () => {
    expect(isTestFailure('Tests FAILED')).toBe(true);
  });

  it('detects FAILURE', () => {
    expect(isTestFailure('FAILURE in test suite')).toBe(true);
  });

  it('detects "N failed"', () => {
    expect(isTestFailure('3 failed, 10 passed')).toBe(true);
  });

  it('does not detect passing tests', () => {
    expect(isTestFailure('All tests passed')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTestFailure('')).toBe(false);
  });
});

describe('isGitCommit', () => {
  it('detects branch commit pattern', () => {
    expect(isGitCommit('[main abc1234] fix: something')).toBe(true);
  });

  it('detects feature branch commit', () => {
    expect(isGitCommit('[feature/login 1a2b3c4] feat: add login')).toBe(true);
  });

  it('detects diff stat pattern', () => {
    expect(isGitCommit('3 files changed, 100 insertions(+), 20 deletions(-)')).toBe(true);
  });

  it('does not detect regular output', () => {
    expect(isGitCommit('npm test completed successfully')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGitCommit('')).toBe(false);
  });
});
