/**
 * Build script — Bun.build() for plugin bundles
 *
 * Usage:
 *   bun build.ts    # Bundle mcp-server.mjs to plugin/dist/
 */
export type { };

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pluginMeta = await Bun.file("plugin/.claude-plugin/plugin.json").json();
const version = pluginMeta.version ?? "dev";

// Build MCP server (plugin: node dist/mcp-server.mjs)
const mcpResult = await Bun.build({
  entrypoints: ["./src/mcp-server.ts"],
  outdir: "./plugin/dist",
  target: "bun",
  minify: false,
  naming: "mcp-server.mjs",
  define: {
    __QULT_VERSION__: JSON.stringify(version),
  },
});

if (!mcpResult.success) {
  for (const log of mcpResult.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${mcpResult.outputs.length} file(s) to plugin/dist/`);

// Copy WASM files for Tree-sitter (external assets, not bundled)
const wasmDir = "./plugin/wasm";
mkdirSync(wasmDir, { recursive: true });

let wasmCount = 0;

// Copy web-tree-sitter engine WASM
const treeSitterWasm = "./node_modules/web-tree-sitter/web-tree-sitter.wasm";
if (existsSync(treeSitterWasm)) {
	cpSync(treeSitterWasm, join(wasmDir, "web-tree-sitter.wasm"));
	wasmCount++;
}

// Copy language grammar WASMs from @lumis-sh/wasm-*
const lumisDir = "./node_modules/@lumis-sh";
if (existsSync(lumisDir)) {
	for (const pkg of readdirSync(lumisDir)) {
		if (!pkg.startsWith("wasm-")) continue;
		const pkgDir = join(lumisDir, pkg);
		for (const file of readdirSync(pkgDir)) {
			if (file.endsWith(".wasm")) {
				cpSync(join(pkgDir, file), join(wasmDir, file));
				wasmCount++;
			}
		}
	}
}

if (wasmCount > 0) {
	console.log(`Copied ${wasmCount} WASM file(s) to plugin/wasm/`);
}
