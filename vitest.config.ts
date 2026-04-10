import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"bun:sqlite": resolve("./src/state/__tests__/bun-sqlite-shim.ts"),
		},
	},
	test: {
		pool: "forks",
		exclude: ["**/fixtures/**", "**/node_modules/**"],
		coverage: {
			include: ["src/**/*.ts"],
			exclude: [
				"src/__tests__/**",
				"src/**/__tests__/**",
				"src/hook-entry.ts",
				"src/types.ts",
			],
			thresholds: {
				statements: 90,
				branches: 80,
				functions: 85,
				lines: 90,
			},
		},
	},
});
