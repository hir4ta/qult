import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@api-types": path.resolve(__dirname, "../src/api/schemas.ts"),
		},
	},
	test: {
		include: ["src/lib/__tests__/**/*.test.ts"],
		environment: "node",
	},
});
