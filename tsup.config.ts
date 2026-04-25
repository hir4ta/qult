import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig([
	{
		entry: { cli: "src/cli/index.ts" },
		format: ["esm"],
		outDir: "dist",
		bundle: true,
		minify: false,
		target: "node20",
		clean: false,
		define: {
			__QULT_VERSION__: JSON.stringify(pkg.version),
		},
		loader: {
			".md": "text",
			".toml": "text",
		},
	},
	{
		entry: { "mcp-server": "src/mcp/server.ts" },
		format: ["esm"],
		outDir: "dist",
		bundle: true,
		minify: false,
		target: "node20",
		clean: false,
		define: {
			__QULT_VERSION__: JSON.stringify(pkg.version),
		},
	},
]);
