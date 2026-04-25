/**
 * qult CLI entrypoint (Wave 1 stub).
 *
 * Wave 1 only handles `--version` and `--help`. Real subcommands land in Wave 5.
 */

declare const __QULT_VERSION__: string;

const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

const HELP = `qult ${VERSION}

Usage:
  qult <command> [options]

Commands:
  init        (planned, Wave 5) initialize qult in the current project
  update      (planned, Wave 5) refresh integration config files
  check       (planned, Wave 5) print SDD state and run detectors
  add-agent   (planned, Wave 5) add a single integration
  mcp         (planned, Wave 5) start the MCP server (stdio)

Options:
  -v, --version    print version and exit
  -h, --help       print help and exit
`;

function main(): number {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		process.stdout.write(HELP);
		return 0;
	}
	if (args[0] === "-v" || args[0] === "--version") {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	process.stderr.write(`qult: subcommand "${args[0]}" is not yet implemented (Wave 1 stub).\n`);
	return 1;
}

process.exit(main());
