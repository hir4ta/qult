/**
 * Build script — Bun.build() for CLI bundle
 *
 * Usage:
 *   bun build.ts              # Bundle CLI to dist/cli.mjs
 *   bun build.ts --compile    # Compile to single binary
 */
const pkg = await Bun.file("package.json").json();
const version = pkg.version ?? "dev";
const isCompile = process.argv.includes("--compile");

function findArg(flag: string): string | undefined {
	const eqIdx = process.argv.findIndex((a) => a.startsWith(`${flag}=`));
	if (eqIdx !== -1) return process.argv[eqIdx].split("=").slice(1).join("=");
	const spaceIdx = process.argv.indexOf(flag);
	if (spaceIdx !== -1 && spaceIdx + 1 < process.argv.length) return process.argv[spaceIdx + 1];
	return undefined;
}

if (isCompile) {
	const target = findArg("--target");
	const outfile = findArg("--outfile") ?? "dist/qult";

	const args = [
		"bun",
		"build",
		"src/cli.ts",
		"--compile",
		"--minify",
		"--define",
		`__QULT_VERSION__="${version}"`,
		"--outfile",
		outfile,
	];
	if (target) args.push("--target", target);

	const proc = Bun.spawnSync(args, { stdio: ["inherit", "inherit", "inherit"] });
	process.exit(proc.exitCode ?? 1);
} else {
	const result = await Bun.build({
		entrypoints: ["./src/cli.ts"],
		outdir: "./dist",
		target: "bun",
		minify: false,
		banner: "#!/usr/bin/env bun",
		naming: "[name].mjs",
		define: {
			__QULT_VERSION__: JSON.stringify(version),
		},
	});

	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	console.log(`Built ${result.outputs.length} file(s) to dist/`);
}
