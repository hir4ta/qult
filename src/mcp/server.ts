import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import { handleDossier } from './dossier.js';
import { handleRoster } from './roster.js';
import { handleLedger } from './ledger.js';

const SERVER_INSTRUCTIONS = `alfred is your development butler for Claude Code.

When to use alfred tools:
- Starting a new development task → call dossier with action=init
- Making design decisions → call dossier with action=update
- Starting/resuming a session → call dossier with action=status
- Searching past experiences or saving notes → call ledger
- Grouping related tasks into an epic → call roster with action=init, then link tasks
- Checking epic progress → call roster with action=status
`;

export function createMCPServer(store: Store, emb: Embedder | null, version: string): McpServer {
  const server = new McpServer(
    { name: 'alfred', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    'dossier',
    `Unified spec management for development tasks. Persists context across compaction and sessions.

Actions: status (read-only), init, update, switch, complete, delete (2-phase: preview then confirm=true), history, rollback, review, validate (read-only).

task_slug format: lowercase alphanumeric with hyphens (e.g. "my-feature", max 64 chars).
Size-based scaling: init accepts size (S/M/L/XL) and spec_type (feature/bugfix). S=3 files, M=4-5 files, L/XL=7 files.`,
    {
      action: z.enum(['init', 'update', 'status', 'switch', 'complete', 'delete', 'history', 'rollback', 'review', 'validate']).describe('Action to perform'),
      project_path: z.string().optional().describe('Project root path (defaults to cwd)'),
      task_slug: z.string().optional().describe('Task identifier'),
      description: z.string().optional().describe('Brief task description (for init)'),
      file: z.enum(['requirements.md', 'design.md', 'tasks.md', 'test-specs.md', 'decisions.md', 'research.md', 'session.md', 'bugfix.md']).optional().describe('Spec file (for update/history/rollback)'),
      content: z.string().optional().describe('Content to write (for update)'),
      mode: z.enum(['append', 'replace']).optional().describe('Write mode (for update)'),
      size: z.enum(['S', 'M', 'L', 'XL']).optional().describe('Spec size for init'),
      spec_type: z.enum(['feature', 'bugfix']).optional().describe('Spec type for init'),
      version: z.string().optional().describe('Version timestamp for rollback'),
      confirm: z.boolean().optional().describe('Required for delete: preview first, then confirm=true'),
    },
    async (params) => {
      return handleDossier(store, emb, params);
    },
  );

  server.tool(
    'roster',
    `Epic management — group related tasks with dependencies and progress tracking.

Actions: init, status, link, unlink, order, list, update, delete (2-phase: preview then confirm=true).`,
    {
      action: z.enum(['init', 'status', 'link', 'unlink', 'order', 'list', 'update', 'delete']).describe('Action to perform'),
      project_path: z.string().optional().describe('Project root path (defaults to cwd)'),
      epic_slug: z.string().optional().describe('Epic identifier'),
      task_slug: z.string().optional().describe('Task to link/unlink'),
      name: z.string().optional().describe('Epic display name'),
      depends_on: z.string().optional().describe('Comma-separated task slugs this task depends on'),
      status: z.string().optional().describe('Epic status: draft, in-progress, completed, archived'),
      confirm: z.boolean().optional().describe('Required for delete: preview first, then confirm=true'),
    },
    async (params) => {
      return handleRoster(store, params);
    },
  );

  server.tool(
    'ledger',
    `Long-term knowledge search, save, and health management — memories and past specs, searchable across sessions and projects.

Actions:
- search (default): Search past memories AND completed specs
- save: Save a new memory entry for future retrieval
- promote: Promote a memory's sub_type (general→pattern or pattern→rule)
- candidates: List memories that qualify for promotion based on hit_count
- reflect: Health report — stats, conflicts, stale memories, promotion candidates
- audit-conventions: Check pattern/rule memories against the codebase for drift`,
    {
      action: z.enum(['search', 'save', 'promote', 'candidates', 'reflect', 'stale', 'audit-conventions']).describe('Action to perform'),
      id: z.number().optional().describe('Record ID (required for promote)'),
      query: z.string().optional().describe('Search query'),
      content: z.string().optional().describe('Content to save'),
      label: z.string().optional().describe('Short label for saved memory'),
      project: z.string().optional().describe("Project name (default: 'general')"),
      limit: z.number().optional().describe('Maximum search results (default: 10)'),
      detail: z.enum(['compact', 'summary', 'full']).optional().describe('Response verbosity'),
      sub_type: z.enum(['general', 'decision', 'pattern', 'rule']).optional().describe('Memory classification'),
      title: z.string().optional().describe('Structured knowledge: title'),
      context_text: z.string().optional().describe('Structured knowledge: context'),
      reasoning: z.string().optional().describe('Structured knowledge: reasoning'),
      alternatives: z.string().optional().describe('Comma-separated rejected alternatives'),
      category: z.string().optional().describe('Rule category'),
      priority: z.string().optional().describe('Rule priority p0/p1/p2'),
      project_path: z.string().optional().describe('Project root path'),
    },
    async (params) => {
      return handleLedger(store, emb, params);
    },
  );

  return server;
}

export async function serveMCP(store: Store, emb: Embedder | null, version: string): Promise<void> {
  const server = createMCPServer(store, emb, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
