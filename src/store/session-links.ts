import type { Store } from './index.js';
import type { SessionLink, SessionContinuity } from '../types.js';

export function linkSession(store: Store, link: SessionLink): void {
  if (!link.linkedAt) {
    link.linkedAt = new Date().toISOString();
  }
  store.db.prepare(`
    INSERT OR IGNORE INTO session_links
    (claude_session_id, master_session_id, project_remote, project_path, task_slug, branch, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    link.claudeSessionId, link.masterSessionId,
    link.projectRemote, link.projectPath, link.taskSlug, link.branch, link.linkedAt,
  );
}

export function resolveMasterSession(store: Store, claudeSessionId: string): string {
  let id = claudeSessionId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(id)) return id;
    seen.add(id);
    const row = store.db.prepare(
      'SELECT master_session_id FROM session_links WHERE claude_session_id = ?',
    ).get(id) as { master_session_id: string } | undefined;
    if (!row || !row.master_session_id || row.master_session_id === id) {
      return id;
    }
    id = row.master_session_id;
  }
}

export function getSessionContinuity(store: Store, masterSessionId: string): SessionContinuity {
  const rows = store.db.prepare(
    'SELECT claude_session_id FROM session_links WHERE master_session_id = ? ORDER BY linked_at',
  ).all(masterSessionId) as Array<{ claude_session_id: string }>;

  const linkedSessions = rows.map(r => r.claude_session_id);
  return {
    masterSessionId,
    linkedSessions,
    compactCount: linkedSessions.length,
  };
}
