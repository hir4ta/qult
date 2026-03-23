import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "alfred",
		description: "Development butler for Claude Code",
	},
	subCommands: {
		serve: defineCommand({
			meta: { description: "Start MCP server (stdio)" },
			async run() {
				const { Store } = await import("./store/index.js");
				const { Embedder } = await import("./embedder/index.js");
				const { serveMCP } = await import("./mcp/server.js");
				const store = Store.openDefault();
				let emb = null;
				try {
					emb = Embedder.create();
				} catch {
					/* no Voyage key */
				}
				if (emb) store.expectedDims = emb.dims;
				const version = await resolveVersion();
				await serveMCP(store, emb, version);
			},
		}),
		dashboard: defineCommand({
			meta: { description: "Open browser dashboard (cross-project)" },
			args: {
				port: { type: "string", default: "7575", description: "Port number" },
				"url-only": { type: "boolean", default: false, description: "Print URL only" },
			},
			async run({ args }) {
				const { existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { Store } = await import("./store/index.js");
				const { Embedder } = await import("./embedder/index.js");
				const { startDashboard } = await import("./api/server.js");
				const { resolveOrRegisterProject } = await import("./store/project.js");
				const { syncAllProjectSpecs } = await import("./store/spec-sync.js");

				const cwd = process.cwd();
				const store = Store.openDefault();
				let emb = null;
				try {
					emb = Embedder.create();
				} catch {
					/* no Voyage key */
				}
				if (emb) store.expectedDims = emb.dims;

				// Register cwd project if it has .alfred/
				if (existsSync(join(cwd, ".alfred"))) {
					resolveOrRegisterProject(store, cwd);
				}

				// Sync specs from all registered projects
				await syncAllProjectSpecs(store, emb);

				// Sync audit.jsonl → audit_log for all active projects
				const { syncAuditJsonl } = await import("./store/audit.js");
				const { listActiveProjects } = await import("./store/project.js");
				for (const p of listActiveProjects(store)) {
					if (existsSync(join(p.path, ".alfred"))) {
						await syncAuditJsonl(store, p.id, p.path);
					}
				}

				const version = await resolveVersion();
				await startDashboard(cwd, store, emb, {
					port: parseInt(args.port, 10),
					urlOnly: args["url-only"],
					version,
				});
			},
		}),
		hook: defineCommand({
			meta: { description: "Handle hook event" },
			args: {
				event: { type: "positional", description: "Event name" },
			},
			async run({ args }) {
				const { runHook } = await import("./hooks/dispatcher.js");
				await runHook(args.event as string);
			},
		}),
		"plugin-bundle": defineCommand({
			meta: { description: "Generate plugin bundle" },
			args: {
				output: { type: "positional", description: "Output directory", default: "plugin" },
			},
			async run({ args }) {
				// Placeholder — will copy content/ to output dir.
				console.log(`plugin-bundle: output=${args.output} (not yet implemented)`);
			},
		}),
		doctor: defineCommand({
			meta: { description: "Check installation health" },
			async run() {
				const { existsSync, readdirSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				const home = homedir();
				const version = await resolveVersion();

				console.log(`alfred doctor (v${version})\n`);

				// Bun version
				const bunVer = typeof Bun !== "undefined" ? Bun.version : null;
				check(!!bunVer, `Bun ${bunVer ?? "not found"}`, ">=1.3 required");

				// bun:sqlite
				try {
					await import("bun:sqlite");
					check(true, "bun:sqlite loaded");
				} catch {
					check(false, "bun:sqlite", "not available");
				}

				// DB
				const dbPath = join(home, ".claude-alfred", "alfred.db");
				check(
					existsSync(dbPath),
					`DB: ${dbPath}`,
					"not found — run: alfred (any command) to create",
				);

				// VOYAGE_API_KEY
				const hasVoyage = !!process.env.VOYAGE_API_KEY;
				check(
					hasVoyage,
					"VOYAGE_API_KEY set",
					"not set — semantic search disabled, FTS5 fallback active",
				);

				// ALFRED_LANG
				const lang = process.env.ALFRED_LANG;
				check(true, `ALFRED_LANG: ${lang || "(not set, default: en)"}`);

				// User rules
				const rulesDir = join(home, ".claude", "rules");
				try {
					const rules = readdirSync(rulesDir).filter((f) => f.startsWith("alfred"));
					check(
						rules.length > 0,
						`Rules: ${rulesDir} (${rules.length} alfred files)`,
						"no alfred rules found",
					);
				} catch {
					check(false, "Rules", `${rulesDir} not found`);
				}

				// Project .alfred/
				const cwd = process.cwd();
				const hasAlfred = existsSync(join(cwd, ".alfred"));
				check(
					hasAlfred,
					`Project: .alfred/ exists in ${cwd}`,
					"not initialized — run /alfred:init in Claude Code",
				);
			},
		}),
		knowledge: defineCommand({
			meta: { description: "Knowledge management" },
			subCommands: {
				export: defineCommand({
					meta: { description: "Export knowledge as JSON" },
					async run() {
						const { exportKnowledge } = await import("./git/knowledge-io.js");
						const result = exportKnowledge(process.cwd());
						process.stdout.write(JSON.stringify(result.entries, null, 2) + "\n");
						process.stderr.write(`Exported ${result.count} entries\n`);
					},
				}),
				import: defineCommand({
					meta: { description: "Import knowledge from JSON (stdin)" },
					async run() {
						const { importKnowledge } = await import("./git/knowledge-io.js");
						const chunks: Buffer[] = [];
						const MAX_SIZE = 50 * 1024 * 1024; // 50MB
						let totalSize = 0;
						for await (const chunk of process.stdin) {
							totalSize += (chunk as Buffer).length;
							if (totalSize > MAX_SIZE) {
								process.stderr.write("Error: input exceeds 50MB limit\n");
								process.exit(1);
							}
							chunks.push(chunk as Buffer);
						}
						const input = Buffer.concat(chunks).toString("utf-8");
						let entries: unknown[];
						try {
							entries = JSON.parse(input);
							if (!Array.isArray(entries)) throw new Error("expected JSON array");
						} catch (err) {
							process.stderr.write(`Error: invalid JSON input: ${err}\n`);
							process.exit(1);
						}
						const result = importKnowledge(process.cwd(), entries);
						console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}, Similar: ${result.similar}`);
					},
				}),
				diff: defineCommand({
					meta: { description: "Show uncommitted knowledge changes" },
					async run() {
						const { showKnowledgeDiff } = await import("./git/knowledge-io.js");
						const result = showKnowledgeDiff(process.cwd());
						if (result.added.length === 0 && result.modified.length === 0 && result.deleted.length === 0) {
							console.log("変更なし");
							return;
						}
						for (const f of result.added) console.log(`+ ${f}`);
						for (const f of result.deleted) console.log(`- ${f}`);
						for (const m of result.modified) {
							console.log(`M ${m.path}`);
							for (const c of m.changes) {
								console.log(`  ${c.field}: ${c.before} → ${c.after}`);
							}
						}
					},
				}),
			},
		}),
		tui: defineCommand({
			meta: { description: "Open TUI spec progress viewer" },
			async run() {
				const { fileURLToPath } = await import("node:url");
				const { join } = await import("node:path");
				const { execSync } = await import("node:child_process");
				const thisDir = fileURLToPath(new URL(".", import.meta.url));
				// TUI is a standalone Bun script (requires OpenTUI + JSX)
				const tuiPath = join(thisDir, "..", "src", "tui", "main.tsx");
				try {
					execSync(`bun "${tuiPath}"`, { stdio: "inherit" });
				} catch {
					process.exit(1);
				}
			},
		}),
		version: defineCommand({
			meta: { description: "Show version" },
			args: {
				short: { type: "boolean", default: false, description: "Version only" },
			},
			async run({ args }) {
				const version = await resolveVersion();
				if (args.short) {
					console.log(version);
				} else {
					console.log(`alfred ${version}`);
				}
			},
		}),
	},
});

function check(ok: boolean, label: string, hint?: string): void {
	if (ok) {
		console.log(`  ✓ ${label}`);
	} else {
		console.log(`  ✗ ${label}${hint ? ` — ${hint}` : ""}`);
	}
}

async function resolveVersion(): Promise<string> {
	try {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const thisDir = fileURLToPath(new URL(".", import.meta.url));
		// Try package.json relative to dist/
		for (const rel of ["..", "../.."]) {
			try {
				const pkg = JSON.parse(readFileSync(join(thisDir, rel, "package.json"), "utf-8"));
				if (pkg.version) return pkg.version;
			} catch {}
		}
	} catch {
		/* ignore */
	}
	return "dev";
}

runMain(main);
