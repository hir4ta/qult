import { describe, expect, it } from "vitest";
import { shouldAutoAppend } from "../lang-filter.js";

describe("shouldAutoAppend", () => {
	describe("supported source files pass", () => {
		it.each([
			"src/api/server.ts",
			"src/cli.tsx",
			"lib/util.js",
			"app/main.jsx",
			"src/index.mjs",
			"src/types.mts",
			"handler.py",
			"main.go",
			"app/service.rb",
		])("accepts %s", (f) => {
			expect(shouldAutoAppend(f)).toBe(true);
		});
	});

	describe("test files excluded", () => {
		it.each([
			"src/api/server.test.ts",
			"src/api/server.spec.ts",
			"src/app.test.js",
			"src/app.spec.js",
			"src/comp.test.tsx",
			"src/comp.spec.tsx",
			"handler_test.go",
			"handler_test.rb",
			"handler_spec.rb",
			"handler_test.py",
		])("rejects %s", (f) => {
			expect(shouldAutoAppend(f)).toBe(false);
		});
	});

	describe("generated/vendor files excluded", () => {
		it.each([
			"src/types.d.ts",
			"model_pb2.py",
			"model_pb2_grpc.py",
			"stringer_string.go",
			"mock_service_mock.go",
			"schema_gen.go",
			"vendor/lib/main.go",
			"node_modules/pkg/index.js",
			"dist/cli.mjs",
			"build/output.js",
			"__pycache__/module.py",
			".venv/lib/site.py",
			"plugin/hooks/hook.ts",
			".alfred/specs/test.ts",
			"lib/app.min.js",
			"lib/app.bundle.js",
		])("rejects %s", (f) => {
			expect(shouldAutoAppend(f)).toBe(false);
		});
	});

	describe("python prefix exclusions", () => {
		it.each(["test_handler.py", "conftest.py"])("rejects %s", (f) => {
			expect(shouldAutoAppend(f)).toBe(false);
		});
	});

	describe("unsupported extensions ignored", () => {
		it.each(["README.md", "config.yaml", "Dockerfile", "style.css", "image.png", ".gitignore"])(
			"rejects %s",
			(f) => {
				expect(shouldAutoAppend(f)).toBe(false);
			},
		);
	});
});
