/**
 * qult CLI entrypoint — argv parsing, Node version check, subcommand dispatch.
 *
 * The `#!/usr/bin/env node` shebang is injected by tsup (`banner.js` in
 * tsup.config.ts) so the published `dist/cli.js` can be spawned directly by
 * npm/npx via the `bin` field.
 *
 * Subcommands: init / update / check / add-agent / mcp.
 * Global flags: --version / --help / --json.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArgsError, parseArgs } from "./args.ts";
import { runAddAgent } from "./commands/add-agent.ts";
import { runCheck } from "./commands/check.ts";
import { runInit } from "./commands/init.ts";
import { runMcp } from "./commands/mcp.ts";
import { runUpdate } from "./commands/update.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

const HELP = `qult ${VERSION}

Spec-Driven Development + harness engineering aid for AI coding tools.

Usage:
  qult <command> [options]

Commands:
  init                       initialize qult in the current project
  update                     refresh integration config files from latest templates
  check [--detect]           print SDD state; --detect runs Tier 1 detectors
  add-agent <key>            add a single integration (claude|codex|cursor|gemini)
  mcp                        start the MCP server (stdio JSON-RPC)
  dashboard                  launch the live Ink TUI dashboard

Options:
  --agent <key>              for init: restrict to a single integration
  --force                    overwrite existing files without prompting
  --json                     emit JSON-formatted output (CI-friendly)
  -v, --version              print version and exit
  -h, --help                 print this help and exit
`;

function checkNodeVersion(): void {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (major < 20) {
		process.stderr.write(
			`qult requires Node.js 20 or newer (current: ${process.versions.node}).\n`,
		);
		process.exit(1);
	}
}

async function main(): Promise<number> {
	checkNodeVersion();

	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		process.stdout.write(HELP);
		return 0;
	}
	if (argv[0] === "-v" || argv[0] === "--version") {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}

	const cmd = argv[0];
	const rest = argv.slice(1);

	// Subcommand-level --help / -h falls back to global help.
	if (rest.includes("--help") || rest.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}

	switch (cmd) {
		case "init": {
			const { flags } = parseArgs(rest, ["agent"]);
			return runInit({
				agent: typeof flags.agent === "string" ? flags.agent : undefined,
				force: flags.force === true,
				json: flags.json === true,
			});
		}
		case "update": {
			const { flags } = parseArgs(rest);
			return runUpdate({ json: flags.json === true });
		}
		case "check": {
			const { flags } = parseArgs(rest);
			return runCheck({ detect: flags.detect === true, json: flags.json === true });
		}
		case "add-agent": {
			const { positionals, flags } = parseArgs(rest);
			return runAddAgent({
				key: positionals[0],
				force: flags.force === true,
				json: flags.json === true,
			});
		}
		case "mcp":
			return runMcp();
		case "dashboard": {
			// Lazy-load the Ink TUI so the high-frequency commands stay light.
			// We compute the dist path at runtime — a literal string would let
			// esbuild trace into the dashboard module and inline it (~1.5 MB
			// of ink/react) into cli.js, defeating the isolation.
			const here = dirname(fileURLToPath(import.meta.url));
			const dashboardUrl = pathToFileURL(resolve(here, "dashboard.js")).href;
			const mod = (await import(dashboardUrl)) as { runDashboard: () => Promise<number> };
			return mod.runDashboard();
		}
		default:
			process.stderr.write(`qult: unknown command "${cmd}". Run 'qult --help' for usage.\n`);
			return 1;
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		const msg = err instanceof Error ? err.message || err.name : String(err);
		const prefix = err instanceof ArgsError ? "qult: bad args: " : "qult: ";
		process.stderr.write(`${prefix}${msg}\n`);
		process.exit(1);
	});
