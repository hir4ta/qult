import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';
import {
  SpecDir, readActiveState, writeActiveState, VALID_SLUG, filesForSize,
} from '../spec/types.js';
import type { SpecFile, SpecSize, SpecType, ReviewStatus } from '../spec/types.js';
import { listAllEpics } from '../epic/index.js';
import {
  listAllKnowledge, getKnowledgeStats, setKnowledgeEnabled,
} from '../store/knowledge.js';
import { searchKnowledgeFTS } from '../store/fts.js';
import { detectProject } from '../store/project.js';
import { appendAudit } from '../spec/audit.js';
import type { KnowledgeRow } from '../types.js';

/** Map KnowledgeRow to frontend KnowledgeEntry shape. */
function toKnowledgeEntry(r: KnowledgeRow) {
  return {
    id: r.id,
    label: r.title,
    source: r.filePath,
    sub_type: r.subType,
    hit_count: r.hitCount,
    content: r.content,
    saved_at: r.createdAt,
    enabled: r.enabled,
  };
}

export interface DashboardOptions {
  port: number;
  urlOnly: boolean;
  version: string;
}

export function createApp(
  projectPath: string,
  store: Store,
  emb: Embedder | null,
  version: string,
): Hono {
  const app = new Hono();
  const proj = detectProject(projectPath);

  // --- API Routes ---

  app.get('/api/version', (c) => c.json({ version }));
  app.get('/api/project', (c) => c.json({ path: projectPath, name: proj.name }));

  app.get('/api/tasks', (c) => {
    try {
      const state = readActiveState(projectPath);
      return c.json({ active: state.primary, tasks: state.tasks });
    } catch {
      return c.json({ active: '', tasks: [] });
    }
  });

  app.get('/api/tasks/:slug/specs/:file', (c) => {
    const slug = c.req.param('slug');
    const file = c.req.param('file');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const sd = new SpecDir(projectPath, slug);
    try {
      const content = sd.readFile(file as SpecFile);
      return c.json({ content });
    } catch {
      return c.json({ error: 'spec file not found' }, 404);
    }
  });

  app.get('/api/tasks/:slug/specs', (c) => {
    const slug = c.req.param('slug');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const sd = new SpecDir(projectPath, slug);
    const sections = sd.exists() ? sd.allSections() : [];
    return c.json({ specs: sections });
  });

  app.get('/api/tasks/:slug/validation', (c) => {
    const slug = c.req.param('slug');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const sd = new SpecDir(projectPath, slug);
    if (!sd.exists()) return c.json({ error: 'not found' }, 404);

    // Basic validation (same as dossier validate).
    let state;
    try { state = readActiveState(projectPath); } catch { return c.json({ checks: [] }); }
    const task = state.tasks.find(t => t.slug === slug);
    const size = (task?.size ?? 'L') as SpecSize;
    const specType = (task?.spec_type ?? 'feature') as SpecType;
    const expectedFiles = filesForSize(size, specType);
    const checks = expectedFiles.map(f => {
      try { sd.readFile(f); return { name: f, status: 'pass' }; }
      catch { return { name: f, status: 'fail' }; }
    });
    return c.json({ checks });
  });

  app.get('/api/knowledge', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500);
    const entries = listAllKnowledge(store, proj.remote, proj.path, limit);
    return c.json({ entries: entries.map(toKnowledgeEntry) });
  });

  app.get('/api/knowledge/search', (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 500);
    const entries = searchKnowledgeFTS(store, query, limit);
    return c.json({ entries: entries.map(toKnowledgeEntry), method: 'fts5' });
  });

  app.get('/api/knowledge/stats', (c) => {
    const stats = getKnowledgeStats(store);
    return c.json(stats);
  });

  app.patch('/api/knowledge/:id/enabled', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json<{ enabled: boolean }>();
    setKnowledgeEnabled(store, id, body.enabled);
    return c.json({ ok: true });
  });

  app.get('/api/activity', (c) => {
    const auditPath = join(projectPath, '.alfred', 'audit.jsonl');
    const entries: unknown[] = [];
    try {
      const content = readFileSync(auditPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* no audit file */ }
    return c.json({ entries: entries.reverse().slice(0, 100) });
  });

  app.get('/api/epics', (c) => {
    const epics = listAllEpics(projectPath);
    return c.json({ epics });
  });

  app.get('/api/health', (c) => {
    const stats = getKnowledgeStats(store);
    return c.json({ total: stats.total, bySubType: stats.bySubType });
  });

  // --- Review API ---

  app.get('/api/tasks/:slug/review', (c) => {
    const slug = c.req.param('slug');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const sd = new SpecDir(projectPath, slug);
    const reviewsDir = join(sd.dir(), 'reviews');

    let status = 'pending';
    try {
      const state = readActiveState(projectPath);
      status = state.tasks.find(t => t.slug === slug)?.review_status ?? 'pending';
    } catch { /* no active state */ }

    let latestReview: unknown = null;
    let unresolvedCount = 0;

    try {
      const files = readdirSync(reviewsDir)
        .filter(f => f.startsWith('review-') && f.endsWith('.json'))
        .sort().reverse();
      if (files[0]) {
        const data = JSON.parse(readFileSync(join(reviewsDir, files[0]), 'utf-8'));
        latestReview = data;
        if (Array.isArray(data.comments)) {
          unresolvedCount = data.comments.filter((c: { resolved?: boolean }) => !c.resolved).length;
        }
      }
    } catch { /* no reviews */ }

    return c.json({ review_status: status, latest_review: latestReview, unresolved_count: unresolvedCount });
  });

  app.get('/api/tasks/:slug/review/history', (c) => {
    const slug = c.req.param('slug');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const reviewsDir = join(new SpecDir(projectPath, slug).dir(), 'reviews');
    const reviews: unknown[] = [];

    try {
      const files = readdirSync(reviewsDir)
        .filter(f => f.startsWith('review-') && f.endsWith('.json'))
        .sort();
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(reviewsDir, f), 'utf-8'));
          reviews.push(data);
        } catch { /* skip corrupt files */ }
      }
    } catch { /* no reviews dir */ }

    return c.json({ reviews });
  });

  app.post('/api/tasks/:slug/review', async (c) => {
    const slug = c.req.param('slug');
    if (!VALID_SLUG.test(slug)) return c.json({ error: 'invalid slug' }, 400);

    const sd = new SpecDir(projectPath, slug);
    if (!sd.exists()) return c.json({ error: 'spec not found' }, 404);

    let body: { status: string; comments?: Array<{ file: string; line: number; body: string }> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const reviewStatus = body.status;
    if (reviewStatus !== 'approved' && reviewStatus !== 'changes_requested') {
      return c.json({ error: 'status must be "approved" or "changes_requested"' }, 400);
    }

    // Build review data with validated comment fields.
    const ts = new Date().toISOString();
    const rawComments = Array.isArray(body.comments) ? body.comments.slice(0, 100) : [];
    const review = {
      timestamp: ts,
      status: reviewStatus,
      comments: rawComments.map(c => ({
        file: String(c.file ?? '').slice(0, 500),
        line: Math.max(0, Number(c.line) || 0),
        body: String(c.body ?? '').slice(0, 10000),
        resolved: false,
      })),
    };

    // Write review JSON file.
    const reviewsDir = join(sd.dir(), 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    const filename = `review-${ts.replace(/[:.]/g, '')}-${Date.now() % 10000}.json`;
    writeFileSync(join(reviewsDir, filename), JSON.stringify(review, null, 2));

    // Update _active.md review_status.
    try {
      const state = readActiveState(projectPath);
      const task = state.tasks.find(t => t.slug === slug);
      if (task) {
        task.review_status = reviewStatus as ReviewStatus;
        writeActiveState(projectPath, state);
      }
    } catch { /* state update failure is non-fatal */ }

    // Audit log.
    appendAudit(projectPath, {
      action: 'review.submit',
      target: slug,
      detail: `${reviewStatus} (${review.comments.length} comments)`,
      user: 'dashboard',
    });

    return c.json({ ok: true, review_status: reviewStatus, file: filename });
  });

  // --- SSE ---
  app.get('/api/events', (c) => {
    return c.newResponse(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));

          // Poll .alfred/ for changes every 5s.
          const alfredDir = join(projectPath, '.alfred');
          let lastMtime = dirMaxMtime(alfredDir);
          const interval = setInterval(() => {
            const mtime = dirMaxMtime(alfredDir);
            if (mtime > lastMtime) {
              lastMtime = mtime;
              controller.enqueue(encoder.encode('event: refresh\ndata: {}\n\n'));
            }
          }, 5000);

          const signal = c.req.raw.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              clearInterval(interval);
              controller.close();
            });
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    );
  });

  // --- SPA serving ---
  if (process.env['ALFRED_DEV'] === '1') {
    // Dev mode: proxy to Vite.
    app.all('/*', async (c) => {
      const url = new URL(c.req.url);
      url.host = 'localhost:5173';
      url.protocol = 'http:';
      const resp = await fetch(url.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    });
  } else {
    // Production: serve from web/dist/.
    const webDistPath = resolveWebDist();
    if (webDistPath && existsSync(webDistPath)) {
      app.use('/*', serveStatic({ root: webDistPath }));
      // SPA fallback: serve index.html for client-side routing.
      app.get('*', (c) => {
        const indexPath = join(webDistPath, 'index.html');
        try {
          const html = readFileSync(indexPath, 'utf-8');
          return c.html(html);
        } catch {
          return c.text('Dashboard not built. Run: npm run build:web', 404);
        }
      });
    }
  }

  return app;
}

export async function startDashboard(
  projectPath: string,
  store: Store,
  emb: Embedder | null,
  opts: DashboardOptions,
): Promise<void> {
  const app = createApp(projectPath, store, emb, opts.version);
  const addr = `http://localhost:${opts.port}`;

  if (opts.urlOnly) {
    console.log(addr);
  } else {
    console.error(`alfred dashboard: ${addr}`);
    openBrowser(addr);
  }

  const server = serve({ fetch: app.fetch, port: opts.port });

  // Wait for signal and properly close the server.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.error('\nshutting down...');
      server.close(() => resolve());
      // Force exit after 2s if server doesn't close gracefully (e.g., open SSE connections).
      setTimeout(() => process.exit(0), 2000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function resolveWebDist(): string {
  // Try relative to this file (npm package layout).
  const thisDir = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(thisDir, '..', 'web', 'dist'),
    join(thisDir, '..', '..', 'web', 'dist'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return join(process.cwd(), 'web', 'dist');
}

function dirMaxMtime(dir: string): number {
  let maxT = 0;
  try {
    for (const entry of readdirSync(dir)) {
      try {
        const info = statSync(join(dir, entry));
        if (info.mtimeMs > maxT) maxT = info.mtimeMs;
        if (info.isDirectory()) {
          for (const sub of readdirSync(join(dir, entry))) {
            try {
              const si = statSync(join(dir, entry, sub));
              if (si.mtimeMs > maxT) maxT = si.mtimeMs;
            } catch { continue; }
          }
        }
      } catch { continue; }
    }
  } catch { /* dir doesn't exist */ }
  return maxT;
}

function openBrowser(url: string): void {
  import('node:child_process').then(({ execSync }) => {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  }).catch(() => { /* ignore */ });
}
