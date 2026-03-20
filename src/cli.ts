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
			meta: { description: "Open browser dashboard" },
			args: {
				port: { type: "string", default: "7575", description: "Port number" },
				"url-only": { type: "boolean", default: false, description: "Print URL only" },
			},
			async run({ args }) {
				const { Store } = await import("./store/index.js");
				const { Embedder } = await import("./embedder/index.js");
				const { startDashboard } = await import("./api/server.js");
				const projectPath = process.cwd();
				const store = Store.openDefault();
				let emb = null;
				try {
					emb = Embedder.create();
				} catch {
					/* no Voyage key */
				}
				if (emb) store.expectedDims = emb.dims;
				const version = await resolveVersion();
				await startDashboard(projectPath, store, emb, {
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
		projects: defineCommand({
			meta: { description: "Manage registered projects" },
			args: {
				action: { type: "positional", description: "list | archive | unarchive | cleanup", default: "list" },
				id: { type: "positional", description: "Project ID (for archive/unarchive)", required: false },
			},
			async run({ args }) {
				const { Store } = await import("./store/index.js");
				const { listProjects, updateProject, cleanupMissingProjects, detectMissingProjects } = await import("./store/project-registry.js");
				const store = Store.openDefault();
				const action = args.action as string;

				if (action === "list") {
					detectMissingProjects(store);
					const projects = listProjects(store);
					if (projects.length === 0) {
						console.log("No registered projects.");
						return;
					}
					for (const p of projects) {
						const statusIcon = p.status === "active" ? "●" : p.status === "archived" ? "○" : "✗";
						console.log(`  ${statusIcon} ${p.name} (${p.status})`);
						console.log(`    ID:   ${p.id}`);
						console.log(`    Path: ${p.path}`);
						if (p.remote) console.log(`    Remote: ${p.remote}`);
						console.log(`    Last seen: ${p.lastSeenAt}`);
						console.log();
					}
				} else if (action === "archive" && args.id) {
					updateProject(store, args.id as string, { status: "archived" });
					console.log(`Project ${args.id} archived.`);
				} else if (action === "unarchive" && args.id) {
					updateProject(store, args.id as string, { status: "active" });
					console.log(`Project ${args.id} restored.`);
				} else if (action === "cleanup") {
					const result = cleanupMissingProjects(store);
					if (result.deleted === 0) {
						console.log("No missing projects to clean up.");
					} else {
						console.log(`Cleaned up ${result.deleted} missing project(s): ${result.projects.join(", ")}`);
					}
				} else {
					console.log("Usage: alfred projects [list|archive|unarchive|cleanup] [id]");
				}
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

				// Node.js version
				const nodeVer = process.version;
				const nodeMajor = parseInt(nodeVer.slice(1), 10);
				check(nodeMajor >= 22, `Node.js ${nodeVer}`, ">=22 required");

				// better-sqlite3
				try {
					await import("better-sqlite3");
					check(true, "better-sqlite3 loaded");
				} catch {
					check(false, "better-sqlite3", "not found — run npm rebuild");
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
