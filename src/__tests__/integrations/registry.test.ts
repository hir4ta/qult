import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectIntegrations,
	listIntegrationKeys,
	listIntegrations,
	resolveIntegration,
} from "../../integrations/registry.ts";

let projectRoot: string;

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "qult-registry-"));
});
afterEach(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

describe("registry", () => {
	it("lists 4 built-in integrations in canonical order", () => {
		expect(listIntegrationKeys()).toEqual(["claude", "codex", "cursor", "gemini"]);
		expect(listIntegrations()).toHaveLength(4);
	});

	it("resolveIntegration returns the matching def or null", () => {
		expect(resolveIntegration("claude")?.displayName).toBe("Claude Code");
		expect(resolveIntegration("nope")).toBeNull();
	});

	it("detectIntegrations returns empty when no marker dirs exist", () => {
		expect(detectIntegrations(projectRoot)).toEqual([]);
	});

	it("detectIntegrations finds tools by their marker directory", () => {
		mkdirSync(join(projectRoot, ".claude"));
		mkdirSync(join(projectRoot, ".cursor"));
		expect(detectIntegrations(projectRoot)).toEqual(["claude", "cursor"]);
	});

	it("claude integration detects @anthropic-ai/sdk in package.json devDeps", () => {
		writeFileSync(
			join(projectRoot, "package.json"),
			JSON.stringify({ devDependencies: { "@anthropic-ai/sdk": "^1.0.0" } }),
		);
		expect(detectIntegrations(projectRoot)).toContain("claude");
	});
});
