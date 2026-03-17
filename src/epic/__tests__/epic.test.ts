import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EpicDir, initEpic, listAllEpics, removeEpic,
  topologicalOrder, nextActionable, syncTaskStatus,
  unlinkTaskFromAllEpics,
  STATUS_DRAFT, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_NOT_STARTED,
} from '../index.js';
import type { EpicTask } from '../index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alfred-epic-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Epic init', () => {
  it('creates epic directory and yaml', () => {
    const ed = initEpic(tmpDir, 'auth-system', 'Authentication System');
    expect(ed.exists()).toBe(true);
    const ep = ed.read();
    expect(ep.name).toBe('Authentication System');
    expect(ep.status).toBe(STATUS_DRAFT);
  });

  it('rejects duplicate epic', () => {
    initEpic(tmpDir, 'my-epic', 'My Epic');
    expect(() => initEpic(tmpDir, 'my-epic', 'My Epic')).toThrow('already exists');
  });

  it('rejects invalid slug', () => {
    expect(() => initEpic(tmpDir, 'INVALID', 'Bad')).toThrow('invalid epic_slug');
  });
});

describe('Epic link/unlink', () => {
  it('links and unlinks tasks', () => {
    const ed = initEpic(tmpDir, 'test-epic', 'Test');
    ed.link('task-a', []);
    ed.link('task-b', ['task-a']);

    const ep = ed.read();
    expect(ep.tasks).toHaveLength(2);
    expect(ep.status).toBe(STATUS_IN_PROGRESS);

    ed.unlink('task-a');
    const ep2 = ed.read();
    expect(ep2.tasks).toHaveLength(1);
    // task-b should no longer depend on task-a
    expect(ep2.tasks![0]!.depends_on).toBeUndefined();
  });

  it('rejects duplicate link', () => {
    const ed = initEpic(tmpDir, 'test-epic', 'Test');
    ed.link('task-a', []);
    expect(() => ed.link('task-a', [])).toThrow('already linked');
  });

  it('validates dependencies exist', () => {
    const ed = initEpic(tmpDir, 'test-epic', 'Test');
    expect(() => ed.link('task-a', ['nonexistent'])).toThrow('not found');
  });
});

describe('topologicalOrder', () => {
  it('returns correct order', () => {
    const tasks: EpicTask[] = [
      { slug: 'c', status: 'not-started', depends_on: ['a', 'b'] },
      { slug: 'a', status: 'not-started' },
      { slug: 'b', status: 'not-started', depends_on: ['a'] },
    ];
    const order = topologicalOrder(tasks);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('detects cycles', () => {
    const tasks: EpicTask[] = [
      { slug: 'a', status: 'not-started', depends_on: ['b'] },
      { slug: 'b', status: 'not-started', depends_on: ['a'] },
    ];
    expect(() => topologicalOrder(tasks)).toThrow('cycle');
  });
});

describe('nextActionable', () => {
  it('returns tasks with all deps completed', () => {
    const tasks: EpicTask[] = [
      { slug: 'a', status: STATUS_COMPLETED },
      { slug: 'b', status: STATUS_NOT_STARTED, depends_on: ['a'] },
      { slug: 'c', status: STATUS_NOT_STARTED, depends_on: ['b'] },
    ];
    expect(nextActionable(tasks)).toEqual(['b']);
  });
});

describe('listAllEpics', () => {
  it('lists all epics', () => {
    initEpic(tmpDir, 'epic-a', 'Epic A');
    initEpic(tmpDir, 'epic-b', 'Epic B');
    const summaries = listAllEpics(tmpDir);
    expect(summaries).toHaveLength(2);
  });
});

describe('removeEpic', () => {
  it('removes epic and updates active', () => {
    initEpic(tmpDir, 'to-remove', 'Remove Me');
    removeEpic(tmpDir, 'to-remove');
    const ed = new EpicDir(tmpDir, 'to-remove');
    expect(ed.exists()).toBe(false);
  });
});

describe('syncTaskStatus', () => {
  it('syncs task status and auto-completes epic', () => {
    const ed = initEpic(tmpDir, 'sync-epic', 'Sync');
    ed.link('task-a', []);
    ed.link('task-b', []);

    syncTaskStatus(tmpDir, 'task-a', STATUS_COMPLETED);
    syncTaskStatus(tmpDir, 'task-b', STATUS_COMPLETED);

    const ep = ed.read();
    expect(ep.status).toBe(STATUS_COMPLETED);
  });
});
