// src/mcp-server.ts
import { existsSync as existsSync2, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// src/state/atomic-write.ts
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function atomicWriteJson(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// src/mcp-server.ts
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
    if (!existsSync2(path))
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
    if (!existsSync2(dir))
      return nonScoped;
    try {
      const markerPath = join(dir, "latest-session.json");
      if (existsSync2(markerPath)) {
        const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
        if (marker?.session_id) {
          const scoped = join(dir, `${prefix}-${marker.session_id}.json`);
          if (existsSync2(scoped))
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
function getValidGateNames(cwd) {
  const gatesPath = join(cwd, GATES_PATH);
  const gates = readJson(gatesPath, null);
  const names = new Set(["review"]);
  if (gates) {
    for (const category of [gates.on_write, gates.on_commit, gates.on_review]) {
      if (category) {
        for (const name of Object.keys(category))
          names.add(name);
      }
    }
  }
  return [...names];
}
function isValidGateName(name, cwd) {
  return getValidGateNames(cwd).includes(name);
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
  },
  {
    name: "disable_gate",
    description: "Temporarily disable a gate for this session. The gate will not run on file edits or block commits. Use when a gate is broken or irrelevant for current work. Re-enable with enable_gate.",
    inputSchema: {
      type: "object",
      properties: {
        gate_name: {
          type: "string",
          description: "Gate name to disable (e.g. 'lint', 'typecheck', 'test')"
        }
      },
      required: ["gate_name"]
    }
  },
  {
    name: "enable_gate",
    description: "Re-enable a previously disabled gate.",
    inputSchema: {
      type: "object",
      properties: { gate_name: { type: "string", description: "Gate name to re-enable" } },
      required: ["gate_name"]
    }
  },
  {
    name: "set_config",
    description: "Set a qult config value in .qult/config.json. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, plan_eval.score_threshold, plan_eval.max_iterations.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Config key (e.g. 'review.score_threshold')"
        },
        value: {
          type: "number",
          description: "Numeric value to set"
        }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "clear_pending_fixes",
    description: "Clear all pending lint/typecheck fixes. Use when fixes are false positives or already resolved outside qult.",
    inputSchema: { type: "object", properties: {} }
  }
];
function handleTool(name, cwd, args) {
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
    case "disable_gate": {
      const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
      if (!gateName) {
        return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
      }
      if (!isValidGateName(gateName, cwd)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown gate '${gateName}'. Valid gates: ${getValidGateNames(cwd).join(", ")}`
            }
          ]
        };
      }
      const statePath = findLatestStateFile(cwd, "session-state");
      const state = readJson(statePath, {});
      const disabled = Array.isArray(state.disabled_gates) ? state.disabled_gates : [];
      if (!disabled.includes(gateName)) {
        disabled.push(gateName);
      }
      state.disabled_gates = disabled;
      try {
        atomicWriteJson(statePath, state);
        _jsonCache.delete(statePath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to write state." }] };
      }
      return { content: [{ type: "text", text: `Gate '${gateName}' disabled for this session.` }] };
    }
    case "enable_gate": {
      const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
      if (!gateName) {
        return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
      }
      const statePath = findLatestStateFile(cwd, "session-state");
      const state = readJson(statePath, {});
      const disabled = Array.isArray(state.disabled_gates) ? state.disabled_gates : [];
      state.disabled_gates = disabled.filter((g) => g !== gateName);
      try {
        atomicWriteJson(statePath, state);
        _jsonCache.delete(statePath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to write state." }] };
      }
      return { content: [{ type: "text", text: `Gate '${gateName}' re-enabled.` }] };
    }
    case "set_config": {
      const key = typeof args?.key === "string" ? args.key : null;
      const value = typeof args?.value === "number" ? args.value : null;
      if (!key || value === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing key or value parameter." }]
        };
      }
      const ALLOWED_KEYS = [
        "review.score_threshold",
        "review.max_iterations",
        "review.required_changed_files",
        "plan_eval.score_threshold",
        "plan_eval.max_iterations"
      ];
      if (!ALLOWED_KEYS.includes(key)) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid key '${key}'. Allowed: ${ALLOWED_KEYS.join(", ")}` }
          ]
        };
      }
      const configPath = join(cwd, ".qult", "config.json");
      const config = readJson(configPath, {});
      const [section, field] = key.split(".");
      if (!section || !field) {
        return { isError: true, content: [{ type: "text", text: "Invalid key format." }] };
      }
      if (!config[section] || typeof config[section] !== "object") {
        config[section] = {};
      }
      config[section][field] = value;
      try {
        atomicWriteJson(configPath, config);
        _jsonCache.delete(configPath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to write config." }] };
      }
      return { content: [{ type: "text", text: `Config set: ${key} = ${value}` }] };
    }
    case "clear_pending_fixes": {
      const fixesPath = findLatestStateFile(cwd, "pending-fixes");
      try {
        atomicWriteJson(fixesPath, []);
        _jsonCache.delete(fixesPath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to clear fixes." }] };
      }
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
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
      const params = parsed.params;
      const toolName = params?.name;
      if (typeof toolName !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name" }
        };
      }
      const toolArgs = typeof params?.arguments === "object" ? params.arguments : undefined;
      return { jsonrpc: "2.0", id, result: handleTool(toolName, cwd, toolArgs) };
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
        process.stdout.write(`${JSON.stringify(response)}
`);
      }
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      })}
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
