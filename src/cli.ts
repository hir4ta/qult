import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "alfred",
		description: "Quality butler for Claude Code",
	},
	subCommands: {
		serve: defineCommand({
			meta: { description: "[internal] Start MCP server (stdio)" },
			async run() {
				const { Store } = await import("./store/index.js");
				const { Embedder } = await import("./embedder/index.js");
				const { serveMCP } = await import("./mcp/server.js");
				const store = Store.openDefault();
				const emb = Embedder.create(); // Voyage AI required in v2
				store.expectedDims = emb.dims;
				const version = await resolveVersion();
				await serveMCP(store, emb, version);
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
		tui: defineCommand({
			meta: { description: "Show quality dashboard in terminal" },
			async run() {
				try {
					// @ts-ignore — tui/main.tsx uses OpenTUI JSX (separate tsconfig)
					const { runTui } = await import("./tui/main.js");
					await runTui();
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
						process.stderr.write("Error: TUI requires @opentui packages.\n");
						process.stderr.write("Install dependencies: cd claude-alfred && bun install\n");
						process.exit(1);
					}
					throw err;
				}
			},
		}),
		doctor: defineCommand({
			meta: { description: "Check installation health" },
			async run() {
				const { existsSync } = await import("node:fs");
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
				const dbPath = join(home, ".alfred", "alfred.db");
				check(existsSync(dbPath), `DB: ${dbPath}`, "not found — run: alfred init");

				// VOYAGE_API_KEY (required in v2)
				const hasVoyage = !!process.env.VOYAGE_API_KEY;
				check(hasVoyage, "VOYAGE_API_KEY set", "REQUIRED — alfred v2 requires Voyage AI");

				// MCP registration
				const mcpPath = join(home, ".claude", ".mcp.json");
				if (existsSync(mcpPath)) {
					try {
						const { readFileSync } = await import("node:fs");
						const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
						check(!!mcp.mcpServers?.alfred, "MCP: alfred registered", "run: alfred init");
					} catch {
						check(false, "MCP: .mcp.json parse error");
					}
				} else {
					check(false, `MCP: ${mcpPath}`, "not found — run: alfred init");
				}

				// Hooks
				const settingsPath = join(home, ".claude", "settings.json");
				if (existsSync(settingsPath)) {
					try {
						const { readFileSync } = await import("node:fs");
						const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
						const hookCount = Object.keys(settings.hooks ?? {}).length;
						check(hookCount >= 6, `Hooks: ${hookCount} events registered`, "run: alfred init");
					} catch {
						check(false, "Hooks: settings.json parse error");
					}
				} else {
					check(false, `Hooks: ${settingsPath}`, "not found — run: alfred init");
				}

				// Rules
				const rulesPath = join(home, ".claude", "rules", "alfred-quality.md");
				check(existsSync(rulesPath), "Rules: alfred-quality.md", "not found — run: alfred init");

				// Skills
				const reviewSkill = join(home, ".claude", "skills", "alfred-review", "SKILL.md");
				check(existsSync(reviewSkill), "Skill: alfred-review", "not found — run: alfred init");

				// Agent
				const reviewerAgent = join(home, ".claude", "agents", "alfred-reviewer.md");
				check(existsSync(reviewerAgent), "Agent: alfred-reviewer", "not found — run: alfred init");

				// Project
				const cwd = process.cwd();
				const hasAlfred = existsSync(join(cwd, ".alfred"));
				check(hasAlfred, `Project: .alfred/ exists`, "run: alfred init in your project");

				// Gates
				const gatesPath = join(cwd, ".alfred", "gates.json");
				check(existsSync(gatesPath), "Gates: .alfred/gates.json", "run: alfred init");
			},
		}),
		"hook-internal": defineCommand({
			meta: { description: "[internal] Hook-internal commands for agent hooks" },
			subCommands: {
				"save-decision": defineCommand({
					meta: { description: "Save an error resolution from PreCompact agent hook" },
					args: {
						title: { type: "string", required: true, description: "Title" },
						error_signature: { type: "string", default: "", description: "Normalized error message" },
						resolution: { type: "string", default: "", description: "How to resolve" },
					},
					async run({ args }) {
						// TODO (Phase 1): Implement save via v2 knowledge system
						console.log(`[alfred] save-decision: ${args.title}`);
					},
				}),
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
	if (typeof __ALFRED_VERSION__ !== "undefined") return __ALFRED_VERSION__;
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
	} catch {}
	return "dev";
}

runMain(main);
