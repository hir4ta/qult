// src/mcp-server.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
var STATE_DIR = ".qult/.state";
var GATES_PATH = ".qult/gates.json";
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_NAME = "qult";
var SERVER_VERSION = "1.0.0";
var CACHE_TTL_MS = 2000;
var _jsonCache = new Map;
function readJson(path, fallback) {
  const now = Date.now();
  const cached = _jsonCache.get(path);
  if (cached && cached.expires > now)
    return cached.value;
  try {
    if (!existsSync(path))
      return fallback;
    const value = JSON.parse(readFileSync(path, "utf-8"));
    _jsonCache.set(path, { value, expires: now + CACHE_TTL_MS });
    return value;
  } catch {
    return fallback;
  }
}
function findLatestStateFile(cwd, prefix) {
  const dir = join(cwd, STATE_DIR);
  const nonScoped = join(dir, `${prefix}.json`);
  try {
    if (!existsSync(dir))
      return nonScoped;
    try {
      const markerPath = join(dir, "latest-session.json");
      if (existsSync(markerPath)) {
        const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
        if (marker?.session_id) {
          const scoped = join(dir, `${prefix}-${marker.session_id}.json`);
          if (existsSync(scoped))
            return scoped;
        }
      }
    } catch {}
    const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return nonScoped;
    return join(dir, files[0].name);
  } catch {
    return nonScoped;
  }
}
function formatPendingFixes(fixes) {
  const lines = [`${fixes.length} pending fix(es):
`];
  for (const fix of fixes) {
    lines.push(`[${fix.gate}] ${fix.file}`);
    for (const err of fix.errors) {
      lines.push(`  ${err}`);
    }
  }
  return lines.join(`
`);
}
var TOOL_DEFS = [
  {
    name: "get_pending_fixes",
    description: "Returns lint/typecheck errors that must be fixed. Call when DENIED by qult. Response: '[gate] file\\n  error details' per fix, or 'No pending fixes.'",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_session_status",
    description: "Returns session state as JSON: test_passed_at, review_completed_at, changed_file_paths, review_iteration. Call before committing to verify gates.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_gate_config",
    description: "Returns gate definitions as JSON: on_write (lint/typecheck per file), on_commit (test), on_review (e2e). Each gate has command, timeout, optional run_once_per_batch.",
    inputSchema: { type: "object", properties: {} }
  }
];
function handleTool(name, cwd) {
  switch (name) {
    case "get_pending_fixes": {
      const path = findLatestStateFile(cwd, "pending-fixes");
      const fixes = readJson(path, []);
      if (!Array.isArray(fixes) || fixes.length === 0) {
        return { content: [{ type: "text", text: "No pending fixes." }] };
      }
      return { content: [{ type: "text", text: formatPendingFixes(fixes) }] };
    }
    case "get_session_status": {
      const path = findLatestStateFile(cwd, "session-state");
      const state = readJson(path, null);
      if (!state) {
        return {
          isError: true,
          content: [{ type: "text", text: "No session state. Run /qult:init to set up." }]
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }
    case "get_gate_config": {
      const gatesPath = join(cwd, GATES_PATH);
      const gates = readJson(gatesPath, null);
      if (!gates) {
        return {
          isError: true,
          content: [{ type: "text", text: "No gates configured. Run /qult:detect-gates." }]
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(gates, null, 2) }] };
    }
    default:
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}
function handleRequest(parsed, cwd) {
  const id = parsed.id;
  if (id === undefined || id === null)
    return null;
  switch (parsed.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: [
            "qult enforces quality gates (lint, typecheck, test, review) via hooks.",
            "Hooks block tool use with exit 2 when violations exist.",
            "",
            "IMPORTANT: When a tool is DENIED by qult, call get_pending_fixes immediately.",
            "Before committing, call get_session_status to verify test/review gates.",
            "If gates are not configured, run /qult:detect-gates."
          ].join(`
`)
        }
      };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };
    case "tools/call": {
      const toolName = parsed.params?.name;
      if (typeof toolName !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name" }
        };
      }
      return { jsonrpc: "2.0", id, result: handleTool(toolName, cwd) };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${parsed.method}` }
      };
  }
}
async function main() {
  const cwd = process.env.QULT_CWD ?? process.cwd();
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim())
      continue;
    try {
      const parsed = JSON.parse(line);
      const response = handleRequest(parsed, cwd);
      if (response) {
        process.stdout.write(JSON.stringify(response) + `
`);
      }
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      }) + `
`);
    }
  }
}
main().catch((err) => {
  process.stderr.write(`[qult-mcp] Fatal: ${err}
`);
  process.exit(1);
});
function resetMcpCache() {
  _jsonCache.clear();
}
export {
  resetMcpCache,
  readJson,
  handleTool,
  handleRequest,
  findLatestStateFile,
  TOOL_DEFS
};
