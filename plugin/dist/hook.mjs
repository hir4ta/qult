import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

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
var init_atomic_write = () => {};

// src/config.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { join } from "node:path";
function applyConfigLayer(config, raw) {
  if (raw.review && typeof raw.review === "object") {
    const r = raw.review;
    if (typeof r.score_threshold === "number")
      config.review.score_threshold = r.score_threshold;
    if (typeof r.max_iterations === "number")
      config.review.max_iterations = r.max_iterations;
    if (typeof r.required_changed_files === "number")
      config.review.required_changed_files = r.required_changed_files;
    if (typeof r.dimension_floor === "number")
      config.review.dimension_floor = Math.max(1, Math.min(5, r.dimension_floor));
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
  }
}
function loadConfig() {
  if (_cache)
    return _cache;
  const config = structuredClone(DEFAULTS);
  try {
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (pluginDataDir) {
      const prefsPath = join(pluginDataDir, "preferences.json");
      if (existsSync2(prefsPath)) {
        const raw = JSON.parse(readFileSync(prefsPath, "utf-8"));
        applyConfigLayer(config, raw);
      }
    }
  } catch {}
  try {
    const configPath = join(process.cwd(), ".qult", "config.json");
    if (existsSync2(configPath)) {
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
  _cache = config;
  return config;
}
var DEFAULTS, _cache = null;
var init_config = __esm(() => {
  DEFAULTS = {
    review: {
      score_threshold: 26,
      max_iterations: 3,
      required_changed_files: 5,
      dimension_floor: 4
    },
    plan_eval: {
      score_threshold: 10,
      max_iterations: 2,
      registry_files: []
    },
    gates: {
      output_max_chars: 2000,
      default_timeout: 1e4
    }
  };
});

// src/gates/load.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function loadGates() {
  if (_cache2 !== undefined)
    return _cache2;
  try {
    const path = join2(process.cwd(), ".qult", "gates.json");
    if (!existsSync3(path)) {
      _cache2 = null;
      return null;
    }
    const parsed = JSON.parse(readFileSync2(path, "utf-8"));
    _cache2 = parsed;
    return parsed;
  } catch {
    _cache2 = null;
    return null;
  }
}
var _cache2;
var init_load = () => {};

// src/state/pending-fixes.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function setFixesSessionScope(sessionId) {
  if (!/^[\w-]+$/.test(sessionId))
    return;
  _sessionScope = sessionId;
}
function fixesPath() {
  const file = _sessionScope ? `pending-fixes-${_sessionScope}.json` : FIXES_FILE;
  return join3(process.cwd(), STATE_DIR, file);
}
function readPendingFixes() {
  if (_cache3)
    return _cache3;
  try {
    const path = fixesPath();
    if (!existsSync4(path)) {
      _cache3 = [];
      return _cache3;
    }
    const raw = readFileSync3(path, "utf-8");
    _cache3 = JSON.parse(raw);
    return _cache3;
  } catch {
    _cache3 = [];
    return _cache3;
  }
}
function writePendingFixes(fixes) {
  _cache3 = fixes;
  _dirty = true;
}
function addPendingFixes(file, newFixes) {
  const existing = readPendingFixes().filter((f) => f.file !== file);
  writePendingFixes([...existing, ...newFixes]);
}
function clearPendingFixesForFile(file) {
  const current = readPendingFixes();
  const remaining = current.filter((f) => f.file !== file);
  if (remaining.length !== current.length) {
    writePendingFixes(remaining);
  }
}
function flush() {
  if (!_dirty || !_cache3)
    return;
  try {
    atomicWriteJson(fixesPath(), _cache3);
  } catch (e) {
    if (e instanceof Error)
      process.stderr.write(`[qult] write error: ${e.message}
`);
  }
  _dirty = false;
}
var STATE_DIR = ".qult/.state", FIXES_FILE = "pending-fixes.json", _cache3 = null, _dirty = false, _sessionScope = null;
var init_pending_fixes = __esm(() => {
  init_atomic_write();
});

// src/state/plan-status.ts
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync4, statSync } from "node:fs";
import { join as join4 } from "node:path";
function normalizeStatus(raw) {
  if (!raw)
    return "pending";
  const s = raw.toLowerCase().trim();
  if (s === "done" || s === "complete" || s === "completed" || s === "finished")
    return "done";
  if (s === "in-progress" || s === "wip" || s === "started" || s === "working")
    return "in-progress";
  return "pending";
}
function parsePlanTasks(content) {
  const tasks = [];
  const lines = content.split(`
`);
  for (let i = 0;i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const taskMatch = trimmed.match(TASK_RE);
    if (taskMatch) {
      const taskNumber = Number(taskMatch[1]);
      const name = taskMatch[2].trim();
      const status = normalizeStatus(taskMatch[3]);
      let file;
      let verify;
      for (let j = i + 1;j < lines.length; j++) {
        const nextTrimmed = lines[j].trim();
        if (/^###?\s/.test(nextTrimmed))
          break;
        const fileMatch = nextTrimmed.match(FILE_LINE_RE);
        if (fileMatch) {
          file = fileMatch[1].trim();
          continue;
        }
        const verifyMatch = nextTrimmed.match(VERIFY_LINE_RE);
        if (verifyMatch) {
          verify = verifyMatch[1].trim();
        }
      }
      tasks.push({ name, status, taskNumber, file, verify });
      continue;
    }
    const checkMatch = trimmed.match(CHECKBOX_RE);
    if (checkMatch) {
      const checked = checkMatch[1] !== " ";
      const name = checkMatch[2].trim();
      tasks.push({ name, status: checked ? "done" : "pending" });
    }
  }
  return tasks;
}
function parseVerifyField(verify) {
  const colonIdx = verify.lastIndexOf(":");
  if (colonIdx <= 0)
    return null;
  const file = verify.slice(0, colonIdx).trim();
  const testName = verify.slice(colonIdx + 1).trim();
  if (!file || !testName)
    return null;
  return { file, testName };
}
function getLatestPlanPath() {
  try {
    const planDir = join4(process.cwd(), ".claude", "plans");
    if (!existsSync5(planDir))
      return null;
    const files = readdirSync(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync(join4(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return null;
    return join4(planDir, files[0].name);
  } catch {
    return null;
  }
}
function getActivePlan() {
  const path = getLatestPlanPath();
  if (!path)
    return null;
  let mtime = null;
  try {
    mtime = statSync(path).mtimeMs;
    if (_planCache && _planCachePath === path && _planCacheMtime === mtime)
      return _planCache;
  } catch {}
  try {
    const content = readFileSync4(path, "utf-8");
    const tasks = parsePlanTasks(content);
    if (tasks.length === 0)
      return null;
    _planCache = { tasks, path };
    _planCachePath = path;
    _planCacheMtime = mtime;
    return _planCache;
  } catch {
    return null;
  }
}
var TASK_RE, CHECKBOX_RE, FILE_LINE_RE, VERIFY_LINE_RE, _planCache = null, _planCachePath = null, _planCacheMtime = null;
var init_plan_status = __esm(() => {
  TASK_RE = /^###\s+Task\s+(\d+)[\s:\-\u2013\u2014]+(.+?)(?:\s*\[([^\]]+)\])?\s*$/i;
  CHECKBOX_RE = /^-\s+\[([ xX])\]\s*(.+)$/;
  FILE_LINE_RE = /^\s*-\s*\*\*File\*\*:\s*(.+)$/;
  VERIFY_LINE_RE = /^\s*-\s*\*\*Verify\*\*:\s*(.+)$/;
});

// src/state/session-state.ts
import { existsSync as existsSync6, readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
function setStateSessionScope(sessionId) {
  if (!/^[\w-]+$/.test(sessionId))
    return;
  _sessionScope2 = sessionId;
}
function filePath() {
  const file = _sessionScope2 ? `session-state-${_sessionScope2}.json` : FILE;
  return join5(process.cwd(), STATE_DIR2, file);
}
function defaultState() {
  return {
    last_commit_at: new Date().toISOString(),
    test_passed_at: null,
    test_command: null,
    review_completed_at: null,
    ran_gates: {},
    changed_file_paths: [],
    review_iteration: 0,
    review_score_history: [],
    review_stage_scores: {},
    plan_eval_iteration: 0,
    plan_eval_score_history: [],
    plan_selfcheck_blocked_at: null,
    disabled_gates: [],
    task_verify_results: {},
    gate_failure_counts: {}
  };
}
function readSessionState() {
  if (_cache4)
    return _cache4;
  try {
    const path = filePath();
    if (!existsSync6(path)) {
      _cache4 = defaultState();
      return _cache4;
    }
    const raw = JSON.parse(readFileSync5(path, "utf-8"));
    if (!Array.isArray(raw.review_score_history) && typeof raw.review_last_aggregate === "number" && raw.review_last_aggregate > 0) {
      raw.review_score_history = [raw.review_last_aggregate];
    }
    if (!Array.isArray(raw.plan_eval_score_history) && typeof raw.plan_eval_last_aggregate === "number" && raw.plan_eval_last_aggregate > 0) {
      raw.plan_eval_score_history = [raw.plan_eval_last_aggregate];
    }
    const state = { ...defaultState(), ...raw };
    if (state.review_stage_scores && (typeof state.review_stage_scores !== "object" || Array.isArray(state.review_stage_scores))) {
      state.review_stage_scores = {};
    }
    _cache4 = state;
    return state;
  } catch {
    _cache4 = defaultState();
    return _cache4;
  }
}
function writeState(state) {
  _cache4 = state;
  _dirty2 = true;
}
function flush2() {
  if (!_dirty2 || !_cache4)
    return;
  try {
    atomicWriteJson(filePath(), _cache4);
  } catch (e) {
    if (e instanceof Error)
      process.stderr.write(`[qult] state write error: ${e.message}
`);
  }
  _dirty2 = false;
}
function getGatedExtensions() {
  const gates = loadGates();
  if (!gates?.on_write)
    return new Set;
  const exts = new Set;
  for (const gate of Object.values(gates.on_write)) {
    if (gate.extensions && gate.extensions.length > 0) {
      for (const ext of gate.extensions)
        exts.add(ext);
    } else {
      for (const [pattern, extensions] of TOOL_EXTS) {
        if (pattern.test(gate.command)) {
          for (const ext of extensions)
            exts.add(ext);
        }
      }
    }
  }
  return exts;
}
function recordChangedFile(filePath2) {
  const state = readSessionState();
  if (!state.changed_file_paths)
    state.changed_file_paths = [];
  if (!state.changed_file_paths.includes(filePath2)) {
    state.changed_file_paths.push(filePath2);
  }
  writeState(state);
}
function isReviewRequired() {
  if (getActivePlan() !== null)
    return true;
  const state = readSessionState();
  const changedCount = state.changed_file_paths?.length ?? 0;
  if (changedCount >= loadConfig().review.required_changed_files)
    return true;
  return false;
}
function readLastTestPass() {
  const state = readSessionState();
  if (!state.test_passed_at)
    return null;
  return { passed_at: state.test_passed_at, command: state.test_command ?? "" };
}
function recordTestPass(command) {
  const state = readSessionState();
  state.test_passed_at = new Date().toISOString();
  state.test_command = command;
  writeState(state);
}
function readLastReview() {
  const state = readSessionState();
  if (!state.review_completed_at)
    return null;
  return { reviewed_at: state.review_completed_at };
}
function recordReview() {
  const state = readSessionState();
  state.review_completed_at = new Date().toISOString();
  writeState(state);
}
function shouldSkipGate(gateName, sessionId) {
  const state = readSessionState();
  const entry = state.ran_gates[gateName];
  if (!entry)
    return false;
  return entry.session_id === sessionId;
}
function markGateRan(gateName, sessionId) {
  const state = readSessionState();
  state.ran_gates[gateName] = {
    session_id: sessionId,
    ran_at: new Date().toISOString()
  };
  writeState(state);
}
function clearOnCommit() {
  const state = readSessionState();
  state.last_commit_at = new Date().toISOString();
  state.test_passed_at = null;
  state.test_command = null;
  state.review_completed_at = null;
  state.ran_gates = {};
  state.changed_file_paths = [];
  state.review_iteration = 0;
  state.review_score_history = [];
  state.review_stage_scores = {};
  state.plan_eval_iteration = 0;
  state.plan_eval_score_history = [];
  state.plan_selfcheck_blocked_at = null;
  state.task_verify_results = {};
  state.gate_failure_counts = {};
  writeState(state);
}
function getReviewIteration() {
  return readSessionState().review_iteration ?? 0;
}
function recordReviewIteration(aggregate) {
  const state = readSessionState();
  state.review_iteration = (state.review_iteration ?? 0) + 1;
  state.review_score_history.push(aggregate);
  writeState(state);
}
function getReviewScoreHistory() {
  return readSessionState().review_score_history;
}
function resetReviewIteration() {
  const state = readSessionState();
  state.review_iteration = 0;
  state.review_score_history = [];
  writeState(state);
}
function recordStageScores(stageName, scores) {
  const state = readSessionState();
  if (!state.review_stage_scores)
    state.review_stage_scores = {};
  state.review_stage_scores[stageName] = scores;
  writeState(state);
}
function getStageScores() {
  return readSessionState().review_stage_scores ?? {};
}
function clearStageScores() {
  const state = readSessionState();
  state.review_stage_scores = {};
  writeState(state);
}
function getPlanEvalIteration() {
  return readSessionState().plan_eval_iteration ?? 0;
}
function recordPlanEvalIteration(aggregate) {
  const state = readSessionState();
  state.plan_eval_iteration = (state.plan_eval_iteration ?? 0) + 1;
  state.plan_eval_score_history.push(aggregate);
  writeState(state);
}
function getPlanEvalScoreHistory() {
  return readSessionState().plan_eval_score_history;
}
function resetPlanEvalIteration() {
  const state = readSessionState();
  state.plan_eval_iteration = 0;
  state.plan_eval_score_history = [];
  writeState(state);
}
function recordTaskVerifyResult(taskKey, passed) {
  const state = readSessionState();
  if (!state.task_verify_results)
    state.task_verify_results = {};
  state.task_verify_results[taskKey] = { passed, ran_at: new Date().toISOString() };
  writeState(state);
}
function readTaskVerifyResult(taskKey) {
  const state = readSessionState();
  return state.task_verify_results?.[taskKey] ?? null;
}
function incrementGateFailure(file, gateName) {
  const state = readSessionState();
  if (!state.gate_failure_counts)
    state.gate_failure_counts = {};
  const key = `${file}:${gateName}`;
  const count = (state.gate_failure_counts[key] ?? 0) + 1;
  state.gate_failure_counts[key] = count;
  writeState(state);
  return count;
}
function resetGateFailure(file, gateName) {
  const state = readSessionState();
  if (!state.gate_failure_counts)
    return;
  const key = `${file}:${gateName}`;
  if (key in state.gate_failure_counts) {
    delete state.gate_failure_counts[key];
    writeState(state);
  }
}
function isGateDisabled(gateName) {
  const state = readSessionState();
  return (state.disabled_gates ?? []).includes(gateName);
}
function wasPlanSelfcheckBlocked() {
  return readSessionState().plan_selfcheck_blocked_at != null;
}
function recordPlanSelfcheckBlocked() {
  const state = readSessionState();
  state.plan_selfcheck_blocked_at = new Date().toISOString();
  writeState(state);
}
var STATE_DIR2 = ".qult/.state", FILE = "session-state.json", _cache4 = null, _dirty2 = false, _sessionScope2 = null, TOOL_EXTS;
var init_session_state = __esm(() => {
  init_config();
  init_load();
  init_atomic_write();
  init_plan_status();
  TOOL_EXTS = [
    [/\bbiome\b/, [".js", ".jsx", ".ts", ".tsx", ".css", ".graphql"]],
    [/\beslint\b/, [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]],
    [/\btsc\b/, [".ts", ".tsx", ".mts", ".cts"]],
    [/\bpyright\b/, [".py", ".pyi"]],
    [/\bmypy\b/, [".py", ".pyi"]],
    [/\bruff\b/, [".py", ".pyi"]],
    [/\bgo\s+(vet|build)\b/, [".go"]],
    [/\bcargo\s+(clippy|check)\b/, [".rs"]]
  ];
});

// src/state/flush.ts
function flushAll() {
  try {
    flush2();
  } catch {}
  try {
    flush();
  } catch {}
}
var init_flush = __esm(() => {
  init_config();
  init_load();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
});

// src/state/cleanup.ts
import { readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join6 } from "node:path";
function cleanupStaleScopedFiles(stateDir) {
  try {
    const now = Date.now();
    for (const file of readdirSync2(stateDir)) {
      if (!SCOPED_FILE_RE.test(file))
        continue;
      const filePath2 = join6(stateDir, file);
      const age = now - statSync2(filePath2).mtimeMs;
      if (age > STALE_MS) {
        unlinkSync2(filePath2);
      }
    }
  } catch {}
}
var STALE_MS, SCOPED_FILE_RE;
var init_cleanup = __esm(() => {
  STALE_MS = 24 * 60 * 60 * 1000;
  SCOPED_FILE_RE = /^(session-state|pending-fixes)-.+\.json$/;
});

// src/hooks/lazy-init.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join7 } from "node:path";
function markSessionStartCompleted() {
  _sessionStartCompleted = true;
}
function lazyInit() {
  if (_sessionStartCompleted)
    return;
  if (_initialized)
    return;
  _initialized = true;
  try {
    const stateDir = join7(process.cwd(), ".qult", ".state");
    if (!existsSync7(stateDir)) {
      mkdirSync2(stateDir, { recursive: true });
    }
    cleanupStaleScopedFiles(stateDir);
    writePendingFixes([]);
  } catch {}
}
var _initialized = false, _sessionStartCompleted = false;
var init_lazy_init = __esm(() => {
  init_cleanup();
  init_pending_fixes();
});

// src/hooks/respond.ts
function setCurrentEvent(event) {
  _currentEvent = event;
}
function compactStateSummary() {
  try {
    const state = readSessionState();
    const fixes = readPendingFixes();
    const parts = [];
    if (fixes.length > 0)
      parts.push(`${fixes.length} pending fix(es)`);
    parts.push(state.test_passed_at ? "tests: PASS" : "tests: NOT PASSED");
    parts.push(state.review_completed_at ? "review: DONE" : "review: NOT DONE");
    const changed = state.changed_file_paths?.length ?? 0;
    if (changed > 0)
      parts.push(`${changed} file(s) changed`);
    const disabled = state.disabled_gates ?? [];
    if (disabled.length > 0)
      parts.push(`disabled: ${disabled.join(",")}`);
    return `
[qult state] ${parts.join(" | ")}`;
  } catch {
    return "";
  }
}
function deny(reason) {
  try {
    flushAll();
  } catch {}
  process.stderr.write(reason + compactStateSummary());
  process.exit(2);
}
function block(reason) {
  try {
    flushAll();
  } catch {}
  process.stderr.write(reason + compactStateSummary());
  process.exit(2);
}
var _currentEvent = "unknown";
var init_respond = __esm(() => {
  init_flush();
  init_pending_fixes();
  init_session_state();
});

// src/gates/runner.ts
import { exec, execSync } from "node:child_process";
function smartTruncate(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  const headSize = Math.floor(maxChars * 0.75);
  const tailSize = maxChars - headSize;
  const truncated = text.length - headSize - tailSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  return `${head}
... (${truncated} chars truncated) ...
${tail}`;
}
function runGateAsync(name, gate, file) {
  const config = loadConfig();
  const command = file ? gate.command.replace("{file}", file) : gate.command;
  const timeout = gate.timeout ?? config.gates.default_timeout;
  const maxChars = config.gates.output_max_chars;
  const start = Date.now();
  return new Promise((resolve) => {
    exec(command, {
      cwd: process.cwd(),
      timeout,
      env: {
        ...process.env,
        PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`
      },
      encoding: "utf-8"
    }, (err, stdout, stderr) => {
      const duration_ms = Date.now() - start;
      if (err) {
        const output = smartTruncate((stdout ?? "") + (stderr ?? ""), maxChars) || `Exit code ${err.code ?? 1}`;
        resolve({ name, passed: false, output, duration_ms });
      } else {
        const output = smartTruncate(stdout ?? "", maxChars);
        resolve({ name, passed: true, output, duration_ms });
      }
    });
  });
}
function runGate(name, gate, file) {
  const config = loadConfig();
  const command = file ? gate.command.replace("{file}", file) : gate.command;
  const timeout = gate.timeout ?? config.gates.default_timeout;
  const maxChars = config.gates.output_max_chars;
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: process.cwd(),
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`
      },
      encoding: "utf-8"
    });
    const output = smartTruncate(stdout ?? "", maxChars);
    return { name, passed: true, output, duration_ms: Date.now() - start };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const e = err != null && typeof err === "object" ? err : {};
    const stdout = "stdout" in e && typeof e.stdout === "string" ? e.stdout : "";
    const stderr = "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
    const status = "status" in e && typeof e.status === "number" ? e.status : 1;
    const output = smartTruncate(stdout + stderr, maxChars) || `Exit code ${status}`;
    return {
      name,
      passed: false,
      output,
      duration_ms
    };
  }
}
var init_runner = __esm(() => {
  init_config();
});

// src/hooks/post-tool.ts
var exports_post_tool = {};
__export(exports_post_tool, {
  default: () => postTool
});
import { existsSync as existsSync8, readFileSync as readFileSync6 } from "node:fs";
import { extname, join as join8, resolve } from "node:path";
async function postTool(ev) {
  const tool = ev.tool_name;
  if (!tool)
    return;
  if (tool === "Edit" || tool === "Write") {
    await handleEditWrite(ev);
  } else if (tool === "Bash") {
    handleBash(ev);
  }
}
async function handleEditWrite(ev) {
  const rawFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
  if (!rawFile)
    return;
  const file = resolve(rawFile);
  const qultDir = resolve(process.cwd(), ".qult");
  if (file.startsWith(`${qultDir}/`) || file === qultDir)
    return;
  const gates = loadGates();
  if (!gates?.on_write)
    return;
  const fileExt = extname(file).toLowerCase();
  const gatedExts = getGatedExtensions();
  const sessionId = ev.session_id;
  const gateEntries = [];
  for (const [name, gate] of Object.entries(gates.on_write)) {
    if (isGateDisabled(name))
      continue;
    if (gate.run_once_per_batch && sessionId && shouldSkipGate(name, sessionId))
      continue;
    const hasPlaceholder = gate.command.includes("{file}");
    if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt))
      continue;
    gateEntries.push({ name, gate, fileArg: hasPlaceholder ? file : undefined });
  }
  const results = await Promise.allSettled(gateEntries.map((entry) => runGateAsync(entry.name, entry.gate, entry.fileArg)));
  const newFixes = [];
  for (let i = 0;i < results.length; i++) {
    const settled = results[i];
    const entry = gateEntries[i];
    try {
      if (settled.status === "fulfilled") {
        if (entry.gate.run_once_per_batch && sessionId) {
          markGateRan(entry.name, sessionId);
        }
        if (!settled.value.passed) {
          newFixes.push({ file, errors: [settled.value.output], gate: entry.name });
          try {
            const count = incrementGateFailure(file, entry.name);
            if (count >= 3) {
              process.stderr.write(`[qult] 3-Strike: ${file} failed ${entry.name} ${count} times. Investigate root cause before continuing.
`);
            }
          } catch {}
        } else {
          try {
            resetGateFailure(file, entry.name);
          } catch {}
        }
      }
    } catch {}
  }
  try {
    const importFixes = detectHallucinatedImports(file);
    newFixes.push(...importFixes);
  } catch {}
  if (newFixes.length > 0) {
    addPendingFixes(file, newFixes);
  } else {
    clearPendingFixesForFile(file);
  }
  try {
    if (gateEntries.length > 0 || newFixes.some((f) => f.gate === "import-check")) {
      const gateParts = gateEntries.map((entry, i) => {
        const settled = results[i];
        if (settled.status === "fulfilled") {
          return `${entry.name} ${settled.value.passed ? "PASS" : "FAIL"}`;
        }
        return `${entry.name} ERROR`;
      });
      const importFixCount = newFixes.filter((f) => f.gate === "import-check").length;
      if (importFixCount > 0)
        gateParts.push(`import-check FAIL`);
      const totalFixes = readPendingFixes().length;
      const fixSuffix = totalFixes > 0 ? ` | ${totalFixes} pending fix(es)` : "";
      process.stderr.write(`[qult] gates: ${gateParts.join(", ")}${fixSuffix}
`);
    }
  } catch {}
  try {
    recordChangedFile(file);
  } catch {}
}
function detectHallucinatedImports(file) {
  if (isGateDisabled("import-check"))
    return [];
  const ext = extname(file).toLowerCase();
  if (!TS_JS_EXTS.has(ext))
    return [];
  if (!existsSync8(file))
    return [];
  const content = readFileSync6(file, "utf-8");
  if (content.length > MAX_IMPORT_CHECK_SIZE)
    return [];
  const cwd = process.cwd();
  const missingPkgs = [];
  let builtins;
  try {
    builtins = new Set(__require("node:module").builtinModules);
  } catch {
    builtins = FALLBACK_BUILTINS;
  }
  for (const line of content.split(`
`)) {
    if (line.trimStart().startsWith("//"))
      continue;
    const match = line.match(IMPORT_LINE_RE);
    if (!match)
      continue;
    const specifier = match[1];
    const pkgName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (pkgName.startsWith("node:") || builtins.has(pkgName))
      continue;
    if (pkgName.includes(".."))
      continue;
    if (!existsSync8(join8(cwd, "node_modules", pkgName))) {
      missingPkgs.push(pkgName);
    }
  }
  if (missingPkgs.length === 0)
    return [];
  const unique = [...new Set(missingPkgs)];
  return [
    {
      file,
      errors: unique.map((pkg) => `Hallucinated import: package "${pkg.slice(0, 128)}" not found in node_modules`),
      gate: "import-check"
    }
  ];
}
function handleBash(ev) {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
  if (!command)
    return;
  if (GIT_COMMIT_RE.test(command)) {
    onGitCommit();
    return;
  }
  if (LINT_FIX_RE.test(command)) {
    onLintFix();
  }
  if (isTestCommand(command)) {
    onTestCommand(ev, command);
  }
}
function onGitCommit() {
  clearOnCommit();
  const gates = loadGates();
  if (!gates?.on_commit)
    return;
  for (const [name, gate] of Object.entries(gates.on_commit)) {
    try {
      if (isGateDisabled(name))
        continue;
      runGate(name, gate);
    } catch {}
  }
}
function onLintFix() {
  try {
    const fixes = readPendingFixes();
    if (fixes.length === 0)
      return;
    const gates = loadGates();
    if (!gates?.on_write)
      return;
    const remaining = fixes.filter((fix) => {
      for (const [name, gate] of Object.entries(gates.on_write)) {
        if (isGateDisabled(name))
          continue;
        const hasPlaceholder = gate.command.includes("{file}");
        if (!hasPlaceholder)
          continue;
        try {
          const result = runGate(name, gate, fix.file);
          if (!result.passed)
            return true;
        } catch {
          return true;
        }
      }
      return false;
    });
    writePendingFixes(remaining);
  } catch {}
}
function isTestCommand(command) {
  const gates = loadGates();
  if (gates?.on_commit) {
    for (const gate of Object.values(gates.on_commit)) {
      if (command.includes(gate.command))
        return true;
    }
    return false;
  }
  return TEST_CMD_RE.test(command);
}
function onTestCommand(ev, command) {
  const output = getToolOutput(ev);
  const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i);
  const isPass = exitCodeMatch ? Number(exitCodeMatch[1]) === 0 : false;
  if (isPass) {
    recordTestPass(command);
  }
}
function getToolOutput(ev) {
  if (ev.tool_response != null && typeof ev.tool_response === "object") {
    const resp = ev.tool_response;
    const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
    const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
    return (stdout + stderr).trim();
  }
  if (typeof ev.tool_output === "string")
    return ev.tool_output;
  return "";
}
var TS_JS_EXTS, IMPORT_LINE_RE, MAX_IMPORT_CHECK_SIZE = 500000, FALLBACK_BUILTINS, GIT_COMMIT_RE, LINT_FIX_RE, TEST_CMD_RE;
var init_post_tool = __esm(() => {
  init_load();
  init_runner();
  init_pending_fixes();
  init_session_state();
  TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  IMPORT_LINE_RE = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"'./][^"']*)["']/;
  FALLBACK_BUILTINS = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "test",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib"
  ]);
  GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
  LINT_FIX_RE = /\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/;
  TEST_CMD_RE = /\b(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;
});

// src/hooks/pre-tool.ts
var exports_pre_tool = {};
__export(exports_pre_tool, {
  default: () => preTool
});
import { resolve as resolve2 } from "node:path";
async function preTool(ev) {
  const tool = ev.tool_name;
  if (tool === "ExitPlanMode") {
    checkExitPlanMode();
  } else if (tool === "Edit" || tool === "Write") {
    checkEditWrite(ev);
  } else if (tool === "Bash") {
    checkBash(ev);
  }
}
function checkExitPlanMode() {
  if (wasPlanSelfcheckBlocked())
    return;
  recordPlanSelfcheckBlocked();
  deny("Before finalizing the plan, review the entire session from start to now for omissions. " + "Check: missing files, untested edge cases, migration concerns, documentation gaps, " + "dependency changes, and anything discussed but not included in the plan. " + "After your review, call ExitPlanMode again.");
}
function checkEditWrite(ev) {
  const targetFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
  if (!targetFile)
    return;
  const resolvedTarget = resolve2(targetFile);
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const isFixingPendingFile = fixes.some((f) => resolve2(f.file) === resolvedTarget);
    if (!isFixingPendingFile) {
      const fileList = fixes.map((f) => {
        const totalErrors = f.errors.length;
        const shown = f.errors.slice(0, 3).map((e) => `    ${e.slice(0, 200)}`);
        const suffix = totalErrors > 3 ? `
    ... and ${totalErrors - 3} more error(s)` : "";
        return `  ${f.file} (${totalErrors} error(s)):
${shown.join(`
`)}${suffix}`;
      }).join(`
`);
      deny(`Fix existing errors before editing other files:
${fileList}`);
    }
  }
  try {
    checkTddOrder(resolvedTarget);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("process.exit"))
      throw e;
  }
  try {
    suggestTaskCreate(resolvedTarget);
  } catch {}
}
function suggestTaskCreate(resolvedTarget) {
  const plan = getActivePlan();
  if (!plan)
    return;
  const cwd = process.cwd();
  const changed = readSessionState().changed_file_paths ?? [];
  if (changed.includes(resolvedTarget))
    return;
  for (const task of plan.tasks) {
    if (!task.file)
      continue;
    const taskFile = resolve2(cwd, task.file);
    if (resolvedTarget === taskFile) {
      process.stderr.write(`[qult] Plan task detected for ${task.file}. Use TaskCreate to track progress and enable Verify test execution.
`);
      return;
    }
  }
}
function checkTddOrder(resolvedTarget) {
  const plan = getActivePlan();
  if (!plan)
    return;
  const cwd = process.cwd();
  const changed = readSessionState().changed_file_paths ?? [];
  for (const task of plan.tasks) {
    if (!task.file || !task.verify)
      continue;
    const parsed = parseVerifyField(task.verify);
    if (!parsed)
      continue;
    const implFile = resolve2(cwd, task.file);
    if (resolvedTarget !== implFile)
      continue;
    const testFile = resolve2(cwd, parsed.file);
    if (resolvedTarget === testFile)
      return;
    if (!changed.includes(testFile)) {
      deny(`TDD: write the test first. Edit ${parsed.file} before ${task.file}.`);
    }
    const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;
    const verifyResult = readTaskVerifyResult(taskKey);
    if (verifyResult?.passed === true) {
      deny(`TDD: test for ${taskKey} already passes before implementation. Write a failing test first (RED), then implement (GREEN).`);
    }
    return;
  }
}
function checkBash(ev) {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
  if (!command)
    return;
  if (!GIT_COMMIT_RE2.test(command))
    return;
  const gates = loadGates();
  if (gates?.on_commit && Object.keys(gates.on_commit).length > 0) {
    const allCommitGatesDisabled = Object.keys(gates.on_commit).every((g) => isGateDisabled(g));
    if (!allCommitGatesDisabled && !readLastTestPass()) {
      deny("Run tests before committing. No test pass recorded since last commit.");
    }
  }
  if (!readLastReview()) {
    if (isReviewRequired() && !isGateDisabled("review")) {
      deny("Run /qult:review before committing. Independent review is required.");
    }
  }
}
var GIT_COMMIT_RE2;
var init_pre_tool = __esm(() => {
  init_load();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_respond();
  GIT_COMMIT_RE2 = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
});

// src/hooks/stop.ts
var exports_stop = {};
__export(exports_stop, {
  default: () => stop
});
async function stop(ev) {
  if (ev.stop_hook_active)
    return;
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const fileList = fixes.map((f) => `  ${f.file}`).join(`
`);
    block(`Pending lint/type errors remain. Fix these before completing:
${fileList}`);
  }
  const plan = getActivePlan();
  if (plan) {
    const incomplete = plan.tasks.filter((t) => t.status !== "done");
    if (incomplete.length > 0) {
      const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join(`
`);
      block(`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:
${taskList}
Plan: ${plan.path}`);
    }
    const doneTasks = plan.tasks.filter((t) => t.status === "done" && t.verify?.includes(":"));
    const unverified = doneTasks.filter((t) => {
      const key = t.taskNumber != null ? `Task ${t.taskNumber}` : t.name;
      return readTaskVerifyResult(key) === null;
    });
    if (unverified.length > 0) {
      const list = unverified.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name}`).join(`
`);
      block(`${unverified.length} plan task(s) have Verify fields but no test result recorded:
${list}
Use TaskCreate to track tasks so TaskCompleted triggers Verify test execution.`);
    }
  }
  if (!readLastReview()) {
    if (isReviewRequired() && !isGateDisabled("review")) {
      block("Run /qult:review before finishing. Independent review is required.");
    }
  }
}
var init_stop = __esm(() => {
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_respond();
});

// src/hooks/subagent-stop/trend-analysis.ts
function detectTrend(history) {
  if (history.length < 2)
    return "stagnant";
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  if (curr > prev)
    return "improving";
  if (curr < prev)
    return "regressing";
  return "stagnant";
}
function findWeakestDimension(dimensions) {
  let weakest = null;
  for (const [name, score] of Object.entries(dimensions)) {
    if (!weakest || score < weakest.score) {
      weakest = { name, score };
    }
  }
  return weakest;
}

// src/hooks/subagent-stop/message-builders.ts
function buildReviewBlockMessage(scores, history, aggregate, threshold, iterCount, maxIter) {
  const trend = detectTrend(history);
  const weakest = findWeakestDimension({
    Correctness: scores.correctness,
    Design: scores.design,
    Security: scores.security
  });
  const header = `Review: PASS but aggregate score ${aggregate}/15 is below threshold ${threshold}/15. Iteration ${iterCount}/${maxIter}.`;
  if (!weakest) {
    return `${header} Fix weak areas and run /qult:review again.`;
  }
  if (trend === "improving" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score improved ${prev}→${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
  }
  if (trend === "regressing" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score regressed ${prev}→${aggregate}. Last changes introduced new issues — revert recent ${weakest.name.toLowerCase()}-related changes and take a minimal approach.`;
  }
  if (history.length >= 2) {
    return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working — try a fundamentally different structure.`;
  }
  return `${header} Weakest dimension: ${weakest.name} (${weakest.score}/5). Fix this area first.`;
}
function buildPlanEvalBlockMessage(dimensions, history, aggregate, threshold, iterCount, maxIter) {
  const trend = detectTrend(history);
  const weakest = findWeakestDimension(dimensions);
  const header = `Plan: PASS but aggregate score ${aggregate}/15 is below threshold ${threshold}/15. Iteration ${iterCount}/${maxIter}.`;
  if (!weakest) {
    return `${header} Fix weak areas and re-evaluate.`;
  }
  if (trend === "improving" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score improved ${prev}→${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
  }
  if (trend === "regressing" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score regressed ${prev}→${aggregate}. Last revision made the plan worse — revert recent changes to ${weakest.name.toLowerCase()} and try a different approach.`;
  }
  if (history.length >= 2) {
    return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working — restructure the plan differently.`;
  }
  return `${header} Weakest dimension: ${weakest.name} (${weakest.score}/5). Fix this area first.`;
}
var init_message_builders = () => {};

// src/hooks/subagent-stop/plan-validators.ts
function extractTasksContent(content) {
  const tasksIdx = content.search(/^## Tasks/m);
  if (tasksIdx < 0)
    return null;
  const tasksSection = content.slice(tasksIdx);
  const firstNewline = tasksSection.indexOf(`
`);
  if (firstNewline < 0)
    return tasksSection;
  const afterHeader = tasksSection.slice(firstNewline);
  const nextSectionIdx = afterHeader.search(/^## /m);
  if (nextSectionIdx < 0)
    return tasksSection;
  return tasksSection.slice(0, firstNewline + nextSectionIdx);
}
function validatePlanStructure(content) {
  const errors = [];
  if (!/^## Context/m.test(content)) {
    errors.push("Missing required section: ## Context");
  }
  if (!/^## Tasks/m.test(content)) {
    errors.push("Missing required section: ## Tasks");
    return errors;
  }
  const taskCount = (content.match(TASK_HEADER_G) ?? []).length;
  if (taskCount === 0) {
    errors.push("## Tasks section has no task entries (### Task N:)");
  } else if (taskCount > 15) {
    errors.push(`Too many tasks (${taskCount}). Maximum is 15. Split into smaller plans.`);
  }
  const tasksContent = extractTasksContent(content);
  if (!tasksContent)
    return errors;
  const taskHeaders = [...tasksContent.matchAll(TASK_BLOCK_RE)];
  for (let i = 0;i < taskHeaders.length; i++) {
    const start = taskHeaders[i].index;
    const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1].index : tasksContent.length;
    const block2 = tasksContent.slice(start, end);
    const taskNum = taskHeaders[i][1];
    for (const [field, re] of Object.entries(FIELD_RES)) {
      if (!re.test(block2)) {
        errors.push(`Task ${taskNum}: missing required field **${field}**`);
      }
    }
  }
  if (!/^## Success Criteria/m.test(content)) {
    errors.push("Missing required section: ## Success Criteria");
  } else {
    const scStart = content.search(/^## Success Criteria/m);
    const scContent = content.slice(scStart);
    if (!/`.+`/.test(scContent)) {
      errors.push("Success Criteria must contain at least one backtick-wrapped command");
    }
  }
  return errors;
}
function validatePlanHeuristics(content) {
  const warnings = [];
  const tasksContent = extractTasksContent(content);
  if (!tasksContent)
    return warnings;
  const taskHeaders = [...tasksContent.matchAll(TASK_BLOCK_RE)];
  const taskBlocks = [];
  for (let i = 0;i < taskHeaders.length; i++) {
    const start = taskHeaders[i].index;
    const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1].index : tasksContent.length;
    taskBlocks.push({ num: taskHeaders[i][1], block: tasksContent.slice(start, end) });
  }
  const registryFiles = loadConfig().plan_eval.registry_files;
  const allFiles = [];
  for (const { block: block2 } of taskBlocks) {
    const fileMatch = block2.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
    if (fileMatch)
      allFiles.push(fileMatch[1]);
  }
  const allFilesJoined = allFiles.join(" ");
  for (const { num, block: block2 } of taskBlocks) {
    const changeMatch = block2.match(/^\s*-\s*\*\*Change\*\*:\s*(.+)$/m);
    if (changeMatch) {
      const changeValue = changeMatch[1].trim();
      if (VAGUE_VERBS_RE.test(changeValue)) {
        const words = changeValue.split(/\s+/);
        if (words.length < 8) {
          warnings.push(`Task ${num}: Change field is too vague ("${changeValue}"). Be specific about what to do.`);
        }
      }
    }
    const verifyMatch = block2.match(/^\s*-\s*\*\*Verify\*\*:\s*(.+)$/m);
    if (verifyMatch) {
      const verifyValue = verifyMatch[1].trim();
      if (!VERIFY_FORMAT_RE.test(verifyValue)) {
        warnings.push(`Task ${num}: Verify field should reference a test file:function (got "${verifyValue}")`);
      }
    }
    const fileMatch = block2.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
    if (fileMatch && registryFiles.length > 0) {
      const fileValue = fileMatch[1];
      for (const registry of registryFiles) {
        if (fileValue.includes(registry)) {
          const hasConsumer = allFilesJoined.split(/[\s,]+/).some((f) => !f.includes(registry) && (f.includes("test") || f.includes("spec") || f.includes("doctor") || f.includes("hook") || f.includes("cli")));
          if (!hasConsumer) {
            warnings.push(`Task ${num}: File references registry file "${registry}" but no consumer file (test, hook, etc.) found in plan`);
          }
        }
      }
    }
  }
  return warnings;
}
var TASK_HEADER_G, TASK_BLOCK_RE, FIELD_RES, VAGUE_VERBS_RE, VERIFY_FORMAT_RE, PLAN_EVAL_DIMENSIONS;
var init_plan_validators = __esm(() => {
  init_config();
  TASK_HEADER_G = /^### Task \d+[\s:-]/gim;
  TASK_BLOCK_RE = /^### Task (\d+)[\s:-]+.*$/gim;
  FIELD_RES = {
    File: /^\s*-\s*\*\*File\*\*/m,
    Change: /^\s*-\s*\*\*Change\*\*/m,
    Boundary: /^\s*-\s*\*\*Boundary\*\*/m,
    Verify: /^\s*-\s*\*\*Verify\*\*/m
  };
  VAGUE_VERBS_RE = /^(improve|update|fix|refactor|clean\s*up|enhance|optimize|modify|adjust|change)\b/i;
  VERIFY_FORMAT_RE = /\S+\.\w+\s*:\s*\S+|\bTest[A-Z]\w+\b|\btest_\w+\b|[\w/]+\.\w+/;
  PLAN_EVAL_DIMENSIONS = ["Feasibility", "Completeness", "Clarity"];
});

// src/hooks/subagent-stop/score-parsers.ts
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDimensionScore(output, name) {
  const re = new RegExp(`${escapeRegex(name)}[=:]\\s*(\\d+)`, "i");
  const m = re.exec(output);
  if (!m)
    return null;
  const val = Number.parseInt(m[1], 10);
  return val >= 1 && val <= 5 ? val : null;
}
function parseScores(output) {
  const correctness = parseDimensionScore(output, REVIEW_DIMENSIONS[0]);
  const design = parseDimensionScore(output, REVIEW_DIMENSIONS[1]);
  const security = parseDimensionScore(output, REVIEW_DIMENSIONS[2]);
  if (correctness === null || design === null || security === null)
    return null;
  return { correctness, design, security };
}
function parseDimensionScores(output, dimensions) {
  const result = {};
  for (const dim of dimensions) {
    const val = parseDimensionScore(output, dim);
    if (val === null)
      return null;
    result[dim] = val;
  }
  return result;
}
function parseSpecScores(output) {
  const scores = parseDimensionScores(output, SPEC_DIMENSIONS);
  if (!scores)
    return null;
  return { completeness: scores.Completeness, accuracy: scores.Accuracy };
}
function parseQualityScores(output) {
  const scores = parseDimensionScores(output, QUALITY_DIMENSIONS);
  if (!scores)
    return null;
  return { design: scores.Design, maintainability: scores.Maintainability };
}
function parseSecurityScores(output) {
  const scores = parseDimensionScores(output, SECURITY_DIMENSIONS);
  if (!scores)
    return null;
  return { vulnerability: scores.Vulnerability, hardening: scores.Hardening };
}
var REVIEW_DIMENSIONS, SPEC_DIMENSIONS, QUALITY_DIMENSIONS, SECURITY_DIMENSIONS;
var init_score_parsers = __esm(() => {
  REVIEW_DIMENSIONS = ["Correctness", "Design", "Security"];
  SPEC_DIMENSIONS = ["Completeness", "Accuracy"];
  QUALITY_DIMENSIONS = ["Design", "Maintainability"];
  SECURITY_DIMENSIONS = ["Vulnerability", "Hardening"];
});

// src/hooks/subagent-stop/agent-validators.ts
import { existsSync as existsSync9, readdirSync as readdirSync3, readFileSync as readFileSync7, statSync as statSync3 } from "node:fs";
import { join as join9 } from "node:path";
async function subagentStop(ev) {
  if (ev.stop_hook_active)
    return;
  const agentType = ev.agent_type;
  const output = ev.last_assistant_message;
  if (!agentType || !output)
    return;
  const normalized = agentType.replace(/:/g, "-");
  if (normalized === "qult-spec-reviewer") {
    validateStageReviewer(output, SPEC_PASS_RE, SPEC_FAIL_RE, parseSpecScores, "Spec");
  } else if (normalized === "qult-quality-reviewer") {
    validateStageReviewer(output, QUALITY_PASS_RE, QUALITY_FAIL_RE, parseQualityScores, "Quality");
  } else if (normalized === "qult-security-reviewer") {
    validateStageReviewer(output, SECURITY_PASS_RE, SECURITY_FAIL_RE, parseSecurityScores, "Security");
    checkAggregateScore();
  } else if (normalized === "qult-plan-evaluator") {
    validatePlanEvaluator(output);
  } else if (normalized === "Plan") {
    validatePlan();
  }
}
function validatePlan() {
  try {
    const planDir = join9(process.cwd(), ".claude", "plans");
    if (!existsSync9(planDir))
      return;
    const files = readdirSync3(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync3(join9(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return;
    const content = readFileSync7(join9(planDir, files[0].name), "utf-8");
    const structErrors = validatePlanStructure(content);
    if (structErrors.length > 0) {
      block(`Plan structural issues:
${structErrors.map((e) => `  - ${e}`).join(`
`)}`);
    }
    const heuristicWarnings = validatePlanHeuristics(content);
    if (heuristicWarnings.length > 0) {
      block(`Plan quality issues:
${heuristicWarnings.map((w) => `  - ${w}`).join(`
`)}`);
    }
    if (getPlanEvalIteration() === 0) {
      block("Plan has not been evaluated. Run /qult:plan-generator with plan-evaluator, or run the plan-evaluator manually before proceeding.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
}
function validatePlanEvaluator(output) {
  const hasPassed = PLAN_PASS_RE.test(output);
  const hasRevise = PLAN_REVISE_RE.test(output);
  const scores = parseDimensionScores(output, PLAN_EVAL_DIMENSIONS);
  if (!hasPassed && !hasRevise || !scores) {
    block("Plan evaluator output must include: (1) 'Plan: PASS' or 'Plan: REVISE', (2) 'Score: Feasibility=N Completeness=N Clarity=N', and (3) findings or 'No issues found'. Rerun the evaluation.");
  }
  if (hasRevise) {
    block("Plan: REVISE. Fix the issues identified by the evaluator and regenerate the plan.");
  }
  if (hasPassed && scores) {
    const aggregate = Object.values(scores).reduce((sum, v) => sum + v, 0);
    const config = loadConfig();
    const threshold = config.plan_eval.score_threshold;
    const maxIter = config.plan_eval.max_iterations;
    try {
      recordPlanEvalIteration(aggregate);
    } catch {}
    const iterCount = getPlanEvalIteration();
    const history = getPlanEvalScoreHistory();
    if (aggregate < threshold && iterCount < maxIter) {
      block(buildPlanEvalBlockMessage(scores, history, aggregate, threshold, iterCount, maxIter));
    }
  }
  resetPlanEvalIteration();
}
function validateStageReviewer(output, passRe, failRe, scoreParser, stageName) {
  const hasVerdict = passRe.test(output) || failRe.test(output);
  const hasFindings = FINDING_RE.test(output) || NO_ISSUES_RE.test(output);
  const scores = scoreParser(output);
  const hasScore = scores !== null;
  if (!hasVerdict && !hasFindings && !hasScore) {
    block(`${stageName} reviewer output must include: (1) '${stageName}: PASS' or '${stageName}: FAIL', (2) Score line, or (3) findings. Rerun the review.`);
  }
  if (failRe.test(output)) {
    block(`${stageName}: FAIL. Fix the issues found by the ${stageName.toLowerCase()} reviewer and re-run /qult:review.`);
  }
  if (passRe.test(output) && !scores) {
    block(`${stageName}: PASS but no parseable scores found. Output must include 'Score: Dim1=N Dim2=N'. Rerun the review.`);
  }
  if (passRe.test(output) && scores) {
    const scoreEntries = scores;
    try {
      recordStageScores(stageName, scoreEntries);
    } catch {}
    const floor = loadConfig().review.dimension_floor;
    const belowFloor = Object.entries(scoreEntries).filter(([, v]) => typeof v === "number" && v < floor);
    if (belowFloor.length > 0) {
      const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      const dims = belowFloor.map(([name, score]) => `${capitalize(name)} (${score}/5)`).join(", ");
      block(`${stageName}: PASS but ${dims} below minimum ${floor}/5. Fix these dimensions and re-run /qult:review.`);
    }
    checkScoreFindingsConsistency(output, scoreEntries, stageName);
    try {
      extractFindings(output, stageName);
    } catch {}
  }
}
function checkScoreFindingsConsistency(output, scores, stageName) {
  const criticalHighCount = (output.match(/\[(critical|high)\]/gi) ?? []).length;
  const allScoresHigh = Object.values(scores).every((v) => v >= 4);
  const allPerfect = Object.values(scores).every((v) => v === 5);
  const noFindings = !FINDING_RE.test(output);
  if (criticalHighCount > 0 && allScoresHigh) {
    block(`${stageName}: PASS but ${criticalHighCount} critical/high finding(s) with all scores 4+/5. Reconcile findings with scores and rerun the review.`);
  }
  if (allPerfect && noFindings) {
    process.stderr.write(`[qult] ${stageName}: all dimensions 5/5 with no findings — verify review thoroughness.
`);
  }
}
function checkAggregateScore() {
  try {
    const stageScores = getStageScores();
    const stages = ["Spec", "Quality", "Security"];
    if (!stages.every((s) => stageScores[s] && typeof stageScores[s] === "object" && !Array.isArray(stageScores[s])))
      return;
    const allScores = stages.flatMap((s) => Object.values(stageScores[s]).filter((v) => typeof v === "number" && v >= 1 && v <= 5));
    if (allScores.length !== 6)
      return;
    const aggregate = allScores.reduce((sum, v) => sum + v, 0);
    const config = loadConfig();
    const threshold = config.review.score_threshold;
    const maxIter = config.review.max_iterations;
    try {
      const uniqueScores = new Set(allScores);
      if (uniqueScores.size === 1) {
        process.stderr.write(`[qult] Review bias warning: all 6 dimensions scored identically (${allScores[0]}/5). This may indicate template answers.
`);
      } else if (Math.max(...allScores) - Math.min(...allScores) < 2) {
        process.stderr.write(`[qult] Review bias warning: score range is ${Math.min(...allScores)}-${Math.max(...allScores)}/5 (low variance). Consider if reviewers differentiated sufficiently.
`);
      }
    } catch {}
    try {
      recordReviewIteration(aggregate);
    } catch {}
    const iterCount = getReviewIteration();
    const history = getReviewScoreHistory();
    if (aggregate >= threshold) {
      clearStageScores();
      resetReviewIteration();
      try {
        const mergedHistory = persistReviewFindings();
        if (mergedHistory)
          detectRepeatedPatterns(mergedHistory);
      } catch {}
      recordReview();
      return;
    }
    clearStageScores();
    _currentFindings = [];
    if (iterCount < maxIter) {
      const allDims = {};
      for (const stage of stages) {
        for (const [dim, score] of Object.entries(stageScores[stage])) {
          const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
          allDims[capitalize(dim)] = score;
        }
      }
      const weakest = findWeakestDimension(allDims);
      const trend = detectTrend(history);
      let msg = `Review aggregate ${aggregate}/30 below threshold ${threshold}/30. Iteration ${iterCount}/${maxIter}.`;
      if (weakest) {
        if (trend === "improving" && history.length >= 2) {
          const prev = history[history.length - 2];
          msg += ` Score improved ${prev}→${aggregate}. Focus on: ${weakest.name} (${weakest.score}/5).`;
        } else if (trend === "regressing" && history.length >= 2) {
          const prev = history[history.length - 2];
          msg += ` Score regressed ${prev}→${aggregate}. Revert recent ${weakest.name.toLowerCase()}-related changes.`;
        } else {
          msg += ` Weakest: ${weakest.name} (${weakest.score}/5). Fix and re-run /qult:review.`;
        }
      }
      block(msg);
    }
    process.stderr.write(`[qult] Max review iterations (${maxIter}) reached. Aggregate ${aggregate}/30 below threshold ${threshold}/30. Proceeding anyway.
`);
    resetReviewIteration();
    recordReview();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
}
function extractFindings(output, stageName) {
  const findingRe = /\[(critical|high|medium|low)\]\s*(\S+?)(?::\d+)?\s+[—–]\s+(.+?)(?:\n|$)/gi;
  for (const match of output.matchAll(findingRe)) {
    _currentFindings.push({
      file: match[2],
      severity: match[1].toLowerCase(),
      description: match[3].trim().slice(0, 200),
      stage: stageName,
      timestamp: new Date().toISOString()
    });
  }
}
function persistReviewFindings() {
  if (_currentFindings.length === 0)
    return null;
  const historyPath = join9(process.cwd(), ".qult", ".state", FINDINGS_HISTORY_FILE);
  let history = [];
  try {
    if (existsSync9(historyPath)) {
      history = JSON.parse(readFileSync7(historyPath, "utf-8"));
    }
  } catch {
    history = [];
  }
  history.push(..._currentFindings);
  if (history.length > MAX_FINDINGS) {
    history = history.slice(-MAX_FINDINGS);
  }
  atomicWriteJson(historyPath, history);
  _currentFindings = [];
  return history;
}
function detectRepeatedPatterns(history) {
  const fileCounts = {};
  for (const f of history) {
    if (f.severity === "low")
      continue;
    fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
  }
  for (const [file, count] of Object.entries(fileCounts)) {
    if (count >= 3) {
      process.stderr.write(`[qult] Flywheel: ${file} has ${count} review findings. Consider adding a .claude/rules/ entry.
`);
    }
  }
  const descCounts = {};
  for (const f of history) {
    const key = f.description.toLowerCase().replace(/\S+\.\w{1,4}\b/g, "FILE").slice(0, 80);
    descCounts[key] = (descCounts[key] ?? 0) + 1;
  }
  for (const [desc, count] of Object.entries(descCounts)) {
    if (count >= 3) {
      process.stderr.write(`[qult] Flywheel: recurring pattern (${count}x): "${desc}". Consider encoding as a .claude/rules/ rule.
`);
    }
  }
}
function resetFindingsCache() {
  _currentFindings = [];
}
var SEVERITY_PATTERN, FINDING_RE, NO_ISSUES_RE, SPEC_PASS_RE, SPEC_FAIL_RE, QUALITY_PASS_RE, QUALITY_FAIL_RE, SECURITY_PASS_RE, SECURITY_FAIL_RE, PLAN_PASS_RE, PLAN_REVISE_RE, FINDINGS_HISTORY_FILE = "review-findings-history.json", MAX_FINDINGS = 100, _currentFindings;
var init_agent_validators = __esm(() => {
  init_config();
  init_atomic_write();
  init_session_state();
  init_respond();
  init_message_builders();
  init_plan_validators();
  init_score_parsers();
  SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
  FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
  NO_ISSUES_RE = /no issues found/i;
  SPEC_PASS_RE = /^Spec:\s*PASS/im;
  SPEC_FAIL_RE = /^Spec:\s*FAIL/im;
  QUALITY_PASS_RE = /^Quality:\s*PASS/im;
  QUALITY_FAIL_RE = /^Quality:\s*FAIL/im;
  SECURITY_PASS_RE = /^Security:\s*PASS/im;
  SECURITY_FAIL_RE = /^Security:\s*FAIL/im;
  PLAN_PASS_RE = /^Plan:\s*PASS/im;
  PLAN_REVISE_RE = /^Plan:\s*REVISE/im;
  _currentFindings = [];
});

// src/hooks/subagent-stop/index.ts
var exports_subagent_stop = {};
__export(exports_subagent_stop, {
  validatePlanStructure: () => validatePlanStructure,
  validatePlanHeuristics: () => validatePlanHeuristics,
  resetFindingsCache: () => resetFindingsCache,
  parseSpecScores: () => parseSpecScores,
  parseSecurityScores: () => parseSecurityScores,
  parseScores: () => parseScores,
  parseQualityScores: () => parseQualityScores,
  parseDimensionScores: () => parseDimensionScores,
  extractFindings: () => extractFindings,
  default: () => subagentStop,
  buildReviewBlockMessage: () => buildReviewBlockMessage,
  buildPlanEvalBlockMessage: () => buildPlanEvalBlockMessage,
  PLAN_EVAL_DIMENSIONS: () => PLAN_EVAL_DIMENSIONS
});
var init_subagent_stop = __esm(() => {
  init_agent_validators();
  init_message_builders();
  init_plan_validators();
  init_score_parsers();
});

// src/hooks/task-completed.ts
var exports_task_completed = {};
__export(exports_task_completed, {
  default: () => taskCompleted,
  checkVerifyTestQuality: () => checkVerifyTestQuality
});
import { spawnSync } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync8 } from "node:fs";
import { resolve as resolve3 } from "node:path";
async function taskCompleted(ev) {
  const subject = ev.task_subject;
  if (!subject)
    return;
  const plan = getActivePlan();
  if (!plan)
    return;
  const taskNumMatch = subject.match(/\bTask\s+(\d+)\b/i);
  const task = taskNumMatch ? plan.tasks.find((t) => t.taskNumber === Number(taskNumMatch[1])) : plan.tasks.find((t) => t.name === subject);
  if (!task?.verify)
    return;
  const parsed = parseVerifyField(task.verify);
  if (!parsed)
    return;
  if (!SAFE_SHELL_ARG_RE.test(parsed.file) || !SAFE_SHELL_ARG_RE.test(parsed.testName))
    return;
  const argsBuilder = detectTestRunner();
  if (!argsBuilder)
    return;
  const args = argsBuilder(parsed.file, parsed.testName);
  const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;
  try {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: process.cwd(),
      timeout: VERIFY_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`
      }
    });
    const passed = result.status === 0;
    try {
      recordTaskVerifyResult(taskKey, passed);
    } catch {}
  } catch {}
  try {
    checkVerifyTestQuality(parsed.file, parsed.testName, taskKey);
  } catch {}
}
function checkVerifyTestQuality(testFile, _testName, taskKey) {
  const cwd = resolve3(process.cwd());
  const absPath = resolve3(cwd, testFile);
  if (!absPath.startsWith(cwd))
    return;
  if (!existsSync10(absPath))
    return;
  const content = readFileSync8(absPath, "utf-8");
  const codeOnly = content.split(`
`).filter((line) => !line.trimStart().startsWith("//")).join(`
`);
  const assertionCount = (codeOnly.match(ASSERTION_RE) ?? []).length;
  const testCount = (codeOnly.match(/\b(it|test)\s*\(/g) ?? []).length || 1;
  const avgAssertions = assertionCount / testCount;
  if (avgAssertions < MIN_ASSERTIONS) {
    process.stderr.write(`[qult] Test quality warning: ${testFile} has ~${avgAssertions.toFixed(1)} assertions/test (minimum ${MIN_ASSERTIONS}). ${taskKey} may have shallow tests.
`);
  }
}
function detectTestRunner() {
  try {
    const gates = loadGates();
    if (!gates?.on_commit)
      return null;
    for (const gate of Object.values(gates.on_commit)) {
      for (const [pattern, builder] of TEST_RUNNER_RE) {
        if (pattern.test(gate.command)) {
          return builder;
        }
      }
    }
  } catch {}
  return null;
}
var TEST_RUNNER_RE, VERIFY_TIMEOUT = 15000, SAFE_SHELL_ARG_RE, ASSERTION_RE, MIN_ASSERTIONS = 2;
var init_task_completed = __esm(() => {
  init_load();
  init_plan_status();
  init_session_state();
  TEST_RUNNER_RE = [
    [/\bvitest\b/, (f, t) => ["vitest", "run", f, "-t", t]],
    [/\bjest\b/, (f, t) => ["jest", f, "-t", t]],
    [/\bpytest\b/, (f, t) => ["pytest", f, "-k", t]],
    [/\bgo\s+test\b/, (f, _t) => ["go", "test", `./${f}`]],
    [/\bcargo\s+test\b/, (_f, t) => ["cargo", "test", t]],
    [/\bmocha\b/, (f, t) => ["mocha", f, "--grep", t]]
  ];
  SAFE_SHELL_ARG_RE = /^[a-zA-Z0-9_/.@-]+$/;
  ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
});

// src/hooks/session-start.ts
var exports_session_start = {};
__export(exports_session_start, {
  default: () => sessionStart
});
import { existsSync as existsSync11, mkdirSync as mkdirSync3 } from "node:fs";
import { join as join10 } from "node:path";
async function sessionStart(ev) {
  try {
    const stateDir = join10(process.cwd(), ".qult", ".state");
    if (!existsSync11(stateDir)) {
      mkdirSync3(stateDir, { recursive: true });
    }
    cleanupStaleScopedFiles(stateDir);
    if (ev.source === "startup" || ev.source === "clear") {
      writePendingFixes([]);
      try {
        flush();
      } catch {}
    }
    markSessionStartCompleted();
  } catch {}
}
var init_session_start = __esm(() => {
  init_cleanup();
  init_pending_fixes();
  init_lazy_init();
});

// src/hooks/post-compact.ts
var exports_post_compact = {};
__export(exports_post_compact, {
  default: () => postCompact
});
import { existsSync as existsSync12, readdirSync as readdirSync4, readFileSync as readFileSync9, statSync as statSync4 } from "node:fs";
import { join as join11 } from "node:path";
async function postCompact(_ev) {
  try {
    const stateDir = join11(process.cwd(), ".qult", ".state");
    if (!existsSync12(stateDir))
      return;
    const parts = [];
    const fixesPath2 = findLatestFile(stateDir, "pending-fixes");
    if (fixesPath2) {
      const fixes = safeReadJson(fixesPath2, []);
      if (fixes.length > 0) {
        parts.push(`[qult] ${fixes.length} pending fix(es):`);
        for (const fix of fixes) {
          parts.push(`  [${fix.gate}] ${fix.file}`);
        }
      }
    }
    const statePath = findLatestFile(stateDir, "session-state");
    if (statePath) {
      const state = safeReadJson(statePath, {});
      if (Object.keys(state).length > 0) {
        const summary = [];
        const gatesPath = join11(process.cwd(), ".qult", "gates.json");
        const hasGates = existsSync12(gatesPath);
        if (state.test_passed_at)
          summary.push(`test_passed_at: ${state.test_passed_at}`);
        else if (hasGates)
          summary.push("tests: NOT PASSED");
        if (state.review_completed_at)
          summary.push(`review_completed_at: ${state.review_completed_at}`);
        else if (hasGates)
          summary.push("review: NOT DONE");
        const files = state.changed_file_paths;
        if (Array.isArray(files) && files.length > 0)
          summary.push(`${files.length} file(s) changed`);
        const disabled = state.disabled_gates;
        if (Array.isArray(disabled) && disabled.length > 0)
          summary.push(`disabled gates: ${disabled.join(", ")}`);
        const reviewIter = state.review_iteration;
        if (typeof reviewIter === "number" && reviewIter > 0)
          summary.push(`review iteration: ${reviewIter}`);
        if (summary.length > 0) {
          parts.push(`[qult] Session: ${summary.join(", ")}`);
        }
      }
    }
    try {
      const planDir = join11(process.cwd(), ".claude", "plans");
      if (existsSync12(planDir)) {
        const planFiles = readdirSync4(planDir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, mtime: statSync4(join11(planDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
        if (planFiles.length > 0) {
          const content = readFileSync9(join11(planDir, planFiles[0].name), "utf-8");
          const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
          const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
          if (taskCount > 0) {
            parts.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
          }
        }
      }
    } catch {}
    if (parts.length > 0) {
      process.stdout.write(parts.join(`
`));
    }
  } catch {}
}
function findLatestFile(stateDir, prefix) {
  try {
    const files = readdirSync4(stateDir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).map((f) => ({
      path: join11(stateDir, f),
      mtime: statSync4(join11(stateDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}
function safeReadJson(path, fallback) {
  try {
    if (!existsSync12(path))
      return fallback;
    return JSON.parse(readFileSync9(path, "utf-8"));
  } catch {
    return fallback;
  }
}
var init_post_compact = () => {};

// src/hooks/dispatcher.ts
init_atomic_write();
init_flush();
init_pending_fixes();
init_session_state();
init_lazy_init();
init_respond();
import { join as join12 } from "node:path";
var EVENT_MAP = {
  "post-tool": () => Promise.resolve().then(() => (init_post_tool(), exports_post_tool)),
  "pre-tool": () => Promise.resolve().then(() => (init_pre_tool(), exports_pre_tool)),
  stop: () => Promise.resolve().then(() => (init_stop(), exports_stop)),
  "subagent-stop": () => Promise.resolve().then(() => (init_subagent_stop(), exports_subagent_stop)),
  "task-completed": () => Promise.resolve().then(() => (init_task_completed(), exports_task_completed)),
  "session-start": () => Promise.resolve().then(() => (init_session_start(), exports_session_start)),
  "post-compact": () => Promise.resolve().then(() => (init_post_compact(), exports_post_compact))
};
var _lastWrittenSessionId;
async function dispatch(event) {
  const loader = EVENT_MAP[event];
  if (!loader) {
    process.stderr.write(`Unknown hook event: ${event}
`);
    process.exit(1);
  }
  let input;
  try {
    input = await new Promise((resolve4, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve4(data));
      process.stdin.on("error", reject);
    });
  } catch {
    return;
  }
  if (!input || input.length > 5000000)
    return;
  let ev;
  try {
    ev = JSON.parse(input);
  } catch {
    return;
  }
  if (ev.session_id) {
    setStateSessionScope(ev.session_id);
    setFixesSessionScope(ev.session_id);
    if (ev.session_id !== _lastWrittenSessionId) {
      try {
        atomicWriteJson(join12(process.cwd(), ".qult", ".state", "latest-session.json"), {
          session_id: ev.session_id,
          updated_at: new Date().toISOString()
        });
        _lastWrittenSessionId = ev.session_id;
      } catch {}
    }
  }
  lazyInit();
  const debug = !!process.env.QULT_DEBUG;
  setCurrentEvent(event);
  try {
    if (debug)
      process.stderr.write(`[qult:debug] event=${event} input=${input.length}b
`);
    const start = Date.now();
    const handler = await loader();
    await handler.default(ev);
    if (debug)
      process.stderr.write(`[qult:debug] ${event} done in ${Date.now() - start}ms
`);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("process.exit")) {
      process.stderr.write(`[qult] ${event}: ${err.message}
`);
    }
  } finally {
    try {
      flushAll();
    } catch {}
    setCurrentEvent("unknown");
  }
}

// src/hook-entry.ts
var event = process.argv[2];
if (!event) {
  process.stderr.write(`Usage: hook.mjs <event>
`);
  process.exit(1);
}
dispatch(event).catch((err) => {
  if (err instanceof Error) {
    process.stderr.write(`[qult] ${err.message}
`);
  }
});
