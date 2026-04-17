import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		pool: "forks",
		exclude: ["**/fixtures/**", "**/node_modules/**"],
		coverage: {
			include: ["src/**/*.ts"],
			exclude: [
				"src/__tests__/**",
				"src/**/__tests__/**",
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
