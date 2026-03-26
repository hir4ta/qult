import { describe, expect, it } from "vitest";
import {
	checkLayerViolations,
	extractImports,
	type LayersConfig,
	resolveLayer,
} from "../layer-check.js";

const config: LayersConfig = {
	layers: [
		{ name: "types", pattern: "^src/types" },
		{ name: "store", pattern: "^src/store" },
		{ name: "hooks", pattern: "^src/hooks" },
		{ name: "mcp", pattern: "^src/mcp" },
		{ name: "tui", pattern: "^src/tui" },
	],
	rules: [
		{ from: "store", deny: ["hooks", "mcp", "tui"] },
		{ from: "hooks", deny: ["mcp", "tui"] },
		{ from: "types", deny: ["store", "hooks", "mcp", "tui"] },
	],
};

describe("layer-check", () => {
	describe("extractImports", () => {
		it("finds ES module imports", () => {
			const code = 'import { foo } from "../store/index.js";\nimport bar from "./baz.js";';
			const imports = extractImports(code);
			expect(imports).toHaveLength(2);
			expect(imports[0]!.path).toBe("../store/index.js");
			expect(imports[0]!.line).toBe(1);
			expect(imports[1]!.path).toBe("./baz.js");
		});

		it("finds require() calls", () => {
			const code = 'const x = require("../mcp/server.js");';
			const imports = extractImports(code);
			expect(imports).toHaveLength(1);
			expect(imports[0]!.path).toBe("../mcp/server.js");
		});

		it("finds dynamic imports", () => {
			const code = 'const mod = await import("../tui/main.js");';
			const imports = extractImports(code);
			expect(imports).toHaveLength(1);
			expect(imports[0]!.path).toBe("../tui/main.js");
		});

		it("returns empty for no imports", () => {
			expect(extractImports("const x = 1;")).toHaveLength(0);
		});
	});

	describe("resolveLayer", () => {
		it("resolves file to correct layer", () => {
			expect(resolveLayer("src/store/db.ts", config.layers)).toBe("store");
			expect(resolveLayer("src/hooks/post-tool.ts", config.layers)).toBe("hooks");
			expect(resolveLayer("src/mcp/server.ts", config.layers)).toBe("mcp");
		});

		it("returns null for unknown paths", () => {
			expect(resolveLayer("README.md", config.layers)).toBeNull();
		});
	});

	describe("checkLayerViolations", () => {
		it("detects forbidden import: store → hooks", () => {
			const code = 'import { foo } from "../hooks/detect.js";';
			const violations = checkLayerViolations(
				"/project",
				"/project/src/store/knowledge.ts",
				code,
				config,
			);
			expect(violations).toHaveLength(1);
			expect(violations[0]!.fromLayer).toBe("store");
			expect(violations[0]!.toLayer).toBe("hooks");
		});

		it("allows valid import: hooks → store", () => {
			const code = 'import { Store } from "../store/index.js";';
			const violations = checkLayerViolations(
				"/project",
				"/project/src/hooks/post-tool.ts",
				code,
				config,
			);
			expect(violations).toHaveLength(0);
		});

		it("detects hooks → mcp violation", () => {
			const code = 'import { server } from "../mcp/server.js";';
			const violations = checkLayerViolations(
				"/project",
				"/project/src/hooks/session-start.ts",
				code,
				config,
			);
			expect(violations).toHaveLength(1);
			expect(violations[0]!.toLayer).toBe("mcp");
		});

		it("ignores package imports", () => {
			const code = 'import { existsSync } from "node:fs";';
			const violations = checkLayerViolations("/project", "/project/src/store/db.ts", code, config);
			expect(violations).toHaveLength(0);
		});

		it("returns empty for files not in any layer", () => {
			const code = 'import { foo } from "../store/index.js";';
			const violations = checkLayerViolations("/project", "/project/README.md", code, config);
			expect(violations).toHaveLength(0);
		});

		it("caps at 10 violations", () => {
			const lines = Array.from({ length: 15 }, () => 'import { x } from "../mcp/x.js";').join("\n");
			const violations = checkLayerViolations(
				"/project",
				"/project/src/hooks/bad.ts",
				lines,
				config,
			);
			expect(violations.length).toBeLessThanOrEqual(10);
		});
	});
});
