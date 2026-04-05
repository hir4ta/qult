// src/mcp-server.ts
import { existsSync as existsSync5, readdirSync as readdirSync2, readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { createInterface } from "node:readline";

// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
var DEFAULTS = {
  review: {
    score_threshold: 34,
    max_iterations: 3,
    required_changed_files: 5,
    dimension_floor: 4,
    require_human_approval: false
  },
  plan_eval: {
    score_threshold: 10,
    max_iterations: 2,
    registry_files: []
  },
  gates: {
    output_max_chars: 2000,
    default_timeout: 1e4,
    test_on_edit: false,
    test_on_edit_timeout: 15000,
    extra_path: []
  }
};
function applyConfigLayer(config, raw) {
  if (raw.review && typeof raw.review === "object") {
    const r = raw.review;
    if (typeof r.score_threshold === "number")
      config.review.score_threshold = r.score_threshold;
    if (typeof r.max_iterations === "number")
      config.review.max_iterations = r.max_iterations;
    if (typeof r.required_changed_files === "number")
      config.review.required_changed_files = Math.max(1, r.required_changed_files);
    if (typeof r.dimension_floor === "number")
      config.review.dimension_floor = Math.max(1, Math.min(5, r.dimension_floor));
    if (typeof r.require_human_approval === "boolean")
      config.review.require_human_approval = r.require_human_approval;
  }
  if (raw.plan_eval && typeof raw.plan_eval === "object") {
    const p = raw.plan_eval;
    if (typeof p.score_threshold === "number")
      config.plan_eval.score_threshold = p.score_threshold;
    if (typeof p.max_iterations === "number")
      config.plan_eval.max_iterations = p.max_iterations;
    if (Array.isArray(p.registry_files))
      config.plan_eval.registry_files = p.registry_files.filter((f) => typeof f === "string");
  }
  if (raw.gates && typeof raw.gates === "object") {
    const g = raw.gates;
    if (typeof g.output_max_chars === "number")
      config.gates.output_max_chars = g.output_max_chars;
    if (typeof g.default_timeout === "number")
      config.gates.default_timeout = g.default_timeout;
    if (typeof g.test_on_edit === "boolean")
      config.gates.test_on_edit = g.test_on_edit;
    if (typeof g.test_on_edit_timeout === "number")
      config.gates.test_on_edit_timeout = g.test_on_edit_timeout;
    if (Array.isArray(g.extra_path))
      config.gates.extra_path = g.extra_path.filter((p) => typeof p === "string" && p.trim().length > 0);
  }
}
var _cache = null;
function loadConfig() {
  if (_cache)
    return _cache;
  const config = structuredClone(DEFAULTS);
  try {
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (pluginDataDir) {
      const prefsPath = join(pluginDataDir, "preferences.json");
      if (existsSync(prefsPath)) {
        const raw = JSON.parse(readFileSync(prefsPath, "utf-8"));
        applyConfigLayer(config, raw);
      }
    }
  } catch {}
  try {
    const configPath = join(process.cwd(), ".qult", "config.json");
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      applyConfigLayer(config, raw);
    }
  } catch {}
  const envInt = (key) => {
    const val = process.env[key];
    if (val === undefined)
      return;
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  config.review.score_threshold = envInt("QULT_REVIEW_SCORE_THRESHOLD") ?? config.review.score_threshold;
  config.review.max_iterations = envInt("QULT_REVIEW_MAX_ITERATIONS") ?? config.review.max_iterations;
  config.review.required_changed_files = envInt("QULT_REVIEW_REQUIRED_FILES") ?? config.review.required_changed_files;
  const rawFloor = envInt("QULT_REVIEW_DIMENSION_FLOOR");
  if (rawFloor !== undefined)
    config.review.dimension_floor = Math.max(1, Math.min(5, rawFloor));
  config.plan_eval.score_threshold = envInt("QULT_PLAN_EVAL_SCORE_THRESHOLD") ?? config.plan_eval.score_threshold;
  config.plan_eval.max_iterations = envInt("QULT_PLAN_EVAL_MAX_ITERATIONS") ?? config.plan_eval.max_iterations;
  config.gates.output_max_chars = envInt("QULT_GATE_OUTPUT_MAX") ?? config.gates.output_max_chars;
  config.gates.default_timeout = envInt("QULT_GATE_DEFAULT_TIMEOUT") ?? config.gates.default_timeout;
  const humanApprovalEnv = process.env.QULT_REQUIRE_HUMAN_APPROVAL;
  if (humanApprovalEnv === "1" || humanApprovalEnv === "true")
    config.review.require_human_approval = true;
  else if (humanApprovalEnv === "0" || humanApprovalEnv === "false")
    config.review.require_human_approval = false;
  const testOnEditEnv = process.env.QULT_TEST_ON_EDIT;
  if (testOnEditEnv === "1" || testOnEditEnv === "true")
    config.gates.test_on_edit = true;
  else if (testOnEditEnv === "0" || testOnEditEnv === "false")
    config.gates.test_on_edit = false;
  config.gates.test_on_edit_timeout = envInt("QULT_TEST_ON_EDIT_TIMEOUT") ?? config.gates.test_on_edit_timeout;
  _cache = config;
  return config;
}

// src/state/atomic-write.ts
import { existsSync as existsSync2, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function atomicWriteJson(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync2(dir))
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

// src/state/audit-log.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var STATE_DIR = ".qult/.state";
var AUDIT_LOG_FILE = "audit-log.json";
var MAX_ENTRIES = 200;
function appendAuditLog(cwd, entry) {
  try {
    const logPath = join2(cwd, STATE_DIR, AUDIT_LOG_FILE);
    let log = readAuditLog(cwd);
    log.push(entry);
    if (log.length > MAX_ENTRIES) {
      log = log.slice(-MAX_ENTRIES);
    }
    atomicWriteJson(logPath, log);
  } catch {}
}
function readAuditLog(cwd) {
  try {
    const logPath = join2(cwd, STATE_DIR, AUDIT_LOG_FILE);
    if (!existsSync3(logPath))
      return [];
    const parsed = JSON.parse(readFileSync2(logPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// src/state/plan-status.ts
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync3, statSync } from "node:fs";
import { join as join3 } from "node:path";
function hasPlanFile() {
  try {
    const planDir = join3(process.cwd(), ".claude", "plans");
    if (!existsSync4(planDir))
      return false;
    return readdirSync(planDir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

// src/mcp-server.ts
var STATE_DIR2 = ".qult/.state";
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
    if (!existsSync5(path))
      return fallback;
    const value = JSON.parse(readFileSync4(path, "utf-8"));
    _jsonCache.set(path, { value, expires: now + CACHE_TTL_MS });
    return value;
  } catch {
    return fallback;
  }
}
function findLatestStateFile(cwd, prefix) {
  const dir = join4(cwd, STATE_DIR2);
  const nonScoped = join4(dir, `${prefix}.json`);
  try {
    if (!existsSync5(dir))
      return nonScoped;
    try {
      const markerPath = join4(dir, "latest-session.json");
      if (existsSync5(markerPath)) {
        const marker = JSON.parse(readFileSync4(markerPath, "utf-8"));
        if (marker?.session_id) {
          const scoped = join4(dir, `${prefix}-${marker.session_id}.json`);
          if (existsSync5(scoped))
            return scoped;
        }
      }
    } catch {}
    const files = readdirSync2(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).map((f) => ({ name: f, mtime: statSync2(join4(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return nonScoped;
    return join4(dir, files[0].name);
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
  const gatesPath = join4(cwd, GATES_PATH);
  const gates = readJson(gatesPath, null);
  const names = new Set([
    "review",
    "security-check",
    "dead-import-check",
    "duplication-check"
  ]);
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
    description: "Temporarily disable a gate for this session. The gate will not run on file edits or block commits. Use when a gate is broken or irrelevant for current work. Re-enable with enable_gate. Maximum 2 gates can be disabled per session.",
    inputSchema: {
      type: "object",
      properties: {
        gate_name: {
          type: "string",
          description: "Gate name to disable (e.g. 'lint', 'typecheck', 'test')"
        },
        reason: {
          type: "string",
          description: "Why this gate should be disabled (min 10 chars). Required for audit trail."
        }
      },
      required: ["gate_name", "reason"]
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
    description: "Set a qult config value in .qult/config.json. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, plan_eval.score_threshold, plan_eval.max_iterations.",
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
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why pending fixes should be cleared (min 10 chars). Required for audit trail."
        }
      },
      required: ["reason"]
    }
  },
  {
    name: "record_review",
    description: "Record that an independent review has been completed. Call this at the end of /qult:review after all stages pass. Required for the commit gate to allow commits.",
    inputSchema: {
      type: "object",
      properties: {
        aggregate_score: {
          type: "number",
          description: "Aggregate review score (e.g. 34 out of 40 for 4-stage review)"
        }
      }
    }
  },
  {
    name: "record_test_pass",
    description: "Record that tests have passed. Call after running tests successfully. Required for the commit gate to allow commits when on_commit gates are configured.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The test command that was run (e.g. 'bun vitest run')"
        }
      },
      required: ["command"]
    }
  },
  {
    name: "get_detector_summary",
    description: "Returns a consolidated summary of all computational detector findings from the current session. Includes escalation counters (security, dead-import, drift, test-quality, duplication warnings) and pending fixes grouped by gate. Call before /qult:review to collect ground truth for reviewers.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "record_human_approval",
    description: "Record that the architect has reviewed and approved the changes. Required when review.require_human_approval is enabled in config. Call after the human has reviewed the code.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "record_stage_scores",
    description: "Record review scores for a specific stage (Spec, Quality, Security, or Adversarial). Call after each review stage passes with scores. Used for 4-stage aggregate score tracking (/40).",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description: "Stage name: 'Spec', 'Quality', or 'Security'"
        },
        scores: {
          type: "object",
          description: "Dimension scores (e.g. {completeness: 5, accuracy: 4} for Spec stage)"
        }
      },
      required: ["stage", "scores"]
    }
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
      const gatesPath = join4(cwd, GATES_PATH);
      const gates = readJson(gatesPath, null);
      if (!gates) {
        return {
          isError: true,
          content: [{ type: "text", text: "No gates configured. Run /qult:init." }]
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(gates, null, 2) }] };
    }
    case "disable_gate": {
      const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!gateName) {
        return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
      }
      if (!reason || reason.length < 10) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Missing or too short reason parameter (min 10 chars). Explain WHY the gate should be disabled."
            }
          ]
        };
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
      if (!disabled.includes(gateName) && disabled.length >= 2) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Maximum 2 gates can be disabled per session. Currently disabled: ${disabled.join(", ")}. Re-enable a gate first.`
            }
          ]
        };
      }
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
      appendAuditLog(cwd, {
        action: "disable_gate",
        reason,
        gate_name: gateName,
        timestamp: new Date().toISOString()
      });
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
        "review.dimension_floor",
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
      if (key === "review.dimension_floor" && (value < 1 || value > 5)) {
        return {
          isError: true,
          content: [{ type: "text", text: "dimension_floor must be between 1 and 5." }]
        };
      }
      const configPath = join4(cwd, ".qult", "config.json");
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
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!reason || reason.length < 10) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Missing or too short reason parameter (min 10 chars). Explain WHY pending fixes should be cleared."
            }
          ]
        };
      }
      const fixesPath = findLatestStateFile(cwd, "pending-fixes");
      try {
        atomicWriteJson(fixesPath, []);
        _jsonCache.delete(fixesPath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to clear fixes." }] };
      }
      appendAuditLog(cwd, {
        action: "clear_pending_fixes",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
    }
    case "get_detector_summary": {
      const statePath = findLatestStateFile(cwd, "session-state");
      const state = readJson(statePath, {});
      const fixesPath = findLatestStateFile(cwd, "pending-fixes");
      const fixes = readJson(fixesPath, []);
      const lines = [];
      const counters = [
        "security_warning_count",
        "dead_import_warning_count",
        "drift_warning_count",
        "test_quality_warning_count",
        "duplication_warning_count"
      ];
      for (const key of counters) {
        const val = typeof state[key] === "number" ? state[key] : 0;
        if (val > 0)
          lines.push(`${key}: ${val}`);
      }
      if (Array.isArray(fixes) && fixes.length > 0) {
        const byGate = {};
        for (const fix of fixes) {
          const g = fix.gate ?? "unknown";
          if (!byGate[g])
            byGate[g] = [];
          byGate[g].push(fix);
        }
        for (const [gate, gateFixes] of Object.entries(byGate)) {
          lines.push(`
[${gate}] ${gateFixes.length} issue(s):`);
          for (const fix of gateFixes) {
            const relPath = fix.file.startsWith(`${cwd}/`) ? fix.file.slice(cwd.length + 1) : fix.file;
            lines.push(`  ${relPath}`);
            for (const err of fix.errors.slice(0, 3)) {
              lines.push(`    ${err.slice(0, 200)}`);
            }
          }
        }
      }
      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No detector findings." }] };
      }
      return { content: [{ type: "text", text: lines.join(`
`) }] };
    }
    case "record_review": {
      const statePath = findLatestStateFile(cwd, "session-state");
      const state = readJson(statePath, {});
      try {
        const changedPaths = Array.isArray(state.changed_file_paths) ? state.changed_file_paths : [];
        const threshold = loadConfig().review.required_changed_files;
        if (changedPaths.length >= threshold && !hasPlanFile()) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Cannot record review: ${changedPaths.length} files changed without a plan. Run /qult:plan-generator first.`
              }
            ]
          };
        }
      } catch {}
      try {
        state.review_completed_at = new Date().toISOString();
        atomicWriteJson(statePath, state);
        _jsonCache.delete(statePath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to record review." }] };
      }
      const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
      const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
      return { content: [{ type: "text", text: msg }] };
    }
    case "record_test_pass": {
      const cmd = typeof args?.command === "string" ? args.command : null;
      if (!cmd) {
        return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
      }
      const statePath = findLatestStateFile(cwd, "session-state");
      try {
        const state = readJson(statePath, {});
        state.test_passed_at = new Date().toISOString();
        state.test_command = cmd;
        atomicWriteJson(statePath, state);
        _jsonCache.delete(statePath);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to record test pass." }]
        };
      }
      return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
    }
    case "record_human_approval": {
      const haStatePath = findLatestStateFile(cwd, "session-state");
      const haState = readJson(haStatePath, {});
      if (!haState.review_completed_at) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Cannot record human approval: no review has been completed yet. Run /qult:review first."
            }
          ]
        };
      }
      try {
        haState.human_review_approved_at = new Date().toISOString();
        atomicWriteJson(haStatePath, haState);
        _jsonCache.delete(haStatePath);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Failed to record approval." }] };
      }
      appendAuditLog(cwd, {
        action: "record_human_approval",
        reason: "Architect approved changes",
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "Human approval recorded." }] };
    }
    case "record_stage_scores": {
      const stage = typeof args?.stage === "string" ? args.stage : null;
      const scores = args?.scores;
      if (!stage || !scores || typeof scores !== "object") {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing stage or scores parameter." }]
        };
      }
      const validStages = ["Spec", "Quality", "Security", "Adversarial"];
      if (!validStages.includes(stage)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid stage '${stage}'. Must be: ${validStages.join(", ")}`
            }
          ]
        };
      }
      const statePath = findLatestStateFile(cwd, "session-state");
      try {
        const state = readJson(statePath, {});
        if (!state.review_stage_scores || typeof state.review_stage_scores !== "object" || Array.isArray(state.review_stage_scores)) {
          state.review_stage_scores = {};
        }
        state.review_stage_scores[stage] = scores;
        atomicWriteJson(statePath, state);
        _jsonCache.delete(statePath);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to record stage scores." }]
        };
      }
      return {
        content: [
          { type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` }
        ]
      };
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
            "If gates are not configured, run /qult:init.",
            "",
            "## Quality Rules",
            "- ALWAYS write the test file FIRST, then implement.",
            "- At least 2 meaningful assertions per test case.",
            "- NEVER mark implementation as complete until tests pass.",
            "- Quick fix (no plan): keep changes focused, 1-2 files per logical change.",
            "- Planned work: follow the plan's task boundaries.",
            "",
            "## Plan Structure",
            "When writing a plan, use: ## Context, ## Tasks (### Task N with File/Change/Boundary/Verify), ## Success Criteria.",
            "Update task status to [done] as you complete each task.",
            "",
            "## Workflow",
            "- When requirements are unclear, use /qult:explore to interview the architect.",
            "- When debugging, use /qult:debug for structured root-cause analysis.",
            "- When finishing a branch, use /qult:finish for structured completion.",
            "- Independent 4-stage review (/qult:review) is required for large changes or when a plan is active.",
            "",
            "## Hook/MCP Roles",
            "- Hooks detect test pass best-effort via output parsing. If tests passed but hook didn't detect it, call record_test_pass explicitly.",
            "- After committing, session state resets (test/review cleared). This is expected — gates only apply to uncommitted changes.",
            "- MCP tools (record_test_pass, record_review) are the authoritative state management mechanism.",
            "",
            "## Ground Truth for Reviews",
            "- Before running /qult:review, call get_detector_summary to collect computational detector findings (security, imports, duplications, test quality).",
            "- Pass detector findings as context to each reviewer stage — reviewers must not contradict detector results.",
            "",
            "## Human Approval",
            "- If review.require_human_approval is enabled, call record_human_approval after the architect has reviewed and approved the changes."
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
