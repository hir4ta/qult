import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStateJSON, writeStateJSON, readStateText, writeStateText, ensureStateDir, stateDir } from '../state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'state-'));
  mkdirSync(join(tmpDir, '.alfred'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('stateDir', () => {
  it('returns .alfred/.state path', () => {
    expect(stateDir(tmpDir)).toBe(join(tmpDir, '.alfred', '.state'));
  });
});

describe('ensureStateDir', () => {
  it('creates directory if missing', () => {
    ensureStateDir(tmpDir);
    const { existsSync } = require('node:fs');
    expect(existsSync(stateDir(tmpDir))).toBe(true);
  });

  it('is idempotent', () => {
    ensureStateDir(tmpDir);
    ensureStateDir(tmpDir); // no throw
  });
});

describe('readStateJSON / writeStateJSON', () => {
  it('round-trips JSON data', () => {
    const data = { count: 3, label: 'test' };
    writeStateJSON(tmpDir, 'test.json', data);
    expect(readStateJSON(tmpDir, 'test.json', {})).toEqual(data);
  });

  it('returns fallback when file missing', () => {
    expect(readStateJSON(tmpDir, 'missing.json', { default: true })).toEqual({ default: true });
  });

  it('returns fallback on invalid JSON', () => {
    writeStateText(tmpDir, 'bad.json', 'not json');
    expect(readStateJSON(tmpDir, 'bad.json', [])).toEqual([]);
  });
});

describe('readStateText / writeStateText', () => {
  it('round-trips text data', () => {
    writeStateText(tmpDir, 'counter', '42');
    expect(readStateText(tmpDir, 'counter', '0')).toBe('42');
  });

  it('returns fallback when file missing', () => {
    expect(readStateText(tmpDir, 'missing', 'default')).toBe('default');
  });
});
