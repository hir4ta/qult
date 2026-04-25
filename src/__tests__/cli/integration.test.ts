/**
 * Integration test for the bundled CLI: builds via tsup if needed and
 * exercises `--version`, `--help`, `init --agent claude --force`, `check`,
 * and `add-agent` against a tempdir project.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const CLI = join(REPO_ROOT, "dist/cli.js");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
	version: string;
};

let projectRoot: string;

beforeAll(() => {
	if (!existsSync(CLI)) {
		execFileSync("npx", ["tsup"], { cwd: REPO_ROOT, stdio: "ignore" });
	}
	projectRoot = mkdtempSync(join(tmpdir(), "qult-cli-"));
});

afterAll(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

function run(args: string[], cwd = projectRoot): { stdout: string; status: number | null } {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
		return { stdout, status: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
	}
}

describe("qult CLI", () => {
	it("--version matches package.json", () => {
		const r = run(["--version"]);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe(PKG.version);
	});

	it("--help lists the 5 subcommands", () => {
		const r = run(["--help"]);
		expect(r.status).toBe(0);
		for (const c of ["init", "update", "check", "add-agent", "mcp"]) {
			expect(r.stdout).toContain(c);
		}
	});

	it("unknown command exits 1 with helpful message", () => {
		const r = run(["bogus"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("unknown command");
	});

	it("init --agent claude --force creates expected files", () => {
		const r = run(["init", "--agent", "claude", "--force", "--json"]);
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout) as { ok: boolean; integrations: string[] };
		expect(parsed.ok).toBe(true);
		expect(parsed.integrations).toEqual(["claude"]);
		expect(existsSync(join(projectRoot, ".mcp.json"))).toBe(true);
		expect(existsSync(join(projectRoot, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(projectRoot, "CLAUDE.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/commands/qult-spec.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".qult/config.json"))).toBe(true);
		const cfg = JSON.parse(readFileSync(join(projectRoot, ".qult/config.json"), "utf8"));
		expect(cfg.integrations.enabled).toEqual(["claude"]);
	});

	it("check --json reports pending_fixes=0 after init", () => {
		const r = run(["check", "--json"]);
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout) as { pending_fixes: number };
		expect(parsed.pending_fixes).toBe(0);
	});

	it("add-agent rejects unknown integration with available list", () => {
		const r = run(["add-agent", "totally-fake"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("unknown integration");
		expect(r.stdout).toContain("claude");
	});

	it("add-agent cursor --force adds and updates config", () => {
		const r = run(["add-agent", "cursor", "--force", "--json"]);
		expect(r.status).toBe(0);
		expect(existsSync(join(projectRoot, ".cursor/rules/qult.mdc"))).toBe(true);
		expect(existsSync(join(projectRoot, ".cursor/mcp.json"))).toBe(true);
		const cfg = JSON.parse(readFileSync(join(projectRoot, ".qult/config.json"), "utf8"));
		expect(cfg.integrations.enabled).toEqual(["claude", "cursor"]);
	});

	it("init --agent <unknown> exits 1", () => {
		const r = run(["init", "--agent", "nothing"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("unknown integration");
	});
});
