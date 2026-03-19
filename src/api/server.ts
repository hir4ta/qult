import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Embedder } from "../embedder/index.js";
import { listAllEpics } from "../epic/index.js";
import { appendAudit } from "../spec/audit.js";
import type { ReviewStatus, SpecFile, SpecSize, SpecType } from "../spec/types.js";
import {
	completeTask,
	filesForSize,
	readActiveState,
	SpecDir,
	VALID_SLUG,
	verifyReviewFile,
	writeActiveState,
} from "../spec/types.js";
import { searchKnowledgeFTS } from "../store/fts.js";
import { computeGraphEdges } from "../store/graph.js";
import type { Store } from "../store/index.js";
import { getKnowledgeStats, setKnowledgeEnabled } from "../store/knowledge.js";
import { detectProject } from "../store/project.js";
import type { KnowledgeRow } from "../types.js";

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
	_emb: Embedder | null,
	version: string,
): Hono {
	const app = new Hono();
	const proj = detectProject(projectPath);
	const VALID_SPEC_FILES = new Set([
		"requirements.md", "design.md", "tasks.md", "test-specs.md",
		"decisions.md", "research.md", "session.md", "bugfix.md", "delta.md",
	]);

	function enrichTask(
		task: { slug: string; status?: string; started_at?: string; completed_at?: string; size?: string; spec_type?: string; review_status?: string },
		projPath: string,
		projectName: string,
	): Record<string, unknown> {
		const detail: Record<string, unknown> = { ...task, project_name: projectName };
		const sd = new SpecDir(projPath, task.slug);

		// Wave-centric progress from tasks.md.
		let totalChecked = 0;
		let totalAll = 0;
		try {
			const tasksContent = sd.readFile("tasks.md");
			const waves = parseWavesFromTasks(tasksContent);
			detail.waves = waves;

			for (const w of waves) {
				totalChecked += w.checked;
				totalAll += w.total;
			}

			// Focus = current wave title
			const currentWave = waves.find((w) => w.isCurrent);
			if (currentWave) detail.focus = currentWave.title;
		} catch { /* no tasks.md */ }

		detail.completed = totalChecked;
		detail.total = totalAll;
		return detail;
	}

	/** Parse tasks.md into wave info array for dashboard display. */
	function parseWavesFromTasks(content: string): Array<{ key: string; title: string; total: number; checked: number; isCurrent: boolean }> {
		const waves: Array<{ key: string; title: string; total: number; checked: number }> = [];
		let current: { key: string; title: string; total: number; checked: number } | null = null;

		for (const line of content.split("\n")) {
			const waveMatch = line.match(/^## Wave\s+(\d+)(?::\s*(.+))?/i);
			const closingMatch = line.match(/^## (?:Wave:\s*)?Closing(?:\s+Wave)?/i);

			if (waveMatch) {
				current = { key: waveMatch[1]!, title: waveMatch[2]?.trim() || `Wave ${waveMatch[1]}`, total: 0, checked: 0 };
				waves.push(current);
			} else if (closingMatch) {
				current = { key: "closing", title: "Closing", total: 0, checked: 0 };
				waves.push(current);
			} else if (current && line.match(/^- \[[ x]\] /)) {
				current.total++;
				if (line.startsWith("- [x] ")) current.checked++;
			}
		}

		// Determine current wave (first incomplete, excluding closing unless all others done).
		let currentKey = "";
		const nonClosing = waves.filter((w) => w.key !== "closing");
		const firstIncomplete = nonClosing.find((w) => w.checked < w.total);
		if (firstIncomplete) {
			currentKey = firstIncomplete.key;
		} else {
			// All non-closing done → closing is current (if incomplete)
			const closing = waves.find((w) => w.key === "closing");
			if (closing && closing.checked < closing.total) currentKey = "closing";
		}

		return waves.map((w) => ({ ...w, isCurrent: w.key === currentKey }));
	}

	// --- API Routes ---

	app.get("/api/version", (c) => c.json({ version }));
	app.get("/api/project", (c) => c.json({ path: projectPath, name: proj.name }));

	app.get("/api/tasks", (c) => {
		try {
			const state = readActiveState(projectPath);
			const enriched = state.tasks.map((task) => enrichTask(task, projectPath, proj.name));

			// Discover completed specs: directories in .alfred/specs/ not in _active.md.
			const specsDir = join(projectPath, ".alfred", "specs");
			const activeSlugs = new Set(state.tasks.map((t) => t.slug));
			let archived: Record<string, unknown>[] = [];
			try {
				const dirs = readdirSync(specsDir).filter((d) => {
					if (d.startsWith("_") || !VALID_SLUG.test(d) || activeSlugs.has(d)) return false;
					try { return statSync(join(specsDir, d)).isDirectory(); } catch { return false; }
				});
				archived = dirs.map((slug) =>
					enrichTask(
						{ slug, status: "completed", started_at: "" },
						projectPath,
						proj.name,
					),
				);
			} catch {
				/* no specs dir */
			}

			return c.json({ active: state.primary, tasks: [...enriched, ...archived], project_name: proj.name });
		} catch {
			return c.json({ active: "", tasks: [], project_name: proj.name });
		}
	});

	app.get("/api/tasks/:slug/specs/:file", (c) => {
		const slug = c.req.param("slug");
		const file = c.req.param("file");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		if (!VALID_SPEC_FILES.has(file)) return c.json({ error: "invalid spec file" }, 400);

		const sd = new SpecDir(projectPath, slug);
		try {
			const content = sd.readFile(file as SpecFile);
			return c.json({ content });
		} catch {
			return c.json({ error: "spec file not found" }, 404);
		}
	});

	// FR-4: Spec file version history
	app.get("/api/tasks/:slug/specs/:file/history", (c) => {
		const slug = c.req.param("slug");
		const file = c.req.param("file");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
		if (!VALID_SPEC_FILES.has(file)) return c.json({ error: "invalid spec file" }, 400);

		const sd = new SpecDir(projectPath, slug);
		const histDir = join(sd.dir(), ".history");
		const versions: Array<{ timestamp: string; size: number }> = [];
		try {
			const entries = readdirSync(histDir)
				.filter((e: string) => e.startsWith(`${file}.`))
				.sort()
				.reverse();
			for (const e of entries) {
				const ts = e.slice(file.length + 1);
				let size = 0;
				try { size = readFileSync(join(histDir, e), "utf-8").length; } catch {}
				versions.push({ timestamp: ts, size });
			}
		} catch { /* no history */ }
		return c.json({ versions, count: versions.length });
	});

	// FR-5: Spec file version content
	app.get("/api/tasks/:slug/specs/:file/versions/:version", (c) => {
		const slug = c.req.param("slug");
		const file = c.req.param("file");
		const version = c.req.param("version");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
		if (!VALID_SPEC_FILES.has(file)) return c.json({ error: "invalid spec file" }, 400);
		if (!/^[0-9T]{15}$/.test(version)) return c.json({ error: "invalid version format" }, 400);

		const sd = new SpecDir(projectPath, slug);
		const histPath = join(sd.dir(), ".history", `${file}.${version}`);
		try {
			const content = readFileSync(histPath, "utf-8");
			return c.json({ content, version });
		} catch {
			return c.json({ error: "version not found" }, 404);
		}
	});

	app.get("/api/tasks/:slug/specs", (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		const sections = sd.exists() ? sd.allSections() : [];
		return c.json({ specs: sections });
	});

	app.get("/api/tasks/:slug/validation", (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		if (!sd.exists()) return c.json({ error: "not found" }, 404);

		// Basic validation (same as dossier validate).
		let state;
		try {
			state = readActiveState(projectPath);
		} catch {
			return c.json({ checks: [] });
		}
		const task = state.tasks.find((t) => t.slug === slug);
		const size = (task?.size ?? "L") as SpecSize;
		const specType = (task?.spec_type ?? "feature") as SpecType;
		const expectedFiles = filesForSize(size, specType);
		const checks = expectedFiles.map((f) => {
			try {
				sd.readFile(f);
				return { name: f, status: "pass" };
			} catch {
				return { name: f, status: "fail" };
			}
		});
		return c.json({ checks });
	});

	app.get("/api/knowledge", (c) => {
		const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
		// Show all projects — cross-project knowledge dashboard.
		const rows = store.db
			.prepare(`
      SELECT id, file_path, content_hash, title, content, sub_type,
             project_remote, project_path, project_name, branch,
             created_at, updated_at, hit_count, last_accessed, enabled
      FROM knowledge_index WHERE enabled = 1 ORDER BY updated_at DESC LIMIT ?
    `)
			.all(limit) as Array<Record<string, unknown>>;
		const entries = rows.map((r: Record<string, unknown>) => ({
			id: r.id,
			label: r.title as string,
			source: r.file_path as string,
			sub_type: r.sub_type as string,
			hit_count: r.hit_count as number,
			content: r.content as string,
			saved_at: r.created_at as string,
			enabled: r.enabled === 1,
			project_name: r.project_name as string,
		}));
		return c.json({ entries });
	});

	app.get("/api/knowledge/search", (c) => {
		const query = c.req.query("q");
		if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);
		const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10) || 10, 500);
		const entries = searchKnowledgeFTS(store, query, limit);
		return c.json({ entries: entries.map(toKnowledgeEntry), method: "fts5" });
	});

	app.get("/api/knowledge/stats", (c) => {
		const stats = getKnowledgeStats(store);
		return c.json(stats);
	});

	// Graph edges endpoint with single-entry cache
	let graphCache: { edges: unknown[]; method: string; truncated: boolean } | null = null;
	let graphCacheKey = "";

	app.get("/api/knowledge/graph", (c) => {
		// Check if cache is still valid via MAX(updated_at) + COUNT
		const row = store.db
			.prepare("SELECT MAX(updated_at) as max_updated, COUNT(*) as cnt FROM knowledge_index WHERE enabled = 1")
			.get() as { max_updated: string | null; cnt: number };
		const currentKey = `${row.max_updated ?? ""}:${row.cnt}`;

		if (graphCache && currentKey === graphCacheKey) {
			return c.json(graphCache);
		}

		const result = computeGraphEdges(store);
		graphCache = result;
		graphCacheKey = currentKey;
		return c.json(result);
	});

	app.patch("/api/knowledge/:id/enabled", async (c) => {
		const id = parseInt(c.req.param("id"), 10);
		if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
		const body = await c.req.json<{ enabled: boolean }>();
		setKnowledgeEnabled(store, id, body.enabled);
		return c.json({ ok: true });
	});

	app.get("/api/activity", (c) => {
		const auditPath = join(projectPath, ".alfred", "audit.jsonl");
		const entries: unknown[] = [];
		try {
			const content = readFileSync(auditPath, "utf-8");
			for (const line of content.split("\n")) {
				if (line.trim()) {
					try {
						entries.push(JSON.parse(line));
					} catch {
						/* skip */
					}
				}
			}
		} catch {
			/* no audit file */
		}
		return c.json({ entries: entries.reverse().slice(0, 100) });
	});

	app.get("/api/epics", (c) => {
		const epics = listAllEpics(projectPath);
		return c.json({ epics });
	});

	app.get("/api/health", (c) => {
		const stats = getKnowledgeStats(store);
		return c.json({ total: stats.total, bySubType: stats.bySubType });
	});

	// --- Review API ---

	app.get("/api/tasks/:slug/review", (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		const reviewsDir = join(sd.dir(), "reviews");

		let status = "pending";
		try {
			const state = readActiveState(projectPath);
			status = state.tasks.find((t) => t.slug === slug)?.review_status ?? "pending";
		} catch {
			/* no active state */
		}

		let latestReview: unknown = null;
		let unresolvedCount = 0;

		try {
			const files = readdirSync(reviewsDir)
				.filter((f) => f.startsWith("review-") && f.endsWith(".json"))
				.sort()
				.reverse();
			if (files[0]) {
				const data = JSON.parse(readFileSync(join(reviewsDir, files[0]), "utf-8"));
				latestReview = data;
				if (Array.isArray(data.comments)) {
					unresolvedCount = data.comments.filter((c: { resolved?: boolean }) => !c.resolved).length;
				}
			}
		} catch {
			/* no reviews */
		}

		return c.json({
			review_status: status,
			latest_review: latestReview,
			unresolved_count: unresolvedCount,
		});
	});

	app.get("/api/tasks/:slug/review/history", (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const reviewsDir = join(new SpecDir(projectPath, slug).dir(), "reviews");
		const reviews: unknown[] = [];

		try {
			const files = readdirSync(reviewsDir)
				.filter((f) => f.startsWith("review-") && f.endsWith(".json"))
				.sort();
			for (const f of files) {
				try {
					const data = JSON.parse(readFileSync(join(reviewsDir, f), "utf-8"));
					reviews.push(data);
				} catch {
					/* skip corrupt files */
				}
			}
		} catch {
			/* no reviews dir */
		}

		return c.json({ reviews });
	});

	app.post("/api/tasks/:slug/review", async (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		if (!sd.exists()) return c.json({ error: "spec not found" }, 404);

		let body: { status: string; comments?: Array<{ file: string; line: number; body: string }> };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}

		const reviewStatus = body.status;
		if (reviewStatus !== "approved" && reviewStatus !== "changes_requested") {
			return c.json({ error: 'status must be "approved" or "changes_requested"' }, 400);
		}

		// Build review data with validated comment fields.
		const ts = new Date().toISOString();
		const rawComments = Array.isArray(body.comments) ? body.comments.slice(0, 100) : [];
		const review = {
			timestamp: ts,
			status: reviewStatus,
			comments: rawComments.map((comment) => ({
				file: String(comment.file ?? "").slice(0, 500),
				line: Math.max(0, Number(comment.line) || 0),
				body: String(comment.body ?? "").slice(0, 10000),
				resolved: false,
			})),
		};

		// Write review JSON file.
		const reviewsDir = join(sd.dir(), "reviews");
		mkdirSync(reviewsDir, { recursive: true });
		const filename = `review-${ts.replace(/[:.]/g, "")}-${Date.now() % 10000}.json`;
		writeFileSync(join(reviewsDir, filename), JSON.stringify(review, null, 2));

		// Update _active.md review_status.
		try {
			const state = readActiveState(projectPath);
			const task = state.tasks.find((t) => t.slug === slug);
			if (task) {
				task.review_status = reviewStatus as ReviewStatus;
				writeActiveState(projectPath, state);
			}
		} catch {
			/* state update failure is non-fatal */
		}

		// Audit log.
		appendAudit(projectPath, {
			action: "review.submit",
			target: slug,
			detail: `${reviewStatus} (${review.comments.length} comments)`,
			user: "dashboard",
		});

		return c.json({ ok: true, review_status: reviewStatus, file: filename });
	});

	// --- Complete API ---

	app.post("/api/tasks/:slug/complete", async (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		if (!sd.exists()) return c.json({ error: "spec not found" }, 404);

		// Read task state.
		let state;
		try {
			state = readActiveState(projectPath);
		} catch {
			return c.json({ error: "failed to read active state" }, 500);
		}
		const task = state.tasks.find((t) => t.slug === slug);
		if (!task) return c.json({ error: "task not found" }, 404);
		if (task.status === "completed") return c.json({ error: "task already completed" }, 400);

		// Approval gate: M/L/XL require approved review.
		if (["M", "L", "XL"].includes(task.size ?? "")) {
			if (task.review_status !== "approved") {
				return c.json({ error: `${task.size} spec requires approval before completion` }, 400);
			}
			const verification = verifyReviewFile(projectPath, slug);
			if (!verification.valid) {
				return c.json({ error: `review verification failed: ${verification.reason}` }, 400);
			}
		}

		// Complete the task.
		try {
			const newPrimary = completeTask(projectPath, slug);
			appendAudit(projectPath, {
				action: "spec.complete",
				target: slug,
				detail: "completed via dashboard",
				user: "dashboard",
			});
			return c.json({ ok: true, new_primary: newPrimary });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// --- File-level Approval API ---

	app.get("/api/tasks/:slug/file-approvals", (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const approvalsPath = join(new SpecDir(projectPath, slug).dir(), "file-approvals.json");
		try {
			const data = JSON.parse(readFileSync(approvalsPath, "utf-8")) as Record<string, boolean>;
			return c.json({ approvals: data });
		} catch {
			return c.json({ approvals: {} });
		}
	});

	app.post("/api/tasks/:slug/file-approvals", async (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		if (!sd.exists()) return c.json({ error: "spec not found" }, 404);

		let body: { file: string; approved: boolean };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}
		if (typeof body.file !== "string" || typeof body.approved !== "boolean") {
			return c.json({ error: "file (string) and approved (boolean) are required" }, 400);
		}

		if (!VALID_SPEC_FILES.has(body.file)) return c.json({ error: "invalid spec file" }, 400);

		// Read existing approvals.
		const approvalsPath = join(sd.dir(), "file-approvals.json");
		let approvals: Record<string, boolean> = {};
		try {
			approvals = JSON.parse(readFileSync(approvalsPath, "utf-8"));
		} catch {
			/* new file */
		}

		approvals[body.file] = body.approved;
		writeFileSync(approvalsPath, JSON.stringify(approvals, null, 2));

		// Check if all spec files are approved → auto-submit review approval.
		let state;
		try {
			state = readActiveState(projectPath);
		} catch {
			return c.json({ approvals });
		}
		const task = state.tasks.find((t) => t.slug === slug);
		const size = (task?.size ?? "L") as SpecSize;
		const specType = (task?.spec_type ?? "feature") as SpecType;
		const expectedFiles = filesForSize(size, specType);
		const allApproved = expectedFiles.every((f) => approvals[f] === true);

		if (allApproved && task && task.review_status !== "approved") {
			// Auto-submit approval review.
			const ts = new Date().toISOString();
			const review = { timestamp: ts, status: "approved", comments: [] };
			const reviewsDir = join(sd.dir(), "reviews");
			mkdirSync(reviewsDir, { recursive: true });
			const filename = `review-${ts.replace(/[:.]/g, "")}-${Date.now() % 10000}.json`;
			writeFileSync(join(reviewsDir, filename), JSON.stringify(review, null, 2));

			task.review_status = "approved" as ReviewStatus;
			writeActiveState(projectPath, state);

			appendAudit(projectPath, {
				action: "review.submit",
				target: slug,
				detail: "approved (all files approved via dashboard)",
				user: "dashboard",
			});
		}

		return c.json({ approvals, all_approved: allApproved });
	});

	// --- SSE ---
	app.get("/api/events", (c) => {
		return c.newResponse(
			new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

					// Poll .alfred/ for changes every 5s.
					const alfredDir = join(projectPath, ".alfred");
					let lastMtime = dirMaxMtime(alfredDir);
					const interval = setInterval(() => {
						const mtime = dirMaxMtime(alfredDir);
						if (mtime > lastMtime) {
							lastMtime = mtime;
							controller.enqueue(encoder.encode("event: refresh\ndata: {}\n\n"));
						}
					}, 5000);

					const signal = c.req.raw.signal;
					if (signal) {
						signal.addEventListener("abort", () => {
							clearInterval(interval);
							controller.close();
						});
					}
				},
			}),
			{
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			},
		);
	});

	// --- SPA serving ---
	if (process.env.ALFRED_DEV === "1") {
		// Dev mode: proxy to Vite.
		app.all("/*", async (c) => {
			const url = new URL(c.req.url);
			url.host = "localhost:5173";
			url.protocol = "http:";
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
			app.use("/*", serveStatic({ root: webDistPath }));
			// SPA fallback: serve index.html for client-side routing.
			app.get("*", (c) => {
				const indexPath = join(webDistPath, "index.html");
				try {
					const html = readFileSync(indexPath, "utf-8");
					return c.html(html);
				} catch {
					return c.text("Dashboard not built. Run: npm run build:web", 404);
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
			console.error("\nshutting down...");
			server.close(() => resolve());
			// Force exit after 2s if server doesn't close gracefully (e.g., open SSE connections).
			setTimeout(() => process.exit(0), 2000);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

function resolveWebDist(): string {
	// Try relative to this file (npm package layout).
	const thisDir = fileURLToPath(new URL(".", import.meta.url));
	const candidates = [join(thisDir, "..", "web", "dist"), join(thisDir, "..", "..", "web", "dist")];
	for (const p of candidates) {
		if (existsSync(join(p, "index.html"))) return p;
	}
	return join(process.cwd(), "web", "dist");
}

function dirMaxMtime(dir: string, depth = 3): number {
	let maxT = 0;
	try {
		for (const entry of readdirSync(dir)) {
			try {
				const full = join(dir, entry);
				const info = statSync(full);
				if (info.mtimeMs > maxT) maxT = info.mtimeMs;
				if (info.isDirectory() && depth > 1) {
					const sub = dirMaxMtime(full, depth - 1);
					if (sub > maxT) maxT = sub;
				}
			} catch {}
		}
	} catch {
		/* dir doesn't exist */
	}
	return maxT;
}

function openBrowser(url: string): void {
	import("node:child_process")
		.then(({ execSync }) => {
			if (process.platform === "darwin") {
				execSync(`open "${url}"`, { stdio: "ignore" });
			} else if (process.platform === "linux") {
				execSync(`xdg-open "${url}"`, { stdio: "ignore" });
			}
		})
		.catch(() => {
			/* ignore */
		});
}
