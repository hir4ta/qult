import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../store/index.js';
import { handleDossier } from '../dossier.js';

let tmpDir: string;
let store: Store;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alfred-dossier-test-'));
  store = Store.open(join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('dossier init', () => {
  it('creates spec with correct files', async () => {
    const result = await handleDossier(store, null, {
      action: 'init',
      project_path: tmpDir,
      task_slug: 'my-feature',
      description: 'Add authentication',
    });
    const data = parseResult(result);
    expect(data.task_slug).toBe('my-feature');
    expect(data.size).toBe('S');
    expect(data.files).toContain('requirements.md');
    expect(existsSync(join(tmpDir, '.alfred', 'specs', 'my-feature', 'requirements.md'))).toBe(true);
  });

  it('rejects invalid slug', async () => {
    const result = await handleDossier(store, null, {
      action: 'init',
      project_path: tmpDir,
      task_slug: 'INVALID',
    });
    const data = parseResult(result);
    expect(data.error).toBeDefined();
  });

  it('rejects duplicate init', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'dup-test',
    });
    const result = await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'dup-test',
    });
    const data = parseResult(result);
    expect(data.error).toContain('already exists');
  });
});

describe('dossier status', () => {
  it('returns inactive when no specs', async () => {
    const result = await handleDossier(store, null, {
      action: 'status', project_path: tmpDir,
    });
    expect(parseResult(result).active).toBe(false);
  });

  it('returns active spec details', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'my-task', description: 'test',
    });
    const result = await handleDossier(store, null, {
      action: 'status', project_path: tmpDir,
    });
    const data = parseResult(result);
    expect(data.active).toBe(true);
    expect(data.task_slug).toBe('my-task');
    expect(data.requirements).toBeDefined();
  });
});

describe('dossier update', () => {
  it('appends content to spec file', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'upd-test',
    });
    const result = await handleDossier(store, null, {
      action: 'update', project_path: tmpDir, file: 'session.md',
      content: '\n## New Section\n', mode: 'append',
    });
    const data = parseResult(result);
    expect(data.task_slug).toBe('upd-test');
    expect(data.mode).toBe('append');
  });

  it('replaces content in spec file', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'rep-test',
    });
    const result = await handleDossier(store, null, {
      action: 'update', project_path: tmpDir, file: 'session.md',
      content: '# Replaced', mode: 'replace',
    });
    expect(parseResult(result).mode).toBe('replace');
  });
});

describe('dossier switch', () => {
  it('switches active task', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'task-a',
    });
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'task-b',
    });
    const result = await handleDossier(store, null, {
      action: 'switch', project_path: tmpDir, task_slug: 'task-a',
    });
    expect(parseResult(result).switched).toBe(true);
  });
});

describe('dossier complete', () => {
  it('completes S spec without review', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'done-test', description: 'small',
    });
    const result = await handleDossier(store, null, {
      action: 'complete', project_path: tmpDir, task_slug: 'done-test',
    });
    expect(parseResult(result).completed).toBe(true);
  });
});

describe('dossier delete', () => {
  it('preview without confirm', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'del-test',
    });
    const result = await handleDossier(store, null, {
      action: 'delete', project_path: tmpDir, task_slug: 'del-test',
    });
    const data = parseResult(result);
    expect(data.warning).toBeDefined();
    expect(data.exists).toBe(true);
  });

  it('deletes with confirm', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'del-test',
    });
    const result = await handleDossier(store, null, {
      action: 'delete', project_path: tmpDir, task_slug: 'del-test', confirm: true,
    });
    expect(parseResult(result).deleted).toBe(true);
    expect(existsSync(join(tmpDir, '.alfred', 'specs', 'del-test'))).toBe(false);
  });
});

describe('dossier history & rollback', () => {
  it('returns empty history for new spec', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'hist-test',
    });
    const result = await handleDossier(store, null, {
      action: 'history', project_path: tmpDir, file: 'session.md',
    });
    expect(parseResult(result).count).toBe(0);
  });

  it('creates history after update', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'hist-test',
    });
    await handleDossier(store, null, {
      action: 'update', project_path: tmpDir, file: 'session.md',
      content: '# Updated', mode: 'replace',
    });
    const result = await handleDossier(store, null, {
      action: 'history', project_path: tmpDir, file: 'session.md',
    });
    expect(parseResult(result).count).toBeGreaterThan(0);
  });
});

describe('dossier validate', () => {
  it('validates spec structure', async () => {
    await handleDossier(store, null, {
      action: 'init', project_path: tmpDir, task_slug: 'val-test',
    });
    const result = await handleDossier(store, null, {
      action: 'validate', project_path: tmpDir, task_slug: 'val-test',
    });
    const data = parseResult(result);
    expect(data.checks).toBeDefined();
    expect(data.summary).toContain('passed');
  });
});
