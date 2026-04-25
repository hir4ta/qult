/**
 * Wave 6 E2E smoke: drives the bundled CLI end-to-end against a tempdir,
 * then spawns the bundled MCP server and verifies it answers `tools/list`.
 *
 * This is the gate that lets us rip out plugin/ in this Wave — if this passes,
 * the Node CLI alone is sufficient.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const CLI = join(REPO_ROOT, "dist/cli.js");
const MCP = join(REPO_ROOT, "dist/mcp-server.js");

let projectRoot: string;

beforeAll(() => {
	if (!existsSync(CLI) || !existsSync(MCP)) {
		execFileSync("npx", ["tsup"], { cwd: REPO_ROOT, stdio: "ignore" });
	}
	projectRoot = mkdtempSync(join(tmpdir(), "qult-e2e-"));
});
afterAll(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

describe("e2e: init + MCP server", () => {
	it("init --agent claude --force creates the full file tree", () => {
		execFileSync(process.execPath, [CLI, "init", "--agent", "claude", "--force", "--json"], {
			cwd: projectRoot,
		});
		expect(existsSync(join(projectRoot, ".mcp.json"))).toBe(true);
		expect(existsSync(join(projectRoot, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(projectRoot, "CLAUDE.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/skills/qult-spec/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/skills/qult-wave-start/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/skills/qult-wave-complete/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/skills/qult-review/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".claude/skills/qult-finish/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".qult/config.json"))).toBe(true);
		const mcp = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
		expect(mcp.mcpServers.qult).toEqual({
			type: "stdio",
			command: "npx",
			args: ["@hir4ta/qult", "mcp"],
		});
	});

	it("MCP server responds to tools/list with 20 tools", async () => {
		const child = spawn(process.execPath, [MCP], {
			cwd: projectRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));

		// Send a single JSON-RPC tools/list and close stdin.
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
		);
		child.stdin.end();

		await new Promise<void>((res) => {
			child.on("exit", () => res());
		});

		const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
		const lines = out.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const response = JSON.parse(lines[0]!) as {
			result: { tools: Array<{ name: string }> };
		};
		expect(response.result.tools).toHaveLength(20);
		const names = response.result.tools.map((t) => t.name).sort();
		expect(names).toContain("get_active_spec");
		expect(names).toContain("update_task_status");
		expect(names).toContain("complete_wave");
		expect(names).toContain("get_pending_fixes");
	});
});
