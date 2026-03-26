import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "alfred",
		description: "Quality butler for Claude Code",
	},
	subCommands: {
		init: defineCommand({
			meta: { description: "Setup alfred (MCP, hooks, rules, skills, agents)" },
			args: {
				scan: { type: "boolean", default: false, description: "Also scan for conventions" },
				force: { type: "boolean", default: false, description: "Overwrite existing config" },
			},
			async run({ args }) {
				const { alfredInit } = await import("./init/index.js");
				await alfredInit(process.cwd(), { scan: args.scan, force: args.force });
			},
		}),
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
					// @ts-expect-error — tui/main.tsx uses OpenTUI JSX (separate tsconfig)
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
				const convSkill = join(home, ".claude", "skills", "alfred-conventions", "SKILL.md");
				check(existsSync(convSkill), "Skill: alfred-conventions", "not found — run: alfred init");

				// Checklists
				const checklistDir = join(home, ".claude", "skills", "alfred-review", "checklists");
				const hasChecklists =
					existsSync(join(checklistDir, "security.md")) &&
					existsSync(join(checklistDir, "logic.md")) &&
					existsSync(join(checklistDir, "design.md"));
				check(
					hasChecklists,
					"Checklists: security, logic, design",
					"not found — run: alfred init --force",
				);

				// Agent
				const reviewerAgent = join(home, ".claude", "agents", "alfred-reviewer.md");
				check(existsSync(reviewerAgent), "Agent: alfred-reviewer", "not found — run: alfred init");

				// Voyage AI connectivity
				if (hasVoyage) {
					try {
						const { Embedder } = await import("./embedder/index.js");
						const emb = Embedder.create();
						await emb.validate();
						check(true, "Voyage AI: API reachable");
					} catch (e) {
						check(false, "Voyage AI: API unreachable", String(e));
					}
				}

				// Project
				const cwd = process.cwd();
				const hasAlfred = existsSync(join(cwd, ".alfred"));
				check(hasAlfred, `Project: .alfred/ exists`, "run: alfred init in your project");

				// Gates
				const gatesPath = join(cwd, ".alfred", "gates.json");
				check(existsSync(gatesPath), "Gates: .alfred/gates.json", "run: alfred init");

				// Knowledge
				if (hasAlfred) {
					const knowledgeDir = join(cwd, ".alfred", "knowledge");
					const hasKnowledge =
						existsSync(join(knowledgeDir, "error_resolutions")) &&
						existsSync(join(knowledgeDir, "fix_patterns")) &&
						existsSync(join(knowledgeDir, "conventions"));
					check(hasKnowledge, "Knowledge: directories exist", "run: alfred init");
				}

				// Conventions
				const convPath = join(cwd, ".alfred", "conventions.json");
				check(
					existsSync(convPath),
					"Conventions: .alfred/conventions.json",
					"run: /alfred:conventions to discover",
				);
			},
		}),
		scan: defineCommand({
			meta: { description: "Run full quality scan (lint/type/test) and update score" },
			async run() {
				const { existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const cwd = process.cwd();

				if (!existsSync(join(cwd, ".alfred", "gates.json"))) {
					console.error("No .alfred/gates.json found. Run: alfred init");
					process.exit(1);
				}

				const { loadGates, runGateGroup } = await import("./gates/index.js");
				const gates = loadGates(cwd);
				if (!gates) {
					console.error("Failed to load gates.json");
					process.exit(1);
				}

				console.log("alfred scan\n");

				// Run on_write gates (project-wide, no {file} substitution)
				if (Object.keys(gates.on_write).length > 0) {
					console.log("── on_write gates ──");
					const writeResults = runGateGroup(cwd, gates.on_write);
					for (const r of writeResults) {
						const icon = r.passed ? "✓" : "✗";
						console.log(`  ${icon} ${r.name} (${r.duration}ms)`);
						if (!r.passed && r.output) {
							console.log(`    ${r.output.slice(0, 300)}`);
						}
					}
				}

				// Run on_commit gates
				if (Object.keys(gates.on_commit).length > 0) {
					console.log("── on_commit gates ──");
					const commitResults = runGateGroup(cwd, gates.on_commit);
					for (const r of commitResults) {
						const icon = r.passed ? "✓" : "✗";
						console.log(`  ${icon} ${r.name} (${r.duration}ms)`);
						if (!r.passed && r.output) {
							console.log(`    ${r.output.slice(0, 300)}`);
						}
					}
				}

				// Calculate and display score
				try {
					const { openDefaultCached } = await import("./store/index.js");
					const { resolveOrRegisterProject } = await import("./store/project.js");
					const { calculateQualityScore } = await import("./store/quality-events.js");
					const store = openDefaultCached();
					const project = resolveOrRegisterProject(store, cwd);
					const score = calculateQualityScore(store, `session-${Date.now()}`);
					console.log(`\nQuality Score: ${score.sessionScore}/100`);
				} catch {
					console.log("\nQuality Score: unavailable (no events recorded)");
				}
			},
		}),
		status: defineCommand({
			meta: { description: "Show current quality status" },
			async run() {
				const { existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const cwd = process.cwd();
				const version = await resolveVersion();

				console.log(`alfred status (v${version})\n`);

				// --- Project ---
				const alfredDir = join(cwd, ".alfred");
				if (!existsSync(join(alfredDir, "gates.json"))) {
					console.error("No .alfred/ found. Run: alfred init");
					process.exit(1);
				}

				const { openDefaultCached } = await import("./store/index.js");
				const { resolveOrRegisterProject } = await import("./store/project.js");
				const { detectProjectProfile } = await import("./profile/detect.js");
				const { calculateQualityScore, getLatestSessionId, getRecentEvents } = await import(
					"./store/quality-events.js"
				);
				const { countKnowledge } = await import("./store/knowledge.js");

				const store = openDefaultCached();
				const project = resolveOrRegisterProject(store, cwd);
				const profile = detectProjectProfile(cwd);

				console.log(`Project: ${project.name}`);
				console.log(`  Path:  ${project.path}`);
				const stack = [
					profile.languages.join(", ") || "unknown",
					profile.runtime !== "unknown" ? `(${profile.runtime})` : "",
					profile.testFramework !== "unknown" ? `/ ${profile.testFramework}` : "",
					profile.linter !== "unknown" ? `/ ${profile.linter}` : "",
				]
					.filter(Boolean)
					.join(" ");
				console.log(`  Stack: ${stack}`);

				// --- Quality Score ---
				const sessionId = getLatestSessionId(store, project.id);
				if (sessionId) {
					const score = calculateQualityScore(store, sessionId);
					const trendIcon =
						score.trend === "improving" ? "+" : score.trend === "declining" ? "-" : "=";
					console.log(`\nQuality Score: ${score.sessionScore}/100 (${trendIcon} ${score.trend})`);
					const b = score.breakdown;
					if (b.gatePassRateWrite.total > 0) {
						console.log(
							`  Gate Write:    ${b.gatePassRateWrite.score}% (${b.gatePassRateWrite.pass}/${b.gatePassRateWrite.total})`,
						);
					}
					if (b.gatePassRateCommit.total > 0) {
						console.log(
							`  Gate Commit:   ${b.gatePassRateCommit.score}% (${b.gatePassRateCommit.pass}/${b.gatePassRateCommit.total})`,
						);
					}
					if (b.errorResolutionHit.total > 0) {
						console.log(
							`  Error Cache:   ${b.errorResolutionHit.score}% (${b.errorResolutionHit.hit}/${b.errorResolutionHit.total})`,
						);
					}
					if (b.conventionAdherence.total > 0) {
						console.log(
							`  Conventions:   ${b.conventionAdherence.score}% (${b.conventionAdherence.pass}/${b.conventionAdherence.total})`,
						);
					}
				} else {
					console.log("\nQuality Score: no data (no sessions recorded)");
				}

				// --- Knowledge DB ---
				const totalKnowledge = countKnowledge(store, project.id);
				if (totalKnowledge > 0) {
					const typeCounts = store.db
						.prepare(`
							SELECT type, COUNT(*) as cnt FROM knowledge_index
							WHERE project_id = ? AND enabled = 1 GROUP BY type
						`)
						.all(project.id) as Array<{ type: string; cnt: number }>;
					console.log(`\nKnowledge DB: ${totalKnowledge} entries`);
					for (const tc of typeCounts) {
						console.log(`  ${tc.type}: ${tc.cnt}`);
					}
				} else {
					console.log("\nKnowledge DB: empty");
				}

				// --- Recent Events ---
				if (sessionId) {
					const events = getRecentEvents(store, sessionId, 5);
					if (events.length > 0) {
						console.log("\nRecent Events:");
						for (const e of events) {
							const time = e.createdAt.replace("T", " ").slice(0, 16);
							console.log(`  ${e.eventType.padEnd(18)} ${time}`);
						}
					}
				}
			},
		}),
		uninstall: defineCommand({
			meta: { description: "Remove alfred from this system" },
			args: {
				"keep-data": {
					type: "boolean",
					default: false,
					description: "Keep ~/.alfred/ and .alfred/ data",
				},
			},
			async run({ args }) {
				const { existsSync, rmSync, unlinkSync } = await import("node:fs");
				const { readFileSync, writeFileSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				const home = homedir();
				const claudeDir = join(home, ".claude");
				const removed: string[] = [];

				// Remove MCP entry
				const mcpPath = join(claudeDir, ".mcp.json");
				if (existsSync(mcpPath)) {
					try {
						const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
						if (mcp.mcpServers?.alfred) {
							delete mcp.mcpServers.alfred;
							writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
							removed.push("MCP: alfred entry");
						}
					} catch {
						/* ignore */
					}
				}

				// Remove hooks from settings.json
				const settingsPath = join(claudeDir, "settings.json");
				if (existsSync(settingsPath)) {
					try {
						const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
						if (settings.hooks) {
							let cleaned = 0;
							for (const [event, handlers] of Object.entries(settings.hooks)) {
								if (Array.isArray(handlers)) {
									const filtered = (handlers as Array<Record<string, unknown>>).filter((h) => {
										const hooks = h.hooks as Array<Record<string, unknown>> | undefined;
										return !hooks?.some(
											(hk) =>
												typeof hk.command === "string" &&
												(hk.command as string).startsWith("alfred "),
										);
									});
									if (filtered.length !== (handlers as unknown[]).length) {
										settings.hooks[event] = filtered.length > 0 ? filtered : undefined;
										cleaned++;
									}
								}
							}
							// Clean up empty events
							for (const key of Object.keys(settings.hooks)) {
								if (
									!settings.hooks[key] ||
									(Array.isArray(settings.hooks[key]) && settings.hooks[key].length === 0)
								) {
									delete settings.hooks[key];
								}
							}
							if (cleaned > 0) {
								writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
								removed.push(`Hooks: ${cleaned} events`);
							}
						}
					} catch {
						/* ignore */
					}
				}

				// Remove rules, skills, agents
				const toDelete = [
					join(claudeDir, "rules", "alfred-quality.md"),
					join(claudeDir, "agents", "alfred-reviewer.md"),
				];
				const dirsToDelete = [
					join(claudeDir, "skills", "alfred-review"),
					join(claudeDir, "skills", "alfred-conventions"),
				];
				for (const p of toDelete) {
					if (existsSync(p)) {
						unlinkSync(p);
						removed.push(p);
					}
				}
				for (const d of dirsToDelete) {
					if (existsSync(d)) {
						rmSync(d, { recursive: true });
						removed.push(d);
					}
				}

				// Remove data
				if (!args["keep-data"]) {
					const alfredHome = join(home, ".alfred");
					if (existsSync(alfredHome)) {
						rmSync(alfredHome, { recursive: true });
						removed.push(alfredHome);
					}
				}

				if (removed.length === 0) {
					console.log("Nothing to remove.");
				} else {
					for (const p of removed) console.log(`  ✓ removed: ${p}`);
					console.log("\nalfred uninstalled.");
				}
			},
		}),
		"hook-internal": defineCommand({
			meta: { description: "[internal] Hook-internal commands for agent hooks" },
			subCommands: {
				"save-decision": defineCommand({
					meta: { description: "Save an error resolution from PreCompact agent hook" },
					args: {
						title: { type: "string", required: true, description: "Title" },
						error_signature: {
							type: "string",
							default: "",
							description: "Normalized error message",
						},
						resolution: { type: "string", default: "", description: "How to resolve" },
					},
					async run({ args }) {
						const { Store } = await import("./store/index.js");
						const { resolveOrRegisterProject } = await import("./store/project.js");
						const { upsertKnowledge } = await import("./store/knowledge.js");
						const { insertEmbedding } = await import("./store/vectors.js");

						const store = Store.openDefault();
						const cwd = process.cwd();
						const project = resolveOrRegisterProject(store, cwd);

						const content = JSON.stringify({
							error_signature: args.error_signature,
							resolution: args.resolution,
						});

						const { id, changed } = upsertKnowledge(store, {
							projectId: project.id,
							type: "error_resolution",
							title: args.title as string,
							content,
						});

						if (changed) {
							try {
								const { Embedder } = await import("./embedder/index.js");
								const emb = Embedder.create();
								const vector = await emb.embedForStorage(`${args.title}\n${content}`);
								insertEmbedding(store, id, emb.model, vector);
							} catch {
								/* embedding optional */
							}
						}

						console.log(`[alfred] saved: ${args.title} (id=${id}, changed=${changed})`);
						store.close();
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
