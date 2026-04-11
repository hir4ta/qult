import { afterEach, describe, expect, it } from "vitest";
import {
	extToLanguage,
	initParser,
	resetParserCache,
	type SupportedLanguage,
} from "../hooks/detectors/tree-sitter-init.ts";

afterEach(() => {
	resetParserCache();
});

describe("extToLanguage", () => {
	it("maps TypeScript extensions", () => {
		expect(extToLanguage(".ts")).toBe("typescript");
		expect(extToLanguage(".tsx")).toBe("tsx");
		expect(extToLanguage(".mts")).toBe("typescript");
	});

	it("maps JavaScript to typescript parser", () => {
		expect(extToLanguage(".js")).toBe("typescript");
		expect(extToLanguage(".jsx")).toBe("tsx");
	});

	it("maps Python extensions", () => {
		expect(extToLanguage(".py")).toBe("python");
		expect(extToLanguage(".pyi")).toBe("python");
	});

	it("maps other languages", () => {
		expect(extToLanguage(".go")).toBe("go");
		expect(extToLanguage(".rs")).toBe("rust");
		expect(extToLanguage(".rb")).toBe("ruby");
		expect(extToLanguage(".java")).toBe("java");
	});

	it("returns null for unsupported extensions", () => {
		expect(extToLanguage(".css")).toBeNull();
		expect(extToLanguage(".html")).toBeNull();
		expect(extToLanguage(".md")).toBeNull();
	});
});

describe("initParser", () => {
	it("returns parser for typescript", async () => {
		const result = await initParser("typescript");
		expect(result).not.toBeNull();
		expect(result!.parser).toBeDefined();
		expect(result!.language).toBeDefined();
		expect(typeof result!.parse).toBe("function");
	});

	it("can parse TypeScript code", async () => {
		const result = await initParser("typescript");
		expect(result).not.toBeNull();
		const tree = result!.parse("const x = 1;");
		expect(tree).not.toBeNull();
		expect(tree!.rootNode).toBeDefined();
		expect(tree!.rootNode.type).toBe("program");
	});

	it("returns parser for python", async () => {
		const result = await initParser("python");
		expect(result).not.toBeNull();
		const tree = result!.parse("x = 1\n");
		expect(tree).not.toBeNull();
		expect(tree!.rootNode.type).toBe("module");
	});

	it("returns parser for go", async () => {
		const result = await initParser("go");
		expect(result).not.toBeNull();
		const tree = result!.parse("package main\n");
		expect(tree).not.toBeNull();
		expect(tree!.rootNode.type).toBe("source_file");
	});

	it("caches parser instances", async () => {
		const result1 = await initParser("typescript");
		const result2 = await initParser("typescript");
		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		// Language should be the same cached instance
		expect(result1!.language).toBe(result2!.language);
	});
});
