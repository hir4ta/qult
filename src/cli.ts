import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "alfred",
		description: "Development butler for Claude Code",
	},
	subCommands: {
		serve: defineCommand({
			meta: { description: "[internal] Start MCP server (stdio)" },
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

				const version = await resolveVersion();
				await startDashboard(cwd, store, emb, {
					port: parseInt(args.port, 10),
					urlOnly: args["url-only"],
					version,
				});
			},
		}),
		hook: defineCommand({
			meta: { description: "[internal] Handle hook event" },
			args: {
				event: { type: "positional", description: "Event name" },
			},
			async run({ args }) {
				const { runHook } = await import("./hooks/dispatcher.js");
				await runHook(args.event as string);
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
					"not initialized — create a spec via /alfred:brief in Claude Code",
				);
			},
		}),
		update: defineCommand({
			meta: { description: "Update alfred to the latest version" },
			async run() {
				const { execFileSync } = await import("node:child_process");
				const { writeFileSync, chmodSync, renameSync, unlinkSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { homedir, platform, arch } = await import("node:os");

				const REPO = "hir4ta/claude-alfred";
				const current = await resolveVersion();

				// Detect platform
				const os = platform() === "darwin" ? "darwin" : "linux";
				const cpu = arch() === "arm64" ? "arm64" : "x64";
				const platformStr = `${os}-${cpu}`;

				// Fetch latest version
				console.log("Checking for updates...");
				let latest: string;
				try {
					const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
					if (!resp.ok) throw new Error(`GitHub API: ${resp.status}`);
					const data = (await resp.json()) as { tag_name: string };
					latest = data.tag_name.replace(/^v/, "");
				} catch (err) {
					console.error(`Failed to check for updates: ${err}`);
					process.exit(1);
				}

				if (current === latest) {
					console.log(`alfred ${current} is already up to date.`);
					return;
				}

				console.log(`Updating alfred ${current} → ${latest}...`);

				// Download new binary
				const url = `https://github.com/${REPO}/releases/download/v${latest}/alfred-${platformStr}`;
				const installDir = join(homedir(), ".local", "bin");
				const alfredPath = join(installDir, "alfred");
				const tmpPath = `${alfredPath}.tmp`;

				try {
					const resp = await fetch(url);
					if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
					const buf = await resp.arrayBuffer();
					writeFileSync(tmpPath, Buffer.from(buf));
					chmodSync(tmpPath, 0o755);
					// Atomic replace
					try { unlinkSync(`${alfredPath}.bak`); } catch {}
					try { renameSync(alfredPath, `${alfredPath}.bak`); } catch {}
					renameSync(tmpPath, alfredPath);
					try { unlinkSync(`${alfredPath}.bak`); } catch {}
				} catch (err) {
					try { unlinkSync(tmpPath); } catch {}
					console.error(`Update failed: ${err}`);
					process.exit(1);
				}

				console.log(`alfred updated to ${latest}.`);
			},
		}),
		tui: defineCommand({
			meta: { description: "Open TUI spec progress viewer" },
			async run() {
				const { fileURLToPath } = await import("node:url");
				const { join } = await import("node:path");
				const { execSync } = await import("node:child_process");
				// Resolve TUI path relative to this script's location (works from any cwd)
				const { existsSync } = await import("node:fs");
				const thisDir = fileURLToPath(new URL(".", import.meta.url));
				// In dev: thisDir = .../src/ → ../src/tui/main.tsx
				// In dist: thisDir = .../dist/ → ../src/tui/main.tsx
				const tuiPath = join(thisDir, "..", "src", "tui", "main.tsx");
				if (!existsSync(tuiPath)) {
					process.stderr.write(`Error: TUI script not found at ${tuiPath}\n`);
					process.exit(1);
				}
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

declare const __ALFRED_VERSION__: string | undefined;

async function resolveVersion(): Promise<string> {
	// Prefer build-time embedded version (works in any location)
	if (typeof __ALFRED_VERSION__ !== "undefined") return __ALFRED_VERSION__;
	// Fallback: resolve from package.json (dev mode)
	try {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const thisDir = fileURLToPath(new URL(".", import.meta.url));
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
