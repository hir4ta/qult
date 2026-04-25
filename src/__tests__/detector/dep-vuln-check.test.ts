import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

vi.mock("node:child_process");

beforeEach(() => {
	resetAllCaches();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── extractInstalledPackages ─────────────────────────────────

describe("extractInstalledPackages", () => {
	async function extract(command: string) {
		const { extractInstalledPackages } = await import("../../detector/dep-vuln-check.ts");
		return extractInstalledPackages(command);
	}

	it("parses npm install", async () => {
		const result = await extract("npm install lodash express");
		expect(result!.pm).toBe("npm");
		expect(result!.packages).toEqual(["lodash", "express"]);
	});

	it("parses npm install with flags", async () => {
		const result = await extract("npm install --save-dev typescript @types/node");
		expect(result!.pm).toBe("npm");
		expect(result!.packages).toEqual(["typescript", "@types/node"]);
	});

	it("parses npm i shorthand", async () => {
		const result = await extract("npm i axios");
		expect(result!.pm).toBe("npm");
		expect(result!.packages).toEqual(["axios"]);
	});

	it("parses pip install", async () => {
		const result = await extract("pip install requests flask");
		expect(result!.pm).toBe("pip");
		expect(result!.packages).toEqual(["requests", "flask"]);
	});

	it("parses pip install with version specifier", async () => {
		const result = await extract("pip install django>=4.0");
		expect(result!.pm).toBe("pip");
		expect(result!.packages).toEqual(["django"]);
	});

	it("parses cargo add", async () => {
		const result = await extract("cargo add serde tokio");
		expect(result!.pm).toBe("cargo");
		expect(result!.packages).toEqual(["serde", "tokio"]);
	});

	it("parses go get", async () => {
		const result = await extract("go get github.com/gin-gonic/gin");
		expect(result!.pm).toBe("go");
		expect(result!.packages).toEqual(["github.com/gin-gonic/gin"]);
	});

	it("parses bun add", async () => {
		const result = await extract("bun add elysia");
		expect(result!.pm).toBe("bun");
		expect(result!.packages).toEqual(["elysia"]);
	});

	it("parses yarn add", async () => {
		const result = await extract("yarn add react react-dom");
		expect(result!.pm).toBe("yarn");
		expect(result!.packages).toEqual(["react", "react-dom"]);
	});

	it("parses pnpm add", async () => {
		const result = await extract("pnpm add vite");
		expect(result!.pm).toBe("pnpm");
		expect(result!.packages).toEqual(["vite"]);
	});

	it("parses gem install", async () => {
		const result = await extract("gem install rails sinatra");
		expect(result!.pm).toBe("gem");
		expect(result!.packages).toEqual(["rails", "sinatra"]);
	});

	it("parses composer require", async () => {
		const result = await extract("composer require laravel/framework");
		expect(result!.pm).toBe("composer");
		expect(result!.packages).toEqual(["laravel/framework"]);
	});

	it("returns null for non-install commands", async () => {
		const result = await extract("git commit -m 'test'");
		expect(result).toBeNull();
	});

	it("returns null for install without packages (npm ci)", async () => {
		const result = await extract("npm ci");
		expect(result).toBeNull();
	});

	it("filters out flags from package list", async () => {
		const result = await extract("npm install -g --save lodash");
		expect(result!.pm).toBe("npm");
		expect(result!.packages).toEqual(["lodash"]);
	});

	it("handles scoped npm packages", async () => {
		const result = await extract("npm install @anthropic-ai/sdk");
		expect(result!.packages).toEqual(["@anthropic-ai/sdk"]);
	});

	it("skips flag arguments (pip install -r requirements.txt)", async () => {
		const result = await extract("pip install -r requirements.txt");
		expect(result).toBeNull(); // no actual package names
	});

	it("skips editable installs (pip install -e .)", async () => {
		const result = await extract("pip install -e .");
		expect(result).toBeNull(); // "." is a path, not a package
	});

	it("truncates at shell metacharacters (&&)", async () => {
		const result = await extract("pip install requests && npm install lodash");
		expect(result!.pm).toBe("pip");
		expect(result!.packages).toEqual(["requests"]);
	});

	it("truncates at pipe (|)", async () => {
		const result = await extract("npm install lodash | echo done");
		expect(result!.packages).toEqual(["lodash"]);
	});
});

// ── runOsvScanner ────────────────────────────────────────────

describe("runOsvScanner", () => {
	async function run() {
		vi.resetModules();
		vi.mock("node:child_process");
		const cp = await import("node:child_process");
		const mockExec = vi.mocked(cp.execFileSync);
		const { runOsvScanner } = await import("../../detector/dep-vuln-check.ts");
		return { mockExec, runOsvScanner };
	}

	it("returns stdout on success (exit 0)", async () => {
		const { mockExec, runOsvScanner } = await run();
		mockExec.mockReturnValue('{"results":[]}' as never);
		const result = runOsvScanner(["--format", "json"], "/tmp", 8000);
		expect(result).toBe('{"results":[]}');
	});

	it("returns stdout from exit code 1 (vulns found)", async () => {
		const { mockExec, runOsvScanner } = await run();
		mockExec.mockImplementation(() => {
			throw Object.assign(new Error("exit 1"), { stdout: '{"results":[{"packages":[]}]}' });
		});
		const result = runOsvScanner(["--format", "json"], "/tmp", 8000);
		expect(result).toBe('{"results":[{"packages":[]}]}');
	});

	it("returns null when not installed", async () => {
		const { mockExec, runOsvScanner } = await run();
		mockExec.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		const result = runOsvScanner(["--format", "json"], "/tmp", 8000);
		expect(result).toBeNull();
	});

	it("returns null on timeout", async () => {
		const { mockExec, runOsvScanner } = await run();
		mockExec.mockImplementation(() => {
			throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
		});
		const result = runOsvScanner(["--format", "json"], "/tmp", 8000);
		expect(result).toBeNull();
	});
});

// ── scanDependencyVulns ──────────────────────────────────────

describe("scanDependencyVulns", () => {
	async function scan(_cwd: string) {
		vi.resetModules();
		vi.mock("node:child_process");
		const cp = await import("node:child_process");
		const mockExec = vi.mocked(cp.execFileSync);

		// Return the mock so callers can set it up before calling scan
		return { mockExec };
	}

	async function runScan(cwd: string) {
		const { scanDependencyVulns } = await import("../../detector/dep-vuln-check.ts");
		return scanDependencyVulns(cwd);
	}

	it("parses osv-scanner JSON output with critical/high vulns", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockReturnValue(
			JSON.stringify({
				results: [
					{
						source: { path: "package-lock.json", type: "lockfile" },
						packages: [
							{
								package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
								vulnerabilities: [
									{
										id: "GHSA-jf85-cpcp-j695",
										summary: "Prototype Pollution in lodash",
										database_specific: { severity: "HIGH" },
									},
								],
							},
						],
					},
				],
			}) as never,
		);

		const fixes = await runScan("/tmp/test");
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("dep-vuln-check");
		expect(fixes[0]!.file).toBe("package-lock.json");
		expect(fixes[0]!.errors[0]).toContain("lodash");
		expect(fixes[0]!.errors[0]).toContain("HIGH");
	});

	it("skips moderate/low vulns (advisory only)", async () => {
		const { mockExec } = await scan("/tmp/test");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		mockExec.mockReturnValue(
			JSON.stringify({
				results: [
					{
						source: { path: "package-lock.json", type: "lockfile" },
						packages: [
							{
								package: { name: "minimist", version: "1.2.5", ecosystem: "npm" },
								vulnerabilities: [
									{
										id: "GHSA-xxx",
										summary: "Minor issue",
										database_specific: { severity: "LOW" },
									},
								],
							},
						],
					},
				],
			}) as never,
		);

		const fixes = await runScan("/tmp/test");
		expect(fixes.length).toBe(0);
		expect(stderrSpy).toHaveBeenCalled();
		stderrSpy.mockRestore();
	});

	it("returns empty array when osv-scanner is not installed", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});

		const fixes = await runScan("/tmp/test");
		expect(fixes).toEqual([]);
	});

	it("returns empty array on timeout (fail-open)", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockImplementation(() => {
			throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
		});

		const fixes = await runScan("/tmp/test");
		expect(fixes).toEqual([]);
	});

	it("returns empty array on malformed JSON output", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockReturnValue("not json" as never);

		const fixes = await runScan("/tmp/test");
		expect(fixes).toEqual([]);
	});

	it("handles multiple packages with mixed severities", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockReturnValue(
			JSON.stringify({
				results: [
					{
						source: { path: "package-lock.json", type: "lockfile" },
						packages: [
							{
								package: { name: "pkg-a", version: "1.0.0", ecosystem: "npm" },
								vulnerabilities: [
									{
										id: "CVE-1",
										summary: "Critical bug",
										database_specific: { severity: "CRITICAL" },
									},
								],
							},
							{
								package: { name: "pkg-b", version: "2.0.0", ecosystem: "npm" },
								vulnerabilities: [
									{
										id: "CVE-2",
										summary: "Low bug",
										database_specific: { severity: "MODERATE" },
									},
								],
							},
						],
					},
				],
			}) as never,
		);

		const fixes = await runScan("/tmp/test");
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("pkg-a");
	});

	it("handles CVSS severity when database_specific.severity is absent", async () => {
		const { mockExec } = await scan("/tmp/test");
		mockExec.mockReturnValue(
			JSON.stringify({
				results: [
					{
						source: { path: "Cargo.lock", type: "lockfile" },
						packages: [
							{
								package: { name: "regex", version: "1.9.0", ecosystem: "crates.io" },
								vulnerabilities: [
									{
										id: "RUSTSEC-2025-0001",
										summary: "DoS via regex",
										severity: [
											{
												type: "CVSS_V3",
												score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
											},
										],
									},
								],
							},
						],
					},
				],
			}) as never,
		);

		const fixes = await runScan("/tmp/test");
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("regex");
	});

	it("parses osv-scanner stdout from exit code 1 (vulns found)", async () => {
		const { mockExec } = await scan("/tmp/test");
		const errWithStdout = Object.assign(new Error("exit 1"), {
			status: 1,
			stdout: JSON.stringify({
				results: [
					{
						source: { path: "go.sum", type: "lockfile" },
						packages: [
							{
								package: { name: "golang.org/x/net", version: "0.0.0", ecosystem: "Go" },
								vulnerabilities: [
									{
										id: "GO-2024-001",
										summary: "HTTP/2 DoS",
										database_specific: { severity: "HIGH" },
									},
								],
							},
						],
					},
				],
			}),
		});
		mockExec.mockImplementation(() => {
			throw errWithStdout;
		});

		const fixes = await runScan("/tmp/test");
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("golang.org/x/net");
	});
});
