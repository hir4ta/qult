import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const GO_EXTS = new Set([".go"]);
const IMPORT_LINE_RE = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"'./][^"']*)["']/;
const PY_IMPORT_RE = /^\s*(?:import\s+(\w+)|from\s+(\w+)\s+import)\b/;
const MAX_IMPORT_CHECK_SIZE = 500_000;

/** Detect imports of non-existent packages. Returns PendingFix[] to accumulate.
 *  Addresses LLM hallucination: ~20% of AI package recommendations don't exist. */
export function detectHallucinatedImports(file: string): PendingFix[] {
	if (isGateDisabled("import-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext) && !GO_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	const content = readFileSync(file, "utf-8");
	if (content.length > MAX_IMPORT_CHECK_SIZE) return [];

	if (PY_EXTS.has(ext)) return detectPythonImports(file, content);
	if (GO_EXTS.has(ext)) return detectGoImports(file, content);
	return detectTsJsImports(file, content);
}

function detectTsJsImports(file: string, content: string): PendingFix[] {
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

function detectPythonImports(file: string, content: string): PendingFix[] {
	const cwd = process.cwd();
	const missingModules: string[] = [];

	for (const line of content.split("\n")) {
		if (line.trimStart().startsWith("#")) continue;
		const match = line.match(PY_IMPORT_RE);
		if (!match) continue;
		const moduleName = (match[1] ?? match[2])!;
		if (PY_STDLIB.has(moduleName)) continue;
		if (existsSync(join(cwd, `${moduleName}.py`)) || existsSync(join(cwd, moduleName))) continue;
		missingModules.push(moduleName);
	}

	if (missingModules.length === 0) return [];
	const unique = [...new Set(missingModules)];
	return [
		{
			file,
			errors: unique.map((mod) => {
				const safe = sanitizeForStderr(mod.slice(0, 128));
				return `Hallucinated import: Python module "${safe}" not found (not stdlib, no ${safe}.py or ${safe}/ in project)`;
			}),
			gate: "import-check",
		},
	];
}

const GO_IMPORT_RE = /^\s*"([^"]+)"/;

function detectGoImports(file: string, content: string): PendingFix[] {
	const cwd = process.cwd();
	const missingPkgs: string[] = [];
	let goSum: string | null = null;
	try {
		goSum = readFileSync(join(cwd, "go.sum"), "utf-8");
	} catch {
		/* no go.sum */
	}

	const lines = content.split("\n");
	let inBlock = false;
	for (const line of lines) {
		if (line.trimStart().startsWith("//")) continue;
		if (/^\s*import\s*\(/.test(line)) {
			inBlock = true;
			continue;
		}
		if (inBlock && line.trim() === ")") {
			inBlock = false;
			continue;
		}

		let importPath: string | undefined;
		if (inBlock) {
			const m = line.match(GO_IMPORT_RE);
			if (m) importPath = m[1]!;
		} else {
			const m = line.match(/^\s*import\s+"([^"]+)"/);
			if (m) importPath = m[1]!;
		}
		if (!importPath) continue;

		const topPkg = importPath.split("/")[0]!;
		if (GO_STDLIB_PREFIXES.has(topPkg)) continue;
		const vendorDir = resolve(cwd, "vendor");
		const vendorPath = resolve(vendorDir, importPath);
		if (vendorPath.startsWith(`${vendorDir}/`) && existsSync(vendorPath)) continue;
		if (goSum?.includes(`${importPath} `)) continue;
		missingPkgs.push(importPath);
	}

	if (missingPkgs.length === 0) return [];
	const unique = [...new Set(missingPkgs)];
	return [
		{
			file,
			errors: unique.map(
				(pkg) =>
					`Hallucinated import: Go package "${sanitizeForStderr(pkg.slice(0, 128))}" not found (not stdlib, not in vendor/ or go.sum)`,
			),
			gate: "import-check",
		},
	];
}

const GO_STDLIB_PREFIXES = new Set([
	"archive",
	"bufio",
	"bytes",
	"cmp",
	"compress",
	"context",
	"crypto",
	"database",
	"debug",
	"embed",
	"encoding",
	"errors",
	"flag",
	"fmt",
	"go",
	"hash",
	"html",
	"image",
	"internal",
	"io",
	"iter",
	"log",
	"maps",
	"math",
	"mime",
	"net",
	"os",
	"path",
	"plugin",
	"reflect",
	"regexp",
	"runtime",
	"slices",
	"sort",
	"strconv",
	"strings",
	"structs",
	"sync",
	"syscall",
	"testing",
	"text",
	"time",
	"unicode",
	"unique",
	"unsafe",
	"vendor",
]);

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

const PY_STDLIB = new Set([
	"abc",
	"aifc",
	"argparse",
	"array",
	"ast",
	"asyncio",
	"atexit",
	"base64",
	"binascii",
	"bisect",
	"builtins",
	"bz2",
	"calendar",
	"cgi",
	"cmd",
	"code",
	"codecs",
	"collections",
	"colorsys",
	"compileall",
	"concurrent",
	"configparser",
	"contextlib",
	"copy",
	"copyreg",
	"csv",
	"ctypes",
	"curses",
	"dataclasses",
	"datetime",
	"dbm",
	"decimal",
	"difflib",
	"dis",
	"email",
	"enum",
	"errno",
	"faulthandler",
	"fileinput",
	"fnmatch",
	"fractions",
	"ftplib",
	"functools",
	"gc",
	"getopt",
	"getpass",
	"gettext",
	"glob",
	"grp",
	"gzip",
	"hashlib",
	"heapq",
	"hmac",
	"html",
	"http",
	"imaplib",
	"importlib",
	"inspect",
	"io",
	"ipaddress",
	"itertools",
	"json",
	"keyword",
	"linecache",
	"locale",
	"logging",
	"lzma",
	"mailbox",
	"math",
	"mimetypes",
	"mmap",
	"multiprocessing",
	"netrc",
	"numbers",
	"operator",
	"optparse",
	"os",
	"pathlib",
	"pdb",
	"pickle",
	"pickletools",
	"pkgutil",
	"platform",
	"plistlib",
	"poplib",
	"posixpath",
	"pprint",
	"queue",
	"random",
	"re",
	"readline",
	"reprlib",
	"resource",
	"rlcompleter",
	"sched",
	"secrets",
	"select",
	"selectors",
	"shelve",
	"shlex",
	"shutil",
	"signal",
	"site",
	"smtplib",
	"socket",
	"socketserver",
	"sqlite3",
	"ssl",
	"stat",
	"statistics",
	"string",
	"struct",
	"subprocess",
	"sunau",
	"symtable",
	"sys",
	"sysconfig",
	"syslog",
	"tarfile",
	"tempfile",
	"termios",
	"textwrap",
	"threading",
	"time",
	"timeit",
	"tkinter",
	"token",
	"tokenize",
	"tomllib",
	"trace",
	"traceback",
	"tracemalloc",
	"tty",
	"turtle",
	"types",
	"typing",
	"unicodedata",
	"unittest",
	"urllib",
	"uuid",
	"venv",
	"warnings",
	"wave",
	"weakref",
	"xml",
	"xmlrpc",
	"zipfile",
	"zipimport",
	"zlib",
]);
