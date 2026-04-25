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
		// `npm` / `npx` need this shebang to spawn the bin via `node`. Source
		// also has a `#!/usr/bin/env node` line, but the banner is a belt-and-
		// suspenders guarantee — tsup sometimes drops the source shebang when
		// it bundles imports above the file's first executable statement.
		banner: { js: "#!/usr/bin/env node" },
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
