/**
 * Build script — Bun.build() for plugin bundles
 *
 * Usage:
 *   bun build.ts    # Bundle mcp-server.mjs to plugin/dist/
 */
export type { };

const pluginMeta = await Bun.file("plugin/.claude-plugin/plugin.json").json();
const version = pluginMeta.version ?? "dev";

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
