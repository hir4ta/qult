/**
 * Build script — Bun.build() for plugin bundles
 *
 * Usage:
 *   bun build.ts    # Bundle hook.mjs + mcp-server.mjs to plugin/dist/
 */
export type { };

const pluginMeta = await Bun.file("plugin/.claude-plugin/plugin.json").json();
const version = pluginMeta.version ?? "dev";

// Build hook entry (plugin: node dist/hook.mjs <event>)
const hookResult = await Bun.build({
  entrypoints: ["./src/hook-entry.ts"],
  outdir: "./plugin/dist",
  target: "bun",
  minify: false,
  naming: "hook.mjs",
  define: {
    __QULT_VERSION__: JSON.stringify(version),
  },
});

if (!hookResult.success) {
  for (const log of hookResult.logs) console.error(log);
  process.exit(1);
}

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

const total = hookResult.outputs.length + mcpResult.outputs.length;
console.log(`Built ${total} file(s) to plugin/dist/`);
