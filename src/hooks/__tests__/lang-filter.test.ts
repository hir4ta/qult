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
			// New languages (FR-9)
			"src/main.rs",
			"src/App.java",
			"src/Service.cs",
			"Sources/Model.swift",
			"src/Utils.kt",
			"build.gradle.kts",
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
			// New languages (FR-10)
			"src/main_test.rs",
			"src/main_bench.rs",
			"src/AppTest.java",
			"src/AppTests.java",
			"src/ServiceIT.java",
			"src/Service.Tests.cs",
			"src/Service.Test.cs",
			"Tests/ModelTests.swift",
			"Tests/ModelSpec.swift",
			"Tests/ModelTest.swift",
			"src/UtilsTest.kt",
			"src/UtilsTests.kt",
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
			// New DIR_EXCLUSIONS (FR-10)
			"tests/integration/main.rs",
			"src/test/java/AppTest.java",
			".build/Sources/Model.swift",
			"obj/Debug/Foo.cs",
			"bin/Release/Bar.cs",
			"src/main.generated.rs",
		])("rejects %s", (f) => {
			expect(shouldAutoAppend(f)).toBe(false);
		});
	});

	describe("python/rust prefix exclusions", () => {
		it.each(["test_handler.py", "conftest.py", "test_utils.rs"])("rejects %s", (f) => {
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
