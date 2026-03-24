import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import type { Embedder } from "../embedder/index.js";
import type { SpecFile, SpecSize, SpecType } from "../spec/types.js";
import {
	completeTask,
	filesForSize,
	readActiveState,
	SpecDir,
	VALID_SLUG,
	writeActiveState,
} from "../spec/types.js";
import { searchKnowledgeFTS, searchUnified } from "../store/fts.js";
import type { Store } from "../store/index.js";
import { getKnowledgeStats, getPromotionCandidates, promoteSubType, setKnowledgeEnabled } from "../store/knowledge.js";
import {
	getProject,
	listActiveProjects,
	listProjects,
	renameProject,
	resolveOrRegisterProject,
	updateProjectStatus,
} from "../store/project.js";
import type { KnowledgeRow } from "../types.js";

/** Map KnowledgeRow to frontend KnowledgeEntry shape. */
function toKnowledgeEntry(r: KnowledgeRow, projectName?: string) {
	let tags: string[] = [];
	try { tags = JSON.parse(r.content).tags ?? []; } catch { /* raw content */ }
	return {
		id: r.id,
		label: r.title,
		source: r.filePath,
		sub_type: r.subType,
		hit_count: r.hitCount,
		content: r.content,
		saved_at: r.createdAt,
		enabled: Boolean(r.enabled),
		author: r.author ?? "",
		project_name: projectName ?? "",
		tags,
		verification_due: r.verificationDue ?? null,
		last_verified: r.lastVerified ?? null,
		verification_count: r.verificationCount ?? 0,
	};
}

export interface DashboardOptions {
	port: number;
	urlOnly: boolean;
	version: string;
}

const VALID_SPEC_FILES = new Set([
	"requirements.md", "design.md", "tasks.md", "test-specs.md",
	"decisions.md", "research.md", "session.md", "bugfix.md",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(
	projectPath: string,
	store: Store,
	_emb: Embedder | null,
	version: string,
): Hono {
	const app = new Hono();
	const proj = resolveOrRegisterProject(store, projectPath);

	// --- Helper: resolve project filter from query param ---
	function getProjectFilter(query: string | undefined): string | undefined {
		if (!query) return undefined;
		if (!UUID_RE.test(query)) return undefined;
		return query;
	}

	function enrichTask(
		task: { slug: string; status?: string; started_at?: string; completed_at?: string; size?: string; spec_type?: string; owner?: string },
		projPath: string,
		projectName: string,
		projectId?: string,
	): Record<string, unknown> {
		const detail: Record<string, unknown> = { ...task, project_name: projectName, project_id: projectId };
		const sd = new SpecDir(projPath, task.slug);

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

			const currentWave = waves.find((w) => w.isCurrent);
			if (currentWave) detail.focus = currentWave.title;
		} catch { /* no tasks.md */ }

		detail.completed = totalChecked;
		detail.total = totalAll;

		// Infer size and dates from spec directory for archived tasks
		if (!detail.size || !detail.started_at) {
			try {
				const dirPath = sd.dir();
				const specFiles = readdirSync(dirPath).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
				if (!detail.size) {
					if (specFiles.length <= 3) detail.size = "S";
					else if (specFiles.length <= 4) detail.size = "M";
					else detail.size = "L";
				}
				if (!detail.started_at) {
					const dirStat = statSync(dirPath);
					detail.started_at = dirStat.birthtime.toISOString();
				}
			} catch { /* no spec dir */ }
		}

		return detail;
	}

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
			} else if (current && line.match(/^- \[[ xX]\] /)) {
				current.total++;
				if (/^- \[[xX]\] /.test(line)) current.checked++;
			}
		}

		let currentKey = "";
		const nonClosing = waves.filter((w) => w.key !== "closing");
		const firstIncomplete = nonClosing.find((w) => w.checked < w.total);
		if (firstIncomplete) {
			currentKey = firstIncomplete.key;
		} else {
			const closing = waves.find((w) => w.key === "closing");
			if (closing && closing.checked < closing.total) currentKey = "closing";
		}

		return waves.map((w) => ({ ...w, isCurrent: w.key === currentKey }));
	}

	/** Collect tasks from a single project path. */
	function collectProjectTasks(projPath: string, projName: string, projId: string): {
		active: string;
		tasks: Record<string, unknown>[];
	} {
		let state: { primary: string; tasks: Array<{ slug: string; status?: string; started_at?: string; completed_at?: string; size?: string; spec_type?: string; owner?: string }> };
		try {
			state = readActiveState(projPath);
		} catch {
			state = { primary: "", tasks: [] };
		}

		const enriched = state.tasks.map((task) => enrichTask(task, projPath, projName, projId));
		const activeSlugs = new Set(state.tasks.map((t) => t.slug));

		// Collect completed specs (directories in specs/ not in _active.md)
		let archived: Record<string, unknown>[] = [];
		const specsDir = join(projPath, ".alfred", "specs");
		try {
			const dirs = readdirSync(specsDir).filter((d) => {
				if (d.startsWith("_") || !VALID_SLUG.test(d) || activeSlugs.has(d)) return false;
				try { return statSync(join(specsDir, d)).isDirectory(); } catch { return false; }
			});
			archived = dirs.map((slug) =>
				enrichTask({ slug, status: "completed", started_at: "" }, projPath, projName, projId),
			);
		} catch { /* no specs dir */ }

		return { active: state.primary, tasks: [...enriched, ...archived] };
	}

	// --- API Routes ---

	app.get("/api/version", (c) => c.json({ version }));
	app.get("/api/project", (c) => c.json({ path: projectPath, name: proj.name, id: proj.id }));

	// --- Projects API (T-2.1: FR-2) ---

	app.get("/api/projects", (c) => {
		const projects = listProjects(store);
		return c.json({ projects });
	});

	app.get("/api/projects/:id", (c) => {
		const id = c.req.param("id");
		const project = getProject(store, id);
		if (!project) return c.json({ error: "project not found" }, 404);
		return c.json(project);
	});

	app.patch("/api/projects/:id", async (c) => {
		const id = c.req.param("id");
		const project = getProject(store, id);
		if (!project) return c.json({ error: "project not found" }, 404);

		let body: { name?: string; status?: string };
		try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }

		if (body.name && typeof body.name === "string") {
			const trimmed = body.name.trim();
			if (!trimmed || trimmed.length > 255) return c.json({ error: "name must be 1-255 chars" }, 400);
			renameProject(store, id, trimmed);
		}
		if (body.status && ["active", "archived"].includes(body.status)) {
			updateProjectStatus(store, id, body.status as "active" | "archived");
		}
		return c.json({ ok: true });
	});

	// --- Tasks API (T-2.3: FR-7, FR-8) ---

	app.get("/api/tasks", (c) => {
		const filterProjectId = getProjectFilter(c.req.query("project"));

		if (filterProjectId) {
			// Single project mode
			const filterProj = getProject(store, filterProjectId);
			if (!filterProj) return c.json({ active: "", tasks: [], project_name: "" });

			if (existsSync(filterProj.path)) {
				const result = collectProjectTasks(filterProj.path, filterProj.name, filterProj.id);
				return c.json({ ...result, project_name: filterProj.name });
			}
			// Missing project — return cached data from spec_index
			return c.json({ active: "", tasks: [], project_name: filterProj.name, stale: true, last_seen_at: filterProj.lastSeenAt });
		}

		// Cross-project mode: collect from all active projects
		const allTasks: Record<string, unknown>[] = [];
		let primaryActive = "";
		const activeProjects = listActiveProjects(store);

		for (const p of activeProjects) {
			if (!existsSync(p.path)) continue;
			const result = collectProjectTasks(p.path, p.name, p.id);
			allTasks.push(...result.tasks);
			// Use current project's active as primary
			if (p.id === proj.id && result.active) primaryActive = result.active;
		}

		return c.json({ active: primaryActive, tasks: allTasks, project_name: proj.name });
	});


	app.get("/api/tasks/:slug/specs/:file", (c) => {
		const slug = c.req.param("slug");
		const file = c.req.param("file");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
		if (!VALID_SPEC_FILES.has(file)) return c.json({ error: "invalid spec file" }, 400);

		// Resolve project: explicit ?project= param, or default to current project
		const filterProjectId = getProjectFilter(c.req.query("project"));
		let targetPath = projectPath;
		if (filterProjectId) {
			const filterProj = getProject(store, filterProjectId);
			if (!filterProj) return c.json({ error: "project not found" }, 404);
			targetPath = filterProj.path;
		}

		const sd = new SpecDir(targetPath, slug);
		try {
			const content = sd.readFile(file as SpecFile);
			return c.json({ content });
		} catch {
			return c.json({ error: "spec file not found" }, 404);
		}
	});

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

		let state;
		try { state = readActiveState(projectPath); } catch {
			return c.json({ checks: [], summary: "0/0 passed" });
		}
		const task = state.tasks.find((t) => t.slug === slug);
		const size = (task?.size ?? "L") as SpecSize;
		const specType = (task?.spec_type ?? "feature") as SpecType;
		const expectedFiles = filesForSize(size, specType);
		const checks = expectedFiles.map((f) => {
			try { sd.readFile(f); return { name: f, status: "pass", message: `${f} exists` }; }
			catch { return { name: f, status: "fail", message: `${f} missing` }; }
		});
		const passed = checks.filter((ch) => ch.status === "pass").length;
		return c.json({ checks, summary: `${passed}/${checks.length} passed` });
	});

	// --- Knowledge API (T-2.3: FR-7) ---

	app.get("/api/knowledge", (c) => {
		const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
		const filterProjectId = getProjectFilter(c.req.query("project"));
		const projectFilter = filterProjectId ? "AND ki.project_id = ?" : "";
		const params: unknown[] = [];
		if (filterProjectId) params.push(filterProjectId);
		params.push(limit);

		const rows = store.db
			.prepare(`
      SELECT ki.id, ki.file_path, ki.content_hash, ki.title, ki.content, ki.sub_type,
             ki.project_id, ki.branch,
             ki.created_at, ki.updated_at, ki.hit_count, ki.last_accessed, ki.enabled,
             COALESCE(p.name, '') as project_name
      FROM knowledge_index ki
      LEFT JOIN projects p ON p.id = ki.project_id
      WHERE ki.enabled = 1 ${projectFilter} ORDER BY ki.updated_at DESC LIMIT ?
    `)
			.all(...params) as Array<Record<string, unknown>>;
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

	// --- Unified Search API (T-2.2: FR-5, FR-6) ---

	app.get("/api/search", (c) => {
		const query = c.req.query("q");
		if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);
		const scope = c.req.query("scope"); // "all" | "knowledge" | "spec"
		const filterProjectId = getProjectFilter(c.req.query("project"));
		const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);

		let sources: ("knowledge" | "spec")[] = ["knowledge", "spec"];
		if (scope === "knowledge") sources = ["knowledge"];
		else if (scope === "spec") sources = ["spec"];

		const results = searchUnified(store, query, {
			sources,
			projectId: filterProjectId,
			limit,
		});
		return c.json({ results, method: "fts5", count: results.length });
	});

	app.get("/api/knowledge/search", (c) => {
		const query = c.req.query("q");
		if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);
		const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10) || 10, 500);
		const entries = searchKnowledgeFTS(store, query, limit);
		return c.json({ entries: entries.map((r) => toKnowledgeEntry(r)), method: "fts5" });
	});

	app.get("/api/knowledge/stats", (c) => {
		const filterProjectId = getProjectFilter(c.req.query("project"));
		const stats = getKnowledgeStats(store, filterProjectId);
		return c.json(stats);
	});

	app.get("/api/decisions", (c) => {
		const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
		const filterProjectId = getProjectFilter(c.req.query("project"));
		const projectFilter = filterProjectId ? "AND ki.project_id = ?" : "";
		const params: unknown[] = [];
		if (filterProjectId) params.push(filterProjectId);
		params.push(limit);

		const rows = store.db
			.prepare(`
      SELECT ki.id, ki.file_path, ki.content_hash, ki.title, ki.content, ki.sub_type,
             ki.project_id, ki.branch,
             ki.created_at, ki.updated_at, ki.hit_count, ki.last_accessed, ki.enabled,
             COALESCE(p.name, '') as project_name
      FROM knowledge_index ki
      LEFT JOIN projects p ON p.id = ki.project_id
      WHERE ki.enabled = 1 AND ki.sub_type = 'decision' ${projectFilter}
      ORDER BY ki.created_at DESC LIMIT ?
    `)
			.all(...params) as Array<Record<string, unknown>>;
		const mapped = rows.map((r) => ({
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
		return c.json({ decisions: mapped });
	});

	app.patch("/api/knowledge/:id/enabled", async (c) => {
		const id = parseInt(c.req.param("id"), 10);
		if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
		const body = await c.req.json<{ enabled: boolean }>();
		setKnowledgeEnabled(store, id, body.enabled);
		return c.json({ ok: true });
	});

	app.get("/api/knowledge/gaps", (c) => {
		const gapsPath = join(projectPath, ".alfred", ".state", "knowledge-gaps.jsonl");
		try {
			const raw = readFileSync(gapsPath, "utf-8");
			const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
			const entries = raw.split("\n")
				.filter((l) => l.trim())
				.map((l) => { try { return JSON.parse(l); } catch { return null; } })
				.filter((e: Record<string, unknown> | null): e is Record<string, unknown> => e != null && ((e.timestamp as string) ?? "") >= thirtyDaysAgo);
			return c.json({ entries, total: entries.length });
		} catch {
			return c.json({ entries: [], total: 0 });
		}
	});

	app.get("/api/knowledge/candidates", (c) => {
		const candidates = getPromotionCandidates(store).map((r) => toKnowledgeEntry(r));
		return c.json({ candidates });
	});

	app.post("/api/knowledge/:id/promote", (c) => {
		const id = parseInt(c.req.param("id"), 10);
		if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
		try {
			promoteSubType(store, id, "rule");
			return c.json({ promoted: true, new_sub_type: "rule" });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 400);
		}
	});

	app.get("/api/health", (c) => {
		const stats = getKnowledgeStats(store);
		return c.json({ total: stats.total, bySubType: stats.bySubType });
	});

	// --- Complete API ---

	app.post("/api/tasks/:slug/complete", async (c) => {
		const slug = c.req.param("slug");
		if (!VALID_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

		const sd = new SpecDir(projectPath, slug);
		if (!sd.exists()) return c.json({ error: "spec not found" }, 404);

		let state;
		try { state = readActiveState(projectPath); }
		catch { return c.json({ error: "failed to read active state" }, 500); }
		const task = state.tasks.find((t) => t.slug === slug);
		if (!task) return c.json({ error: "task not found" }, 404);
		if (task.status === "completed") return c.json({ error: "task already completed" }, 400);

		try {
			const newPrimary = completeTask(projectPath, slug);
			return c.json({ ok: true, new_primary: newPrimary });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// --- SSE (T-2.4: FR-14) ---

	app.get("/api/events", (c) => {
		return c.newResponse(
			new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

					// Track mtime per project
					const mtimeMap = new Map<string, number>();

					// Initialize with all active projects
					function refreshProjectList(): Map<string, { id: string; path: string }> {
						const projects = new Map<string, { id: string; path: string }>();
						for (const p of listActiveProjects(store)) {
							if (existsSync(p.path)) {
								const alfredDir = join(p.path, ".alfred");
								projects.set(p.id, { id: p.id, path: alfredDir });
								if (!mtimeMap.has(p.id)) {
									mtimeMap.set(p.id, dirMaxMtime(alfredDir));
								}
							}
						}
						return projects;
					}

					let projects = refreshProjectList();
					let pollCount = 0;

					const interval = setInterval(() => {
						// Refresh project list every 6 cycles (30s)
						pollCount++;
						if (pollCount % 6 === 0) {
							projects = refreshProjectList();
						}

						for (const [pId, pInfo] of projects) {
							const mtime = dirMaxMtime(pInfo.path);
							const lastMtime = mtimeMap.get(pId) ?? 0;
							if (mtime > lastMtime) {
								mtimeMap.set(pId, mtime);
								const data = JSON.stringify({ project: pId });
								controller.enqueue(encoder.encode(`event: refresh\ndata: ${data}\n\n`));
							}
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
		app.all("/*", async (c) => {
			const url = new URL(c.req.url);
			url.host = "localhost:5173";
			url.protocol = "http:";
			const resp = await fetch(url.toString(), { method: c.req.method, headers: c.req.raw.headers });
			return new Response(resp.body, { status: resp.status, headers: resp.headers });
		});
	} else {
		const webDistPath = resolveWebDist();
		if (webDistPath) {
			app.use("/*", serveStatic({ root: webDistPath }));
			app.get("*", (c) => {
				const indexPath = join(webDistPath, "index.html");
				try { return c.html(readFileSync(indexPath, "utf-8")); }
				catch { return c.text("Dashboard not built. Run: task build", 404); }
			});
		} else {
			app.get("*", (c) => {
				if (c.req.path.startsWith("/api/")) return c.notFound();
				return c.text("Dashboard assets not found.\nRun: alfred update (downloads web assets)\nOr build from source: cd claude-alfred && task build", 404);
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

	const server = Bun.serve({ fetch: app.fetch, port: opts.port, idleTimeout: 255 });

	const shutdown = () => {
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Keep process alive
	await new Promise(() => {});
}

// --- Helpers ---

function readAuditEntries(auditPath: string, entries: unknown[], projectName: string): void {
	try {
		const content = readFileSync(auditPath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				entry._project_name = projectName;
				entries.push(entry);
			} catch { /* skip */ }
		}
	} catch { /* no audit file */ }
}

function resolveWebDist(): string | null {
	const thisDir = fileURLToPath(new URL(".", import.meta.url));
	const candidates = [
		join(thisDir, "..", "web", "dist"),           // dev: dist/ → ../web/dist
		join(thisDir, "..", "..", "web", "dist"),      // dev: src/ → ../../web/dist
		join(homedir(), ".local", "share", "alfred", "web", "dist"), // installed binary
		join(process.cwd(), "web", "dist"),            // legacy fallback
	];
	for (const p of candidates) {
		if (existsSync(join(p, "index.html"))) return p;
	}
	return null;
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
	} catch { /* dir doesn't exist */ }
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
		.catch(() => { /* ignore */ });
}
