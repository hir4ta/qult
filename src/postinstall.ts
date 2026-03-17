// postinstall: auto-setup DB + user rules on `npm install -g claude-alfred`.
// Fail-open — errors are logged but never block installation.

import { mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  const home = homedir();

  // 1. Ensure DB directory exists (DB itself is created on first open via Store.open).
  const dbDir = join(home, '.claude-alfred');
  try {
    mkdirSync(dbDir, { recursive: true });
  } catch { /* ignore */ }

  // 2. Create DB with schema migration.
  try {
    // Dynamic import to handle better-sqlite3 not being available during CI.
    const Database = (await import('better-sqlite3')).default;
    const { migrate } = await import('./store/schema.js');
    const dbPath = join(dbDir, 'alfred.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    migrate(db);
    db.close();
    console.log('[alfred] database ready:', dbPath);
  } catch (err) {
    console.error('[alfred] warning: database setup skipped:', err);
  }

  // 3. Install user rules to ~/.claude/rules/ (if not already present).
  const rulesDir = join(home, '.claude', 'rules');
  try {
    mkdirSync(rulesDir, { recursive: true });
    const existing = readdirSync(rulesDir);
    if (!existing.some(f => f.startsWith('alfred-'))) {
      // Write a minimal alfred rule pointing users to the plugin.
      writeFileSync(
        join(rulesDir, 'alfred.md'),
        `# alfred MCP Tools

alfred's knowledge base contains extensive curated Claude Code docs and best practices with vector search.

## knowledge — Search docs and best practices

**ALWAYS call knowledge BEFORE** answering questions about Claude Code. Do not guess or rely on training data.

Call when the user's question or task involves ANY of:
- Hooks, skills, rules, agents, plugins, MCP servers, CLAUDE.md, memory
- Permissions, settings, compaction, CLI features, IDE integrations
- Best practices for Claude Code configuration or workflow
- Evaluating whether code follows Claude Code conventions

Do NOT call for: general programming, project-specific code, non-Claude-Code topics.
`,
      );
      console.log('[alfred] rules installed:', rulesDir);
    }
  } catch { /* ignore */ }
}

main().catch(() => { /* fail-open */ });
