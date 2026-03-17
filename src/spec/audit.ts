import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rootDir } from './types.js';

export interface AuditEntry {
  action: string;
  target: string;
  detail?: string;
  user?: string;
}

export function appendAudit(projectPath: string, entry: AuditEntry): void {
  try {
    const dir = rootDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    appendFileSync(join(dir, 'audit.jsonl'), line + '\n');
  } catch {
    // Audit logging is best-effort.
  }
}
