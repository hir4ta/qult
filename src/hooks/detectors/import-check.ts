import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const IMPORT_LINE_RE = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"'./][^"']*)["']/;
const MAX_IMPORT_CHECK_SIZE = 500_000;

/** Detect imports of non-existent packages. Returns PendingFix[] to accumulate.
 *  Addresses LLM hallucination: ~20% of AI package recommendations don't exist. */
export function detectHallucinatedImports(file: string): PendingFix[] {
	if (isGateDisabled("import-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!TS_JS_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	const content = readFileSync(file, "utf-8");
	if (content.length > MAX_IMPORT_CHECK_SIZE) return [];

	const cwd = process.cwd();
	const missingPkgs: string[] = [];
	let builtins: Set<string>;
	try {
		builtins = new Set(require("node:module").builtinModules as string[]);
	} catch {
		builtins = FALLBACK_BUILTINS;
	}

	for (const line of content.split("\n")) {
		if (line.trimStart().startsWith("//")) continue;
		const match = line.match(IMPORT_LINE_RE);
		if (!match) continue;
		const specifier = match[1]!;
		const pkgName = specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: specifier.split("/")[0]!;
		if (pkgName.startsWith("node:") || builtins.has(pkgName)) continue;
		if (pkgName.includes("..")) continue;
		if (!existsSync(join(cwd, "node_modules", pkgName))) {
			missingPkgs.push(pkgName);
		}
	}

	if (missingPkgs.length === 0) return [];
	const unique = [...new Set(missingPkgs)];
	return [
		{
			file,
			errors: unique.map(
				(pkg) =>
					`Hallucinated import: package "${sanitizeForStderr(pkg.slice(0, 128))}" not found in node_modules`,
			),
			gate: "import-check",
		},
	];
}

const FALLBACK_BUILTINS = new Set([
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"cluster",
	"console",
	"constants",
	"crypto",
	"dgram",
	"diagnostics_channel",
	"dns",
	"domain",
	"events",
	"fs",
	"http",
	"http2",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"readline",
	"repl",
	"stream",
	"string_decoder",
	"sys",
	"test",
	"timers",
	"tls",
	"trace_events",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
]);
