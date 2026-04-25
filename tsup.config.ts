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
	{
		// Ink-based UIs — both `qult dashboard` and the `--detect` runner for
		// `qult check`. They share React / ink / @inkjs/ui, so we emit them
		// from a single tsup config block (tsup splits common deps into
		// shared chunks automatically). The CLI lazy-loads either entry by
		// runtime URL so cli.js never imports them statically.
		entry: {
			dashboard: "src/dashboard/index.ts",
			"check-detect-ui": "src/dashboard/check-ui/index.tsx",
		},
		format: ["esm"],
		outDir: "dist",
		bundle: true,
		minify: false,
		target: "node20",
		clean: false,
		// ink / react ship ESM but pull in transitive CJS (yoga-layout etc.).
		// esbuild handles the interop when we bundle them in.
		noExternal: ["ink", "react", "react/jsx-runtime", "@inkjs/ui"],
		// `react-devtools-core` is an optional dep of Ink, only loaded when
		// the `DEV` env var is set. Mark it external so the bundler doesn't
		// try to statically resolve it (it isn't installed in production).
		external: ["react-devtools-core"],
		define: {
			__QULT_VERSION__: JSON.stringify(pkg.version),
		},
	},
]);
