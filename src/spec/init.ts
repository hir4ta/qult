import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {
  SpecDir, VALID_SLUG, detectSize, filesForSize,
  readActiveState, writeActiveState,
  specsDir,
} from './types.js';
import type { SpecSize, SpecType, SpecFile, ActiveState, InitResult } from './types.js';
import { renderForSize } from './templates.js';
import type { TemplateData } from './templates.js';

interface InitOptions {
  size?: SpecSize;
  specType?: SpecType;
}

export function initSpec(
  projectPath: string,
  taskSlug: string,
  description: string,
  opts?: InitOptions,
): InitResult {
  if (!VALID_SLUG.test(taskSlug)) {
    throw new Error(`invalid task_slug "${taskSlug}": must be lowercase alphanumeric with hyphens (e.g., 'add-auth')`);
  }

  let size = opts?.size ?? detectSize(description);
  let specType: SpecType = opts?.specType ?? 'feature';
  if (size === 'D') specType = 'delta';

  const sd = new SpecDir(projectPath, taskSlug);
  if (sd.exists()) {
    throw new Error(`spec already exists for '${taskSlug}'; use dossier action=update to modify`);
  }

  mkdirSync(sd.dir(), { recursive: true });

  const data: TemplateData = {
    taskSlug,
    description,
    date: new Date().toISOString().slice(0, 10),
    specType,
  };

  const rendered = renderForSize(size, specType, data);
  const files = filesForSize(size, specType);

  try {
    for (const f of files) {
      const content = rendered.get(f) ?? '';
      writeFileSync(sd.filePath(f), content);
    }
  } catch (err) {
    rmSync(sd.dir(), { recursive: true, force: true });
    throw new Error(`write template files: ${err}`);
  }

  // Update _active.md.
  const now = new Date().toISOString();
  let state: ActiveState;
  try {
    state = readActiveState(projectPath);
  } catch {
    state = { primary: '', tasks: [] };
  }
  state.primary = taskSlug;
  if (!state.tasks.some(t => t.slug === taskSlug)) {
    state.tasks.push({
      slug: taskSlug,
      started_at: now,
      size,
      spec_type: specType,
    });
  }
  writeActiveState(projectPath, state);

  return { specDir: sd, size, specType, files };
}
