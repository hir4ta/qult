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
var DEFAULTS, _cache = null;
var init_config = __esm(() => {
  DEFAULTS = {
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
import { homedir } from "node:os";
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
  const cleaned = verify.replace(/[`"']/g, "");
  const colonIdx = cleaned.lastIndexOf(":");
  if (colonIdx <= 0)
    return null;
  const file = cleaned.slice(0, colonIdx).trim();
  const testName = cleaned.slice(colonIdx + 1).trim();
  if (!file || !testName)
    return null;
  return { file, testName };
}
function scanPlanDir(dir) {
  try {
    if (!existsSync5(dir))
      return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({
      path: join4(dir, f),
      mtime: statSync(join4(dir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
function getLatestPlanPath() {
  try {
    const projectDir = join4(process.cwd(), ".claude", "plans");
    const projectFiles = scanPlanDir(projectDir);
    if (projectFiles.length > 0)
      return projectFiles[0].path;
    const envDir = process.env.CLAUDE_PLANS_DIR;
    if (envDir) {
      const envFiles = scanPlanDir(envDir);
      if (envFiles.length > 0)
        return envFiles[0].path;
    }
    if (!_disableHomeFallback) {
      try {
        const homeDir = join4(homedir(), ".claude", "plans");
        const homeFiles = scanPlanDir(homeDir);
        const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recentHome = homeFiles.filter((f) => f.mtime > recentCutoff);
        if (recentHome.length > 0)
          return recentHome[0].path;
      } catch {}
    }
    return null;
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
function hasPlanFile() {
  try {
    const planDir = join4(process.cwd(), ".claude", "plans");
    if (!existsSync5(planDir))
      return false;
    return readdirSync(planDir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}
var TASK_RE, CHECKBOX_RE, FILE_LINE_RE, VERIFY_LINE_RE, _planCache = null, _planCachePath = null, _planCacheMtime = null, _disableHomeFallback = false;
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
    gate_failure_counts: {},
    security_warning_count: 0,
    test_quality_warning_count: 0,
    drift_warning_count: 0,
    dead_import_warning_count: 0,
    duplication_warning_count: 0,
    human_review_approved_at: null
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
  state.security_warning_count = 0;
  state.test_quality_warning_count = 0;
  state.drift_warning_count = 0;
  state.dead_import_warning_count = 0;
  state.duplication_warning_count = 0;
  state.human_review_approved_at = null;
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
  const count = Math.min((state.gate_failure_counts[key] ?? 0) + 1, MAX_GATE_FAILURE_COUNT);
  state.gate_failure_counts[key] = count;
  const keys = Object.keys(state.gate_failure_counts);
  if (keys.length > MAX_GATE_FAILURE_KEYS) {
    const sorted = [...keys].sort((a, b) => (state.gate_failure_counts[a] ?? 0) - (state.gate_failure_counts[b] ?? 0));
    const toRemove = sorted.slice(0, keys.length - MAX_GATE_FAILURE_KEYS);
    for (const k of toRemove) {
      delete state.gate_failure_counts[k];
    }
  }
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
function incrementEscalation(counter) {
  const state = readSessionState();
  const count = (state[counter] ?? 0) + 1;
  state[counter] = count;
  writeState(state);
  return count;
}
function readEscalation(counter) {
  return readSessionState()[counter] ?? 0;
}
function readHumanApproval() {
  const state = readSessionState();
  if (!state.human_review_approved_at)
    return null;
  return { approved_at: state.human_review_approved_at };
}
var STATE_DIR2 = ".qult/.state", FILE = "session-state.json", _cache4 = null, _dirty2 = false, _sessionScope2 = null, TOOL_EXTS, MAX_GATE_FAILURE_COUNT = 100, MAX_GATE_FAILURE_KEYS = 200;
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

// src/hooks/sanitize.ts
function sanitizeForStderr(input) {
  const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

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
      parts.push(`disabled: ${disabled.map((g) => sanitizeForStderr(g)).join(",")}`);
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
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function deduplicateErrors(text) {
  const lines = text.split(`
`);
  const codeGroups = new Map;
  const lineCodes = [];
  for (let i = 0;i < lines.length; i++) {
    const match = lines[i].match(ERROR_CODE_RE);
    const code = match ? match[1] : null;
    lineCodes.push(code);
    if (code) {
      const existing = codeGroups.get(code);
      if (existing) {
        existing.count++;
      } else {
        codeGroups.set(code, { first: i, count: 1 });
      }
    }
  }
  const hasRepeats = [...codeGroups.values()].some((g) => g.count > 1);
  if (!hasRepeats)
    return text;
  const result = [];
  const emittedSummary = new Set;
  for (let i = 0;i < lines.length; i++) {
    const code = lineCodes[i];
    if (!code) {
      result.push(lines[i]);
      continue;
    }
    const group = codeGroups.get(code);
    if (group.count === 1) {
      result.push(lines[i]);
    } else if (i === group.first) {
      result.push(lines[i]);
      if (!emittedSummary.has(code)) {
        result.push(`... and ${group.count - 1} more ${code} errors`);
        emittedSummary.add(code);
      }
    }
  }
  return result.join(`
`);
}
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
function buildPath(extraPaths) {
  const cwd = process.cwd();
  const extra = extraPaths.filter((p) => !p.includes(":")).map((p) => p.startsWith("/") ? p : `${cwd}/${p}`).join(":");
  const prefix = extra ? `${extra}:` : "";
  return `${prefix}${cwd}/node_modules/.bin:${process.env.PATH}`;
}
function runGateAsync(name, gate, file) {
  const config = loadConfig();
  const command = file ? gate.command.replace("{file}", shellEscape(file)) : gate.command;
  const timeout = gate.timeout ?? config.gates.default_timeout;
  const maxChars = config.gates.output_max_chars;
  const start = Date.now();
  return new Promise((resolve) => {
    exec(command, {
      cwd: process.cwd(),
      timeout,
      env: {
        ...process.env,
        PATH: buildPath(config.gates.extra_path)
      },
      encoding: "utf-8"
    }, (err, stdout, stderr) => {
      const duration_ms = Date.now() - start;
      if (err) {
        const raw = (stdout ?? "") + (stderr ?? "");
        const output = smartTruncate(deduplicateErrors(raw), maxChars) || `Exit code ${err.code ?? 1}`;
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
  const command = file ? gate.command.replace("{file}", shellEscape(file)) : gate.command;
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
        PATH: buildPath(config.gates.extra_path)
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
    const output = smartTruncate(deduplicateErrors(stdout + stderr), maxChars) || `Exit code ${status}`;
    return {
      name,
      passed: false,
      output,
      duration_ms
    };
  }
}
var ERROR_CODE_RE;
var init_runner = __esm(() => {
  init_config();
  ERROR_CODE_RE = /\b([A-Z]{1,4}\d{4,5})\b/;
});

// src/hooks/detectors/convention-check.ts
import { readdirSync as readdirSync3, statSync as statSync3 } from "node:fs";
import { basename, dirname as dirname2, extname, join as join8 } from "node:path";
function classify(name) {
  if (KEBAB_RE.test(name))
    return "kebab-case";
  if (SNAKE_RE.test(name))
    return "snake_case";
  if (PASCAL_RE.test(name))
    return "PascalCase";
  if (CAMEL_RE.test(name))
    return "camelCase";
  return "other";
}
function detectConventionDrift(file) {
  const dir = dirname2(file);
  const fileName = basename(file);
  const stem = basename(fileName, extname(fileName));
  let siblings;
  try {
    siblings = readdirSync3(dir).filter((f) => {
      try {
        return f !== fileName && statSync3(join8(dir, f)).isFile();
      } catch {
        return false;
      }
    }).map((f) => basename(f, extname(f)));
  } catch {
    return [];
  }
  if (siblings.length < 3)
    return [];
  const counts = new Map;
  for (const s of siblings) {
    const c = classify(s);
    if (c !== "other")
      counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let dominant = null;
  let dominantCount = 0;
  for (const [conv, count] of counts) {
    if (count > dominantCount) {
      dominant = conv;
      dominantCount = count;
    }
  }
  const classifiableCount = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!dominant || classifiableCount === 0 || dominantCount <= classifiableCount * 0.5)
    return [];
  const fileConvention = classify(stem);
  if (fileConvention === dominant || fileConvention === "other")
    return [];
  return [
    sanitizeForStderr(`${fileName} uses ${fileConvention} but siblings use ${dominant} (${dominantCount}/${classifiableCount})`)
  ];
}
var KEBAB_RE, CAMEL_RE, SNAKE_RE, PASCAL_RE;
var init_convention_check = __esm(() => {
  KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
  CAMEL_RE = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;
  SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
  PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/;
});

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync8, readFileSync as readFileSync6 } from "node:fs";
import { extname as extname2 } from "node:path";
function detectDeadImports(file) {
  if (isGateDisabled("dead-import-check"))
    return [];
  const ext = extname2(file).toLowerCase();
  if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext))
    return [];
  if (!existsSync8(file))
    return [];
  let content;
  try {
    content = readFileSync6(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE)
    return [];
  if (PY_EXTS.has(ext))
    return detectDeadPythonImports(content);
  return detectDeadTsJsImports(content);
}
function detectDeadTsJsImports(content) {
  const lines = content.split(`
`);
  const imports = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (SIDE_EFFECT_RE.test(line) && !DEFAULT_IMPORT_RE.test(line) && !NAMED_IMPORT_RE.test(line) && !NAMESPACE_IMPORT_RE.test(line))
      continue;
    if (REEXPORT_RE.test(line))
      continue;
    const typeMatch = line.match(TYPE_IMPORT_RE);
    if (typeMatch) {
      for (const imp of parseNamedImports(typeMatch[1])) {
        imports.push({ name: imp.alias, line: i + 1 });
      }
      continue;
    }
    const defaultMatch = line.match(DEFAULT_IMPORT_RE);
    if (defaultMatch) {
      imports.push({ name: defaultMatch[1], line: i + 1 });
    }
    const namedMatch = line.match(NAMED_IMPORT_RE);
    if (namedMatch) {
      for (const imp of parseNamedImports(namedMatch[1])) {
        imports.push({ name: imp.alias, line: i + 1 });
      }
    }
    const nsMatch = line.match(NAMESPACE_IMPORT_RE);
    if (nsMatch) {
      imports.push({ name: nsMatch[1], line: i + 1 });
    }
  }
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ")).join(`
`);
  const warnings = [];
  for (const { name, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" — consider removing`));
    }
  }
  return warnings;
}
function detectDeadPythonImports(content) {
  const lines = content.split(`
`);
  const imports = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("#"))
      continue;
    const fromMatch = line.match(PY_FROM_IMPORT_RE);
    if (fromMatch) {
      const names = fromMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const n of names) {
        const parts = n.split(/\s+as\s+/);
        const alias = (parts.length > 1 ? parts[1] : parts[0]).trim();
        if (alias === "*")
          continue;
        if (/^\w+$/.test(alias)) {
          imports.push({ name: alias, line: i + 1 });
        }
      }
      continue;
    }
    const importMatch = line.match(PY_IMPORT_RE);
    if (importMatch) {
      const names = importMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const n of names) {
        const parts = n.split(/\s+as\s+/);
        const alias = (parts.length > 1 ? parts[1] : parts[0]).trim();
        const topName = alias.split(".")[0];
        if (/^\w+$/.test(topName)) {
          imports.push({ name: topName, line: i + 1 });
        }
      }
    }
  }
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ") && !line.trimStart().startsWith("from ")).join(`
`);
  const warnings = [];
  for (const { name, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" — consider removing`));
    }
  }
  return warnings;
}
function parseNamedImports(raw) {
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
    const withoutType = s.replace(/^type\s+/, "");
    const parts = withoutType.split(/\s+as\s+/);
    return {
      name: parts[0].trim(),
      alias: (parts.length > 1 ? parts[1] : parts[0]).trim()
    };
  }).filter(({ alias }) => /^\w+$/.test(alias));
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var TS_JS_EXTS, PY_EXTS, MAX_CHECK_SIZE = 500000, DEFAULT_IMPORT_RE, NAMED_IMPORT_RE, NAMESPACE_IMPORT_RE, SIDE_EFFECT_RE, REEXPORT_RE, TYPE_IMPORT_RE, PY_FROM_IMPORT_RE, PY_IMPORT_RE;
var init_dead_import_check = __esm(() => {
  init_session_state();
  TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  PY_EXTS = new Set([".py", ".pyi"]);
  DEFAULT_IMPORT_RE = /^\s*import\s+(\w+)\s+from\s+["']/;
  NAMED_IMPORT_RE = /^\s*import\s*\{([^}]+)\}\s*from\s+["']/;
  NAMESPACE_IMPORT_RE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+["']/;
  SIDE_EFFECT_RE = /^\s*import\s+["']/;
  REEXPORT_RE = /^\s*export\s+\{[^}]*\}\s+from\s+["']/;
  TYPE_IMPORT_RE = /^\s*import\s+type\s+\{([^}]+)\}\s*from\s+["']/;
  PY_FROM_IMPORT_RE = /^\s*from\s+\S+\s+import\s+(.+)/;
  PY_IMPORT_RE = /^\s*import\s+(.+)/;
});

// src/hooks/detectors/duplication-check.ts
import { existsSync as existsSync9, readFileSync as readFileSync7 } from "node:fs";
import { extname as extname3, resolve } from "node:path";
function normalizeLine(line) {
  const trimmed = line.trim();
  if (trimmed === "")
    return null;
  if (trimmed.startsWith("//") || trimmed.startsWith("#"))
    return null;
  if (trimmed.startsWith("* ") || trimmed.startsWith("*/"))
    return null;
  if (/^\s*(import\b|from\b|require\b|export\b)/.test(line))
    return null;
  return trimmed;
}
function buildHashWindows(content) {
  const lines = content.split(`
`);
  const normalized = [];
  for (let i = 0;i < lines.length; i++) {
    const norm = normalizeLine(lines[i]);
    if (norm !== null) {
      normalized.push({ line: i + 1, text: norm });
    }
  }
  const windows = new Map;
  for (let i = 0;i <= normalized.length - MIN_BLOCK_LINES; i++) {
    const key = normalized.slice(i, i + MIN_BLOCK_LINES).map((n) => n.text).join(`
`);
    const startLine = normalized[i].line;
    const existing = windows.get(key);
    if (existing) {
      existing.push(startLine);
    } else {
      windows.set(key, [startLine]);
    }
  }
  return windows;
}
function detectDuplication(file) {
  if (isGateDisabled("duplication-check"))
    return [];
  const ext = extname3(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync9(file))
    return [];
  let content;
  try {
    content = readFileSync7(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE2)
    return [];
  const windows = buildHashWindows(content);
  const errors = [];
  const reported = new Set;
  for (const [hash, positions] of windows) {
    if (positions.length < 2)
      continue;
    const key = `${positions[0]}-${positions[1]}`;
    if (reported.has(key))
      continue;
    reported.add(key);
    const preview = hash.split(`
`)[0].slice(0, 80);
    errors.push(`Intra-file duplicate (${MIN_BLOCK_LINES}+ lines) at L${positions[0]} and L${positions[1]}: "${preview}..."`);
  }
  if (errors.length === 0)
    return [];
  return [{ file, errors, gate: "duplication-check" }];
}
function detectCrossFileDuplication(file, sessionFiles) {
  if (isGateDisabled("duplication-check"))
    return [];
  if (sessionFiles.length > MAX_SESSION_FILES) {
    process.stderr.write(`[qult] Cross-file duplication check skipped: session has ${sessionFiles.length} files, max ${MAX_SESSION_FILES} allowed. Increase MAX_SESSION_FILES to enable on large refactorings.
`);
    return [];
  }
  const ext = extname3(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync9(file))
    return [];
  let content;
  try {
    content = readFileSync7(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE2)
    return [];
  const sourceWindows = buildHashWindows(content);
  const warnings = [];
  const cwd = process.cwd();
  for (const otherFile of sessionFiles) {
    if (otherFile === file)
      continue;
    const absOther = resolve(otherFile);
    if (!absOther.startsWith(`${cwd}/`))
      continue;
    if (!existsSync9(otherFile))
      continue;
    const otherExt = extname3(otherFile).toLowerCase();
    if (!CHECKABLE_EXTS.has(otherExt))
      continue;
    let otherContent;
    try {
      otherContent = readFileSync7(otherFile, "utf-8");
    } catch {
      continue;
    }
    if (otherContent.length > MAX_CHECK_SIZE2)
      continue;
    const otherWindows = buildHashWindows(otherContent);
    let matchCount = 0;
    for (const hash of sourceWindows.keys()) {
      if (otherWindows.has(hash)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      const relPath = getRelativePath(otherFile, cwd);
      const preview = Array.from(sourceWindows.keys())[0].split(`
`)[0].slice(0, 80);
      const blockCountLabel = matchCount === 1 ? "block" : "blocks";
      warnings.push(`Cross-file duplicate with ${relPath}: ${matchCount} matching ${blockCountLabel} found. Preview: "${preview}..."`);
    }
  }
  return warnings;
}
function getRelativePath(filePath2, cwd) {
  const full = filePath2.startsWith(cwd) ? filePath2.slice(cwd.length + 1) : filePath2;
  const segments = full.split("/");
  if (segments.length <= 3)
    return full;
  return `${segments[0]}/.../.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
var CHECKABLE_EXTS, MAX_CHECK_SIZE2 = 500000, MIN_BLOCK_LINES = 4, MAX_SESSION_FILES = 20;
var init_duplication_check = __esm(() => {
  init_session_state();
  CHECKABLE_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".py",
    ".pyi",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt"
  ]);
});

// src/hooks/detectors/export-check.ts
import { execSync as execSync2 } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync8 } from "node:fs";
import { extname as extname4 } from "node:path";
function detectExportBreakingChanges(file) {
  if (isGateDisabled("export-check"))
    return [];
  const ext = extname4(file).toLowerCase();
  if (!TS_JS_EXTS2.has(ext))
    return [];
  if (!existsSync10(file))
    return [];
  let oldContent;
  try {
    const cwd = process.cwd();
    if (!file.startsWith(`${cwd}/`) && file !== cwd)
      return [];
    const relPath = file.slice(cwd.length + 1);
    oldContent = execSync2(`git show HEAD:${relPath}`, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return [];
  }
  const newContent = readFileSync8(file, "utf-8");
  const oldExports = new Set;
  for (const match of oldContent.matchAll(EXPORT_RE)) {
    oldExports.add(match[1]);
  }
  const newExports = new Set;
  for (const match of newContent.matchAll(EXPORT_RE)) {
    newExports.add(match[1]);
  }
  const removed = [...oldExports].filter((name) => !newExports.has(name));
  if (removed.length === 0)
    return [];
  return [
    {
      file,
      errors: removed.map((name) => `Breaking change: export "${sanitizeForStderr(name)}" was removed`),
      gate: "export-check"
    }
  ];
}
var TS_JS_EXTS2, EXPORT_RE;
var init_export_check = __esm(() => {
  init_session_state();
  TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
});

// src/hooks/detectors/import-check.ts
import { existsSync as existsSync11, readdirSync as readdirSync4, readFileSync as readFileSync9 } from "node:fs";
import { extname as extname5, join as join9, resolve as resolve2 } from "node:path";
function detectHallucinatedImports(file) {
  if (isGateDisabled("import-check"))
    return [];
  const ext = extname5(file).toLowerCase();
  if (!TS_JS_EXTS3.has(ext) && !PY_EXTS2.has(ext) && !GO_EXTS.has(ext))
    return [];
  if (!existsSync11(file))
    return [];
  const content = readFileSync9(file, "utf-8");
  if (content.length > MAX_IMPORT_CHECK_SIZE)
    return [];
  if (PY_EXTS2.has(ext))
    return detectPythonImports(file, content);
  if (GO_EXTS.has(ext))
    return detectGoImports(file, content);
  return detectTsJsImports(file, content);
}
function detectTsJsImports(file, content) {
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
    if (!existsSync11(join9(cwd, "node_modules", pkgName))) {
      missingPkgs.push(pkgName);
    }
  }
  if (missingPkgs.length === 0)
    return [];
  const unique = [...new Set(missingPkgs)];
  return [
    {
      file,
      errors: unique.map((pkg) => `Hallucinated import: package "${sanitizeForStderr(pkg.slice(0, 128))}" not found in node_modules`),
      gate: "import-check"
    }
  ];
}
function detectPythonImports(file, content) {
  const cwd = process.cwd();
  const missingModules = [];
  const sitePackagesDirs = findPythonSitePackages(cwd);
  for (const line of content.split(`
`)) {
    if (line.trimStart().startsWith("#"))
      continue;
    const match = line.match(PY_IMPORT_RE2);
    if (!match)
      continue;
    const moduleName = match[1] ?? match[2];
    if (PY_STDLIB.has(moduleName))
      continue;
    if (moduleName.startsWith("_"))
      continue;
    if (existsSync11(join9(cwd, `${moduleName}.py`)) || existsSync11(join9(cwd, moduleName)))
      continue;
    if (sitePackagesDirs.some((dir) => existsSync11(join9(dir, moduleName)) || existsSync11(join9(dir, `${moduleName}.py`))))
      continue;
    missingModules.push(moduleName);
  }
  if (missingModules.length === 0)
    return [];
  const unique = [...new Set(missingModules)];
  return [
    {
      file,
      errors: unique.map((mod) => {
        const safe = sanitizeForStderr(mod.slice(0, 128));
        return `Hallucinated import: Python module "${safe}" not found (not stdlib, no ${safe}.py or ${safe}/ in project)`;
      }),
      gate: "import-check"
    }
  ];
}
function detectGoImports(file, content) {
  const cwd = process.cwd();
  const missingPkgs = [];
  let goSum = null;
  try {
    goSum = readFileSync9(join9(cwd, "go.sum"), "utf-8");
  } catch {}
  const lines = content.split(`
`);
  let inBlock = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("//"))
      continue;
    if (/^\s*import\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === ")") {
      inBlock = false;
      continue;
    }
    let importPath;
    if (inBlock) {
      const m = line.match(GO_IMPORT_RE);
      if (m)
        importPath = m[1];
    } else {
      const m = line.match(/^\s*import\s+"([^"]+)"/);
      if (m)
        importPath = m[1];
    }
    if (!importPath)
      continue;
    const topPkg = importPath.split("/")[0];
    if (GO_STDLIB_PREFIXES.has(topPkg))
      continue;
    const vendorDir = resolve2(cwd, "vendor");
    const vendorPath = resolve2(vendorDir, importPath);
    if (vendorPath.startsWith(`${vendorDir}/`) && existsSync11(vendorPath))
      continue;
    if (goSum?.includes(`${importPath} `))
      continue;
    missingPkgs.push(importPath);
  }
  if (missingPkgs.length === 0)
    return [];
  const unique = [...new Set(missingPkgs)];
  return [
    {
      file,
      errors: unique.map((pkg) => `Hallucinated import: Go package "${sanitizeForStderr(pkg.slice(0, 128))}" not found (not stdlib, not in vendor/ or go.sum)`),
      gate: "import-check"
    }
  ];
}
function findPythonSitePackages(cwd) {
  const dirs = [];
  const venvRoots = [join9(cwd, ".venv"), join9(cwd, "venv")];
  for (const root of venvRoots) {
    try {
      if (!existsSync11(root))
        continue;
      const libDir = join9(root, "lib");
      if (!existsSync11(libDir))
        continue;
      const entries = readdirSync4(libDir).filter((e) => e.startsWith("python"));
      for (const entry of entries) {
        const sp = join9(libDir, entry, "site-packages");
        if (existsSync11(sp))
          dirs.push(sp);
      }
    } catch {}
  }
  return dirs;
}
var TS_JS_EXTS3, PY_EXTS2, GO_EXTS, IMPORT_LINE_RE, PY_IMPORT_RE2, MAX_IMPORT_CHECK_SIZE = 500000, GO_IMPORT_RE, GO_STDLIB_PREFIXES, FALLBACK_BUILTINS, PY_STDLIB;
var init_import_check = __esm(() => {
  init_session_state();
  TS_JS_EXTS3 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  PY_EXTS2 = new Set([".py", ".pyi"]);
  GO_EXTS = new Set([".go"]);
  IMPORT_LINE_RE = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"'./][^"']*)["']/;
  PY_IMPORT_RE2 = /^\s*(?:import\s+(\w+)|from\s+(\w+)\s+import)\b/;
  GO_IMPORT_RE = /^\s*"([^"]+)"/;
  GO_STDLIB_PREFIXES = new Set([
    "archive",
    "bufio",
    "bytes",
    "cmp",
    "compress",
    "context",
    "crypto",
    "database",
    "debug",
    "embed",
    "encoding",
    "errors",
    "flag",
    "fmt",
    "go",
    "hash",
    "html",
    "image",
    "internal",
    "io",
    "iter",
    "log",
    "maps",
    "math",
    "mime",
    "net",
    "os",
    "path",
    "plugin",
    "reflect",
    "regexp",
    "runtime",
    "slices",
    "sort",
    "strconv",
    "strings",
    "structs",
    "sync",
    "syscall",
    "testing",
    "text",
    "time",
    "unicode",
    "unique",
    "unsafe",
    "vendor"
  ]);
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
  PY_STDLIB = new Set([
    "abc",
    "aifc",
    "argparse",
    "array",
    "ast",
    "asyncio",
    "atexit",
    "base64",
    "binascii",
    "bisect",
    "builtins",
    "bz2",
    "calendar",
    "cgi",
    "cmd",
    "code",
    "codecs",
    "collections",
    "colorsys",
    "compileall",
    "concurrent",
    "configparser",
    "contextlib",
    "copy",
    "copyreg",
    "csv",
    "ctypes",
    "curses",
    "dataclasses",
    "datetime",
    "dbm",
    "decimal",
    "difflib",
    "dis",
    "email",
    "enum",
    "errno",
    "faulthandler",
    "fileinput",
    "fnmatch",
    "fractions",
    "ftplib",
    "functools",
    "gc",
    "getopt",
    "getpass",
    "gettext",
    "glob",
    "grp",
    "gzip",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "http",
    "imaplib",
    "importlib",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "linecache",
    "locale",
    "logging",
    "lzma",
    "mailbox",
    "math",
    "mimetypes",
    "mmap",
    "multiprocessing",
    "netrc",
    "numbers",
    "operator",
    "optparse",
    "os",
    "pathlib",
    "pdb",
    "pickle",
    "pickletools",
    "pkgutil",
    "platform",
    "plistlib",
    "poplib",
    "posixpath",
    "pprint",
    "queue",
    "random",
    "re",
    "readline",
    "reprlib",
    "resource",
    "rlcompleter",
    "sched",
    "secrets",
    "select",
    "selectors",
    "shelve",
    "shlex",
    "shutil",
    "signal",
    "site",
    "smtplib",
    "socket",
    "socketserver",
    "sqlite3",
    "ssl",
    "stat",
    "statistics",
    "string",
    "struct",
    "subprocess",
    "sunau",
    "symtable",
    "sys",
    "sysconfig",
    "syslog",
    "tarfile",
    "tempfile",
    "termios",
    "textwrap",
    "threading",
    "time",
    "timeit",
    "tkinter",
    "token",
    "tokenize",
    "tomllib",
    "trace",
    "traceback",
    "tracemalloc",
    "tty",
    "turtle",
    "types",
    "typing",
    "unicodedata",
    "unittest",
    "urllib",
    "uuid",
    "venv",
    "warnings",
    "wave",
    "weakref",
    "xml",
    "xmlrpc",
    "zipfile",
    "zipimport",
    "zlib"
  ]);
});

// src/hooks/detectors/security-check.ts
import { existsSync as existsSync12, readFileSync as readFileSync10 } from "node:fs";
import { extname as extname6 } from "node:path";
function detectSecurityPatterns(file) {
  if (isGateDisabled("security-check"))
    return [];
  const ext = extname6(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (!existsSync12(file))
    return [];
  let content;
  try {
    content = readFileSync10(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE3)
    return [];
  const errors = [];
  const lines = content.split(`
`);
  const fileName = file.split("/").pop() ?? "";
  const isTestFile = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_") || fileName.includes("_test.");
  const starIsComment = JS_TS_EXTS.has(ext) || ext === ".java" || ext === ".kt" || ext === ".cs";
  const hasBlockComments = JS_TS_EXTS.has(ext) || ext === ".java" || ext === ".kt" || ext === ".cs" || ext === ".go" || ext === ".rs";
  let inBlockComment = false;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (hasBlockComments) {
      if (inBlockComment) {
        const endIdx = line.indexOf("*/");
        if (endIdx >= 0) {
          inBlockComment = false;
          const afterComment = line.slice(endIdx + 2);
          if (!afterComment.trim())
            continue;
        } else {
          continue;
        }
      }
      if (!inBlockComment && trimmed.startsWith("/*")) {
        const endIdx = line.indexOf("*/", line.indexOf("/*") + 2);
        if (endIdx < 0) {
          inBlockComment = true;
          continue;
        }
        const afterComment = line.slice(endIdx + 2);
        if (!afterComment.trim())
          continue;
      }
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#"))
      continue;
    if (starIsComment && trimmed.startsWith("*"))
      continue;
    if (!isTestFile) {
      for (const { re, desc } of SECRET_PATTERNS) {
        if (re.test(line)) {
          if (/process\.env\b/.test(line))
            continue;
          if (/os\.environ/.test(line))
            continue;
          if (/\$\{?\w*ENV\w*\}?/.test(line))
            continue;
          errors.push(`L${i + 1}: ${desc}`);
          break;
        }
      }
    }
    for (const { re, desc, exts } of DANGEROUS_PATTERNS) {
      if (exts && !exts.has(ext))
        continue;
      if (re.test(line)) {
        errors.push(`L${i + 1}: ${desc}`);
        break;
      }
    }
  }
  if (JS_TS_EXTS.has(ext)) {
    emitAdvisoryWarnings(file, content);
  }
  if (errors.length === 0)
    return [];
  return [
    {
      file,
      errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
      gate: "security-check"
    }
  ];
}
function emitAdvisoryWarnings(file, content) {
  try {
    const lines = content.split(`
`);
    for (let i = 0;i < lines.length; i++) {
      const line = lines[i];
      for (const { re, suppress, desc } of ADVISORY_PATTERNS) {
        if (re.test(line) && !suppress.test(line)) {
          const relative = file.split("/").slice(-3).join("/");
          process.stderr.write(`[qult] Security advisory: ${relative}:${i + 1} — ${desc}
`);
        }
      }
    }
  } catch {}
}
var CHECKABLE_EXTS2, MAX_CHECK_SIZE3 = 500000, SECRET_PATTERNS, JS_TS_EXTS, PY_EXTS3, DANGEROUS_PATTERNS, ADVISORY_PATTERNS;
var init_security_check = __esm(() => {
  init_session_state();
  CHECKABLE_EXTS2 = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".py",
    ".pyi",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt",
    ".php",
    ".cs"
  ]);
  SECRET_PATTERNS = [
    { re: /(?:AKIA|ASIA)[A-Z0-9]{16,}/, desc: "AWS access key" },
    { re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/, desc: "GitHub token" },
    { re: /xox[bpas]-[A-Za-z0-9-]{10,}/, desc: "Slack token" },
    { re: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}/, desc: "Stripe key" },
    {
      re: /["'`]Bearer\s+[A-Za-z0-9_\-/.+=]{20,}["'`]/,
      desc: "Hardcoded Bearer token"
    },
    {
      re: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*["'`][A-Za-z0-9_\-/.]{20,}["'`]/i,
      desc: "Hardcoded API key"
    },
    {
      re: /(?:secret|password|passwd|pwd|token|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["'`][^\s"'`]{8,}["'`]/i,
      desc: "Hardcoded secret/password"
    },
    { re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, desc: "Private key" },
    {
      re: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:]+:[^@\s]{4,}@/i,
      desc: "Connection string with embedded credentials"
    }
  ];
  JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  PY_EXTS3 = new Set([".py", ".pyi"]);
  DANGEROUS_PATTERNS = [
    {
      re: /\beval\s*\(\s*(?!["'`])[a-zA-Z_$]/,
      desc: "eval() with dynamic input — command injection risk",
      exts: JS_TS_EXTS
    },
    {
      re: /\.innerHTML\s*=\s*(?!["'`]|`\s*$)[a-zA-Z_$]/,
      desc: "innerHTML assignment with dynamic value — XSS risk",
      exts: JS_TS_EXTS
    },
    {
      re: /document\.write\s*\(\s*(?!["'`])[a-zA-Z_$]/,
      desc: "document.write() with dynamic input — XSS risk",
      exts: JS_TS_EXTS
    },
    {
      re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[a-zA-Z_$](?!['"]))/,
      desc: "exec/execSync with dynamic command — command injection risk",
      exts: JS_TS_EXTS
    },
    {
      re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*["'`]\s*\+\s*[a-zA-Z_$]/i,
      desc: "SQL string concatenation — SQL injection risk"
    },
    {
      re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\$\{/i,
      desc: "SQL template literal with interpolation — SQL injection risk"
    },
    {
      re: /(?:os\.system|subprocess\.(?:call|run|Popen|check_output))\s*\(\s*f["']/,
      desc: "Shell command with f-string — command injection risk",
      exts: PY_EXTS3
    },
    {
      re: /\b(?:eval|exec)\s*\(\s*(?!["'])[a-zA-Z_]/,
      desc: "eval/exec with dynamic input — code injection risk",
      exts: PY_EXTS3
    },
    {
      re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`])[a-zA-Z_$]/,
      desc: "dangerouslySetInnerHTML with dynamic value — XSS risk",
      exts: JS_TS_EXTS
    }
  ];
  ADVISORY_PATTERNS = [
    {
      re: /\bapp\.(?:get|post|put|delete|patch)\s*\(\s*["'`]\/api\//,
      suppress: /auth|middleware|protect|guard|verify|session/i,
      desc: "API route — verify auth middleware is applied"
    },
    {
      re: /\bwss?\.on\s*\(\s*["'`]connection["'`]/,
      suppress: /auth|token|verify|session|guard/i,
      desc: "WebSocket handler — verify authentication is applied"
    }
  ];
});

// src/hooks/detectors/test-file-resolver.ts
import { existsSync as existsSync13 } from "node:fs";
import { basename as basename2, dirname as dirname3, extname as extname7, join as join10 } from "node:path";
function resolveTestFile(sourceFile) {
  const ext = extname7(sourceFile);
  const base = basename2(sourceFile, ext);
  const dir = dirname3(sourceFile);
  if (isTestFile(sourceFile))
    return null;
  for (const pattern of TEST_PATTERNS) {
    const candidate = pattern(dir, base, ext);
    if (candidate && existsSync13(candidate)) {
      return candidate;
    }
  }
  return null;
}
function isTestFile(file) {
  const base = basename2(file);
  return /\.(test|spec)\.\w+$/.test(base) || /^test_\w+\.py$/.test(base) || /_test\.go$/.test(base) || /\/(__tests__|tests)\//.test(file);
}
var TEST_PATTERNS;
var init_test_file_resolver = __esm(() => {
  TEST_PATTERNS = [
    (dir, name, ext) => join10(dir, `${name}.test${ext}`),
    (dir, name, ext) => join10(dir, `${name}.spec${ext}`),
    (dir, name, ext) => join10(dir, "__tests__", `${name}.test${ext}`),
    (dir, name, ext) => join10(dir, "__tests__", `${name}.spec${ext}`),
    (dir, name, ext) => join10(dir, "tests", `${name}.test${ext}`),
    (dir, name, ext) => ext === ".py" ? join10(dir, `test_${name}${ext}`) : null,
    (dir, name, ext) => ext === ".py" ? join10(dir, "tests", `test_${name}${ext}`) : null,
    (dir, name, ext) => ext === ".go" ? join10(dir, `${name}_test${ext}`) : null,
    (dir, name, ext) => ext === ".rs" ? join10(dir, "tests", `${name}${ext}`) : null
  ];
});

// src/hooks/post-tool.ts
var exports_post_tool = {};
__export(exports_post_tool, {
  default: () => postTool
});
import { dirname as dirname4, extname as extname8, resolve as resolve3 } from "node:path";
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
  const file = resolve3(rawFile);
  try {
    const existingFixes = readPendingFixes();
    if (existingFixes.length > 0 && !existingFixes.some((f) => resolve3(f.file) === file)) {
      deny(`Fix existing errors before editing other files (PostToolUse fallback):
${existingFixes.map((f) => `  ${f.file}`).join(`
`)}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
  const qultDir = resolve3(process.cwd(), ".qult");
  if (file.startsWith(`${qultDir}/`) || file === qultDir)
    return;
  const gates = loadGates();
  if (!gates?.on_write)
    return;
  const fileExt = extname8(file).toLowerCase();
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
  try {
    const exportFixes = detectExportBreakingChanges(file);
    newFixes.push(...exportFixes);
  } catch {}
  try {
    const securityFixes = detectSecurityPatterns(file);
    if (securityFixes.length > 0) {
      newFixes.push(...securityFixes);
      const fileName = file.split("/").pop() ?? "";
      const isTestFile2 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_");
      if (!isTestFile2) {
        const count = incrementEscalation("security_warning_count");
        if (count >= 10) {
          process.stderr.write(`[qult] Security escalation: ${count} security warnings this session. Review security posture.
`);
        }
      }
    }
  } catch {}
  try {
    const deadImportWarnings = detectDeadImports(file);
    if (deadImportWarnings.length > 0) {
      incrementEscalation("dead_import_warning_count");
      for (const w of deadImportWarnings) {
        process.stderr.write(`[qult] Dead import: ${w}
`);
      }
    }
  } catch {}
  try {
    const state = readSessionState();
    if (!state.changed_file_paths.includes(file)) {
      const warnings = detectConventionDrift(file);
      for (const w of warnings) {
        process.stderr.write(`[qult] Convention: ${w}
`);
        incrementEscalation("drift_warning_count");
      }
    }
  } catch {}
  try {
    const dupFixes = detectDuplication(file);
    if (dupFixes.length > 0) {
      newFixes.push(...dupFixes);
      incrementEscalation("duplication_warning_count");
    }
    const sessionFiles = readSessionState().changed_file_paths ?? [];
    const crossDupWarnings = detectCrossFileDuplication(file, sessionFiles);
    if (crossDupWarnings.length > 0) {
      incrementEscalation("duplication_warning_count");
      for (const w of crossDupWarnings) {
        process.stderr.write(`[qult] Duplication: ${w}
`);
      }
    }
  } catch {}
  try {
    const config = loadConfig();
    if (config.gates.test_on_edit && newFixes.length === 0) {
      const testFile = resolveTestFile(file);
      if (testFile && gates?.on_commit?.test) {
        const testGate = gates.on_commit.test;
        const testCommand = buildTestFileCommand(testGate.command, testFile);
        if (testCommand) {
          const testResult = await runGateAsync("test-on-edit", {
            command: testCommand,
            timeout: config.gates.test_on_edit_timeout
          });
          if (!testResult.passed) {
            newFixes.push({ file, errors: [testResult.output], gate: "test-on-edit" });
            process.stderr.write(`[qult] test-on-edit: ${testFile} FAIL
`);
          } else {
            process.stderr.write(`[qult] test-on-edit: ${testFile} PASS
`);
          }
        }
      }
    }
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
        gateParts.push("import-check FAIL");
      const exportFixCount = newFixes.filter((f) => f.gate === "export-check").length;
      if (exportFixCount > 0)
        gateParts.push("export-check FAIL");
      const securityFixCount = newFixes.filter((f) => f.gate === "security-check").length;
      if (securityFixCount > 0)
        gateParts.push("security-check FAIL");
      const totalFixes = readPendingFixes().length;
      const fixSuffix = totalFixes > 0 ? ` | ${totalFixes} pending fix(es)` : "";
      process.stderr.write(`[qult] gates: ${gateParts.join(", ")}${fixSuffix}
`);
    }
  } catch {}
  try {
    recordChangedFile(file);
  } catch {}
  try {
    checkOverEngineering();
  } catch {}
  try {
    checkPlanRequired();
  } catch {}
}
function checkOverEngineering() {
  const plan = getActivePlan();
  if (!plan)
    return;
  const state = readSessionState();
  const changed = state.changed_file_paths ?? [];
  const totalChanged = changed.length;
  const cwd = process.cwd();
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve3(cwd, t.file)));
  const unplannedCount = changed.filter((f) => !planFiles.has(f)).length;
  const planTaskCount = plan.tasks.filter((t) => t.file).length;
  if (unplannedCount > 5 || totalChanged > planTaskCount * 2) {
    process.stderr.write(`[qult] Over-engineering risk: ${unplannedCount} unplanned file(s) out of ${totalChanged} changed. Review scope.
`);
  }
}
function checkPlanRequired() {
  const plan = getActivePlan();
  if (plan)
    return;
  const state = readSessionState();
  const changed = state.changed_file_paths?.length ?? 0;
  const threshold = loadConfig().review.required_changed_files;
  if (changed >= threshold && !planWarnedAt.has(threshold)) {
    planWarnedAt.add(threshold);
    process.stderr.write(`[qult] Plan required: ${changed} files changed without a plan. Run /qult:plan-generator to create a structured plan.
`);
  }
  if (changed >= threshold * 2 && !planWarnedAt.has(threshold * 2)) {
    planWarnedAt.add(threshold * 2);
    process.stderr.write(`[qult] Plan strongly recommended: ${changed} files changed (${threshold * 2}+ threshold). Large unplanned changes risk scope creep and missed tests.
`);
  }
}
function buildTestFileCommand(testCommand, testFile) {
  const escaped = shellEscape(testFile);
  if (/\b(vitest|jest)\b/.test(testCommand)) {
    const base = testCommand.replace(/\s+run\b/, " run");
    return `${base} ${escaped}`;
  }
  if (/\bpytest\b/.test(testCommand)) {
    return `${testCommand} ${escaped}`;
  }
  if (/\bgo\s+test\b/.test(testCommand)) {
    return `go test -v -run . ${shellEscape(dirname4(testFile))}`;
  }
  if (/\bmocha\b/.test(testCommand)) {
    return `${testCommand} ${escaped}`;
  }
  return null;
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
  const structuredCode = getStructuredExitCode(ev);
  if (structuredCode !== null) {
    if (structuredCode === 0)
      recordTestPass(command);
    return;
  }
  const output = getToolOutput(ev);
  const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i) ?? output.match(/exited with code (\d+)/i) ?? output.match(/process exited with (\d+)/i);
  const isPass = exitCodeMatch ? Number(exitCodeMatch[1]) === 0 : false;
  if (isPass) {
    recordTestPass(command);
  }
}
function getStructuredExitCode(ev) {
  if (ev.tool_response != null && typeof ev.tool_response === "object") {
    const resp = ev.tool_response;
    if (typeof resp.exitCode === "number")
      return resp.exitCode;
    if (typeof resp.exit_code === "number")
      return resp.exit_code;
  }
  return null;
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
var planWarnedAt, GIT_COMMIT_RE, LINT_FIX_RE, TEST_CMD_RE;
var init_post_tool = __esm(() => {
  init_config();
  init_load();
  init_runner();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_convention_check();
  init_dead_import_check();
  init_duplication_check();
  init_export_check();
  init_import_check();
  init_security_check();
  init_test_file_resolver();
  init_respond();
  planWarnedAt = new Set;
  GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
  LINT_FIX_RE = /\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/;
  TEST_CMD_RE = /\b(bun\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;
});

// src/hooks/pre-tool.ts
var exports_pre_tool = {};
__export(exports_pre_tool, {
  default: () => preTool
});
import { resolve as resolve4 } from "node:path";
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
  const resolvedTarget = resolve4(targetFile);
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const isFixingPendingFile = fixes.some((f) => resolve4(f.file) === resolvedTarget);
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
  try {
    checkTaskDrift(resolvedTarget);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("process.exit"))
      throw e;
  }
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
    const taskFile = resolve4(cwd, task.file);
    if (resolvedTarget === taskFile) {
      process.stderr.write(`[qult] Plan task detected for ${task.file}. Use TaskCreate to track progress and enable Verify test execution.
`);
      return;
    }
  }
}
function checkTaskDrift(resolvedTarget) {
  const plan = getActivePlan();
  if (!plan)
    return;
  if (driftWarnedFiles.has(resolvedTarget))
    return;
  const cwd = process.cwd();
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve4(cwd, t.file)));
  if (planFiles.has(resolvedTarget))
    return;
  const relative = resolvedTarget.startsWith(cwd) ? resolvedTarget.slice(cwd.length + 1) : resolvedTarget;
  process.stderr.write(`[qult] Task drift: ${sanitizeForStderr(relative)} is not in the current plan scope.
`);
  driftWarnedFiles.add(resolvedTarget);
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
    const implFile = resolve4(cwd, task.file);
    if (resolvedTarget !== implFile)
      continue;
    const testFile = resolve4(cwd, parsed.file);
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
function hasSourceChanges(paths) {
  return paths.some((p) => {
    const ext = p.slice(p.lastIndexOf("."));
    return SOURCE_EXTS.has(ext);
  });
}
function checkBash(ev) {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
  if (!command)
    return;
  if (!GIT_COMMIT_RE2.test(command))
    return;
  const state = readSessionState();
  const changedPaths = state.changed_file_paths ?? [];
  const changedCount = changedPaths.length;
  if (!hasSourceChanges(changedPaths))
    return;
  const gates = loadGates();
  if (gates?.on_commit && Object.keys(gates.on_commit).length > 0) {
    const allCommitGatesDisabled = Object.keys(gates.on_commit).every((g) => isGateDisabled(g));
    if (!allCommitGatesDisabled && !readLastTestPass()) {
      deny("Run tests before committing. No test pass recorded since last commit.");
    }
  }
  if (changedCount > 0) {
    if (changedCount >= loadConfig().review.required_changed_files && !hasPlanFile()) {
      deny(`${changedCount} files changed without a plan. Run /qult:plan-generator before committing.`);
    }
    if (!readLastReview()) {
      if (isReviewRequired() && !isGateDisabled("review")) {
        deny("Run /qult:review before committing. Independent review is required.");
      }
    }
    if (readLastReview() && loadConfig().review.require_human_approval && !readHumanApproval()) {
      deny("Human approval required before committing. The architect must review and call record_human_approval.");
    }
  }
}
var GIT_COMMIT_RE2, driftWarnedFiles, SOURCE_EXTS;
var init_pre_tool = __esm(() => {
  init_config();
  init_load();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_respond();
  GIT_COMMIT_RE2 = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
  driftWarnedFiles = new Set;
  SOURCE_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".py",
    ".pyi",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt",
    ".php",
    ".cs",
    ".vue",
    ".svelte"
  ]);
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
  const state = readSessionState();
  const changedPaths = state.changed_file_paths ?? [];
  const hasChanges = changedPaths.length > 0;
  const hasSourceChanges2 = hasChanges && changedPaths.some((p) => {
    const ext = p.slice(p.lastIndexOf("."));
    return SOURCE_EXTS2.has(ext);
  });
  const plan = getActivePlan();
  if (plan && hasSourceChanges2) {
    const incomplete = plan.tasks.filter((t) => t.status !== "done");
    if (incomplete.length > 0) {
      const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join(`
`);
      block(`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:
${taskList}
Plan: ${plan.path}`);
    }
    const doneTasks = plan.tasks.filter((t) => t.status === "done" && t.verify?.includes(":"));
    const tracked = [];
    const untracked = [];
    for (const t of doneTasks) {
      const key = t.taskNumber != null ? `Task ${t.taskNumber}` : t.name;
      const result = readTaskVerifyResult(key);
      if (result !== null) {
        tracked.push(t);
      } else {
        untracked.push(t);
      }
    }
    if (untracked.length > 0) {
      const list = untracked.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name}`).join(`
`);
      process.stderr.write(`[qult] ${untracked.length} plan task(s) have Verify fields but were not tracked via TaskCreate:
${list}
Consider using TaskCreate for Verify test execution.
`);
    }
  }
  if (hasSourceChanges2) {
    if (!plan) {
      const changed = state.changed_file_paths.length;
      const threshold = loadConfig().review.required_changed_files;
      if (changed >= threshold) {
        block(`${changed} files changed without a plan. Run /qult:plan-generator before continuing.
` + "Large changes require a structured plan so TDD enforcement, task verification, and scope tracking can function.");
      }
    }
    if (!readLastReview()) {
      if (isReviewRequired() && !isGateDisabled("review")) {
        block("Run /qult:review before finishing. Independent review is required.");
      }
    }
  }
  if (hasSourceChanges2 && readLastReview()) {
    const config = loadConfig();
    if (config.review.require_human_approval && !readHumanApproval()) {
      block("Human approval required. The architect must review the changes and call record_human_approval before finishing.");
    }
  }
  if (readLastReview()) {
    process.stderr.write(`[qult] Review complete. Run /qult:finish for structured branch completion (merge/PR/hold/discard).
`);
  }
  const securityCount = readEscalation("security_warning_count");
  if (securityCount >= SECURITY_ESCALATION_THRESHOLD && !isGateDisabled("security-check")) {
    block(`${securityCount} security warnings emitted this session. Fix security issues before finishing.`);
  }
  const driftCount = readEscalation("drift_warning_count");
  if (driftCount >= DRIFT_ESCALATION_THRESHOLD) {
    block(`${driftCount} drift warnings emitted this session. Review scope and address drift before finishing.`);
  }
  const testQualityCount = readEscalation("test_quality_warning_count");
  if (testQualityCount >= TEST_QUALITY_ESCALATION_THRESHOLD) {
    block(`${testQualityCount} test quality warnings emitted this session. Improve test assertions before finishing.`);
  }
  const duplicationCount = readEscalation("duplication_warning_count");
  if (duplicationCount >= DUPLICATION_ESCALATION_THRESHOLD) {
    block(`${duplicationCount} duplication warnings emitted this session. Extract shared code before finishing.`);
  }
}
var SECURITY_ESCALATION_THRESHOLD = 10, SOURCE_EXTS2, DRIFT_ESCALATION_THRESHOLD = 8, TEST_QUALITY_ESCALATION_THRESHOLD = 8, DUPLICATION_ESCALATION_THRESHOLD = 8;
var init_stop = __esm(() => {
  init_config();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_respond();
  SOURCE_EXTS2 = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".py",
    ".pyi",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt",
    ".php",
    ".cs",
    ".vue",
    ".svelte"
  ]);
});

// src/state/calibration.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync14, readFileSync as readFileSync11 } from "node:fs";
import { join as join11 } from "node:path";
function calibrationPath() {
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginDataDir)
    return null;
  return join11(pluginDataDir, CALIBRATION_FILE);
}
function projectId() {
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
function readCalibration() {
  const path = calibrationPath();
  if (!path || !existsSync14(path))
    return null;
  try {
    return JSON.parse(readFileSync11(path, "utf-8"));
  } catch {
    return null;
  }
}
function recordCalibration(aggregate, stageScores) {
  const path = calibrationPath();
  if (!path)
    return;
  const data = readCalibration() ?? {
    entries: [],
    stats: { mean: 0, stddev: 0, count: 0, perfect_count: 0 }
  };
  data.entries.push({
    date: new Date().toISOString(),
    aggregate,
    stages: stageScores,
    project: projectId()
  });
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }
  const scores = data.entries.map((e) => e.aggregate);
  const count = scores.length;
  const mean = scores.reduce((s, v) => s + v, 0) / count;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);
  const perfectCount = data.entries.filter((e) => {
    const dims = Object.values(e.stages).flatMap((s) => Object.values(s));
    return dims.length > 0 && dims.every((v) => v === 5);
  }).length;
  data.stats = {
    mean: Math.round(mean * 100) / 100,
    stddev: Math.round(stddev * 100) / 100,
    count,
    perfect_count: perfectCount
  };
  atomicWriteJson(path, data);
}
function checkCalibration() {
  const data = readCalibration();
  if (!data)
    return [];
  const currentProject = projectId();
  const projectEntries = data.entries.filter((e) => !e.project || e.project === currentProject);
  if (projectEntries.length < 5)
    return [];
  const scores = projectEntries.map((e) => e.aggregate);
  const count = scores.length;
  const mean = scores.reduce((s, v) => s + v, 0) / count;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);
  const warnings = [];
  const maxObserved = Math.max(...scores, 1);
  const highMeanThreshold = maxObserved * 0.93;
  const roundedMean = Math.round(mean * 100) / 100;
  const roundedStddev = Math.round(stddev * 100) / 100;
  if (roundedMean > highMeanThreshold && roundedStddev < 1.5) {
    warnings.push({
      type: "high_mean",
      message: `Cross-session calibration: mean ${roundedMean} with σ=${roundedStddev} across ${count} reviews. Scores may be systematically inflated.`
    });
  }
  if (count >= 10 && roundedStddev < 0.8) {
    warnings.push({
      type: "low_variance",
      message: `Cross-session calibration: σ=${roundedStddev} across ${count} reviews suggests reviewers are not differentiating.`
    });
  }
  const recentEntries = projectEntries.slice(-3);
  const maxPossible = recentEntries.every((e) => {
    const dims = Object.values(e.stages).flatMap((s) => Object.values(s));
    return dims.length > 0 && dims.every((v) => v === 5);
  });
  if (maxPossible && recentEntries.length >= 3) {
    warnings.push({
      type: "perfect_streak",
      message: "Cross-session calibration: 3+ consecutive perfect scores. No code is perfect — reviewers may need recalibration."
    });
  }
  return warnings;
}
var CALIBRATION_FILE = "review-calibration.json", MAX_ENTRIES = 50;
var init_calibration = __esm(() => {
  init_atomic_write();
});

// src/hooks/subagent-stop/claim-grounding.ts
import { existsSync as existsSync15, readFileSync as readFileSync12, statSync as statSync4 } from "node:fs";
import { join as join12 } from "node:path";
function groundClaims(output, cwd) {
  try {
    const ungrounded = [];
    let total = 0;
    for (const match of output.matchAll(FINDING_FILE_RE)) {
      total++;
      const filePath2 = match[2];
      const description = match[4] ?? "";
      const absPath = join12(cwd, filePath2);
      const normalizedCwd = cwd.replace(/\/+$/, "");
      if (!absPath.startsWith(`${normalizedCwd}/`)) {
        ungrounded.push(`Path traversal rejected: ${filePath2}`);
        continue;
      }
      if (!existsSync15(absPath)) {
        ungrounded.push(`File not found: ${filePath2}`);
        continue;
      }
      let fileContent = null;
      for (const funcMatch of description.matchAll(FUNC_REF_RE)) {
        const funcName = funcMatch[1];
        if (!fileContent) {
          try {
            const size = statSync4(absPath).size;
            if (size > MAX_FILE_SIZE)
              break;
            fileContent = readFileSync12(absPath, "utf-8");
          } catch {
            break;
          }
        }
        if (!fileContent.includes(funcName)) {
          ungrounded.push(`Symbol \`${funcName}\` not found in ${filePath2}`);
        }
      }
    }
    return { total, ungrounded };
  } catch {
    return { total: 0, ungrounded: [] };
  }
}
var FINDING_FILE_RE, FUNC_REF_RE, MAX_FILE_SIZE = 500000;
var init_claim_grounding = __esm(() => {
  FINDING_FILE_RE = /\[(critical|high|medium|low)\]\s+((?:[^\s:]+\/[^\s:]+|[^\s:]+\.\w{1,5}))(?::(\d+))?\s+[—–]\s+(.+?)(?:\n|$)/gi;
  FUNC_REF_RE = /`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g;
});

// src/hooks/subagent-stop/cross-validation.ts
function crossValidate(output, stageName) {
  try {
    const contradictions = [];
    if (stageName === "Security") {
      checkSecurityContradiction(output, contradictions);
    } else if (stageName === "Spec") {
      checkSpecContradiction(output, contradictions);
    } else if (stageName === "Quality") {
      checkQualityContradiction(output, contradictions);
    }
    return { contradictions };
  } catch {
    return { contradictions: [] };
  }
}
function checkSecurityContradiction(output, contradictions) {
  if (!NO_ISSUES_RE.test(output))
    return;
  const fixes = readPendingFixes().filter((f) => f.gate === "security-check");
  if (fixes.length > 0) {
    const files = fixes.map((f) => f.file).join(", ");
    contradictions.push(`Security reviewer declared "No issues found" but security-check detector found ${fixes.length} issue(s) in: ${files}`);
  }
}
function checkSpecContradiction(output, contradictions) {
  if (!ALL_COMPLETE_RE.test(output))
    return;
  const plan = getActivePlan();
  if (plan) {
    const pending = plan.tasks.filter((t) => t.status === "pending" || t.status === "in-progress");
    if (pending.length > 0) {
      const names = pending.map((t) => t.name).join(", ");
      contradictions.push(`Spec reviewer claims all tasks complete but plan has ${pending.length} pending task(s): ${names}`);
    }
  }
  try {
    const state = readSessionState();
    const failures = state.gate_failure_counts ?? {};
    const repeatedFailures = Object.entries(failures).filter(([, count]) => count >= 3);
    if (repeatedFailures.length > 0) {
      const files = repeatedFailures.map(([key]) => key).join(", ");
      contradictions.push(`Spec reviewer claims all tasks complete but ${repeatedFailures.length} gate failure(s) with 3+ repeats: ${files}`);
    }
  } catch {}
}
function checkQualityContradiction(output, contradictions) {
  if (!NO_ISSUES_RE.test(output))
    return;
  try {
    const state = readSessionState();
    const deadImports = state.dead_import_warning_count ?? 0;
    const driftWarnings = state.drift_warning_count ?? 0;
    if (deadImports >= 3) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${deadImports} dead-import warnings`);
    }
    if (driftWarnings >= 3) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${driftWarnings} convention drift warnings`);
    }
    const testQuality = state.test_quality_warning_count ?? 0;
    if (testQuality >= 3) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${testQuality} test quality warnings`);
    }
    const duplication = state.duplication_warning_count ?? 0;
    if (duplication >= 3) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${duplication} duplication warnings`);
    }
  } catch {}
}
var NO_ISSUES_RE, ALL_COMPLETE_RE;
var init_cross_validation = __esm(() => {
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  NO_ISSUES_RE = /no issues found/i;
  ALL_COMPLETE_RE = /all tasks?\s+(?:complete|done|implemented)/i;
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
function escapeRegex2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDimensionScore(output, name) {
  const re = new RegExp(`${escapeRegex2(name)}[=:]\\s*(\\d+)`, "i");
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
function parseAdversarialScores(output) {
  const scores = parseDimensionScores(output, ADVERSARIAL_DIMENSIONS);
  if (!scores)
    return null;
  return { edgeCases: scores.EdgeCases, logicCorrectness: scores.LogicCorrectness };
}
var REVIEW_DIMENSIONS, SPEC_DIMENSIONS, QUALITY_DIMENSIONS, SECURITY_DIMENSIONS, ADVERSARIAL_DIMENSIONS;
var init_score_parsers = __esm(() => {
  REVIEW_DIMENSIONS = ["Correctness", "Design", "Security"];
  SPEC_DIMENSIONS = ["Completeness", "Accuracy"];
  QUALITY_DIMENSIONS = ["Design", "Maintainability"];
  SECURITY_DIMENSIONS = ["Vulnerability", "Hardening"];
  ADVERSARIAL_DIMENSIONS = ["EdgeCases", "LogicCorrectness"];
});

// src/hooks/subagent-stop/agent-validators.ts
import { execSync as execSync3 } from "node:child_process";
import { existsSync as existsSync16, readdirSync as readdirSync5, readFileSync as readFileSync13, statSync as statSync5 } from "node:fs";
import { join as join13 } from "node:path";
function checkReadOnlyViolation(normalized) {
  if (!READ_ONLY_REVIEWERS.has(normalized))
    return;
  try {
    const state = readSessionState();
    if (!state.last_commit_at)
      return;
    const headTime = execSync3("git log -1 --format=%aI HEAD", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (headTime && new Date(headTime) > new Date(state.last_commit_at)) {
      const commitMsg = execSync3("git log -1 --format=%s HEAD", {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      block(`${normalized} violated read-only constraint: unauthorized commit detected ("${commitMsg.slice(0, 100)}"). ` + "Reviewers must NOT commit. Revert with `git reset --soft HEAD~1` and rerun the review.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
}
async function subagentStop(ev) {
  if (ev.stop_hook_active)
    return;
  const agentType = ev.agent_type;
  const output = ev.last_assistant_message;
  if (!agentType)
    return;
  const normalized = agentType.replace(/:/g, "-");
  try {
    checkReadOnlyViolation(normalized);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
  const KNOWN_REVIEWERS = new Set([
    "qult-spec-reviewer",
    "qult-quality-reviewer",
    "qult-security-reviewer",
    "qult-adversarial-reviewer",
    "qult-plan-evaluator"
  ]);
  if (!output && KNOWN_REVIEWERS.has(normalized)) {
    block(`${normalized} returned empty output. The reviewer must produce a verdict, scores, and findings. Rerun the review.`);
  }
  if (!output)
    return;
  if (normalized === "qult-spec-reviewer") {
    validateStageReviewer(output, SPEC_PASS_RE, SPEC_FAIL_RE, parseSpecScores, "Spec");
  } else if (normalized === "qult-quality-reviewer") {
    validateStageReviewer(output, QUALITY_PASS_RE, QUALITY_FAIL_RE, parseQualityScores, "Quality");
  } else if (normalized === "qult-security-reviewer") {
    validateStageReviewer(output, SECURITY_PASS_RE, SECURITY_FAIL_RE, parseSecurityScores, "Security");
  } else if (normalized === "qult-adversarial-reviewer") {
    validateStageReviewer(output, ADVERSARIAL_PASS_RE, ADVERSARIAL_FAIL_RE, parseAdversarialScores, "Adversarial");
  } else if (normalized === "qult-plan-evaluator") {
    validatePlanEvaluator(output);
  } else if (normalized === "Plan") {
    validatePlan();
  }
}
function validatePlan() {
  try {
    const planDir = join13(process.cwd(), ".claude", "plans");
    if (!existsSync16(planDir))
      return;
    const files = readdirSync5(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync5(join13(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return;
    const content = readFileSync13(join13(planDir, files[0].name), "utf-8");
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
  const scores = scoreParser(output);
  if (!hasVerdict) {
    block(`${stageName} reviewer output must include '${stageName}: PASS' or '${stageName}: FAIL' as the first line. Rerun the review.`);
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
    try {
      const grounding = groundClaims(output, process.cwd());
      if (grounding.ungrounded.length > 0) {
        block(`${stageName}: reviewer references ungrounded claims:
${grounding.ungrounded.map((c) => `  - ${c}`).join(`
`)}
Fix references and re-run /qult:review.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("process.exit"))
        throw err;
    }
    try {
      const cv = crossValidate(output, stageName);
      if (cv.contradictions.length > 0) {
        block(`${stageName}: cross-validation contradiction(s):
${cv.contradictions.map((c) => `  - ${c}`).join(`
`)}
Reconcile findings and re-run /qult:review.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("process.exit"))
        throw err;
    }
    tryAggregateCheck();
  }
}
function tryAggregateCheck() {
  try {
    const stageScores = getStageScores();
    const completedStages = ALL_STAGES.filter((s) => stageScores[s] && typeof stageScores[s] === "object" && !Array.isArray(stageScores[s]));
    const hasAllStages = completedStages.length === ALL_STAGES.length;
    if (hasAllStages) {
      checkAggregateScore(ALL_STAGES);
    }
    if (completedStages.length === 3 && completedStages.includes("Security") && !completedStages.includes("Adversarial")) {
      process.stderr.write(`[qult] Review warning: only ${completedStages.length}/4 stages completed. Adversarial reviewer has not run yet. All 4 stages are required for a complete review. Waiting for Adversarial stage...
`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
}
function checkScoreFindingsConsistency(output, scores, stageName) {
  const criticalHighCount = (output.match(/\[(critical|high)\]/gi) ?? []).length;
  const hasFindings = FINDING_RE.test(output);
  const allScoresHigh = Object.values(scores).every((v) => v >= 4);
  const allPerfect = Object.values(scores).every((v) => v === 5);
  const hasNoIssuesDeclaration = NO_ISSUES_RE2.test(output);
  if (criticalHighCount > 0 && allScoresHigh) {
    block(`${stageName}: PASS but ${criticalHighCount} critical/high finding(s) with all scores 4+/5. Reconcile findings with scores and rerun the review.`);
  }
  const belowThreshold = Object.entries(scores).filter(([, v]) => v < 4);
  if (belowThreshold.length > 0 && !hasFindings) {
    const dims = belowThreshold.map(([name, score]) => `${name} (${score}/5)`).join(", ");
    block(`${stageName}: ${dims} scored below 4/5 but no findings cited. Low scores must include at least one [severity] file — description finding as evidence. Rerun the review with concrete findings.`);
  }
  if (allPerfect && !hasFindings && !hasNoIssuesDeclaration) {
    block(`${stageName}: all dimensions 5/5 with no findings and no explicit 'No issues found' declaration. Perfect scores require either findings or an explicit declaration. Rerun the review.`);
  }
}
function checkAggregateScore(stages) {
  try {
    const stageScores = getStageScores();
    const allScores = stages.flatMap((s) => Object.values(stageScores[s]).filter((v) => typeof v === "number" && v >= 1 && v <= 5));
    if (allScores.length !== stages.length * 2)
      return;
    const aggregate = allScores.reduce((sum, v) => sum + v, 0);
    const maxScore = allScores.length * 5;
    const config = loadConfig();
    const threshold = config.review.score_threshold;
    const maxIter = config.review.max_iterations;
    try {
      const uniqueScores = new Set(allScores);
      if (uniqueScores.size === 1) {
        process.stderr.write(`[qult] Review bias warning: all ${allScores.length} dimensions scored identically (${allScores[0]}/5). This may indicate template answers.
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
      try {
        recordCalibration(aggregate, stageScores);
        const calibrationWarnings = checkCalibration();
        for (const w of calibrationWarnings) {
          process.stderr.write(`[qult] ${w.message}
`);
        }
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
      let msg = `Review aggregate ${aggregate}/${maxScore} below threshold ${threshold}/${maxScore}. Iteration ${iterCount}/${maxIter}.`;
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
    process.stderr.write(`[qult] Max review iterations (${maxIter}) reached. Aggregate ${aggregate}/${maxScore} below threshold ${threshold}/${maxScore}. Proceeding anyway.
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
  const historyPath = join13(process.cwd(), ".qult", ".state", FINDINGS_HISTORY_FILE);
  let history = [];
  try {
    if (existsSync16(historyPath)) {
      history = JSON.parse(readFileSync13(historyPath, "utf-8"));
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
var READ_ONLY_REVIEWERS, SEVERITY_PATTERN, FINDING_RE, NO_ISSUES_RE2, SPEC_PASS_RE, SPEC_FAIL_RE, QUALITY_PASS_RE, QUALITY_FAIL_RE, SECURITY_PASS_RE, SECURITY_FAIL_RE, ADVERSARIAL_PASS_RE, ADVERSARIAL_FAIL_RE, PLAN_PASS_RE, PLAN_REVISE_RE, ALL_STAGES, FINDINGS_HISTORY_FILE = "review-findings-history.json", MAX_FINDINGS = 100, _currentFindings;
var init_agent_validators = __esm(() => {
  init_config();
  init_atomic_write();
  init_calibration();
  init_session_state();
  init_respond();
  init_claim_grounding();
  init_cross_validation();
  init_message_builders();
  init_plan_validators();
  init_score_parsers();
  READ_ONLY_REVIEWERS = new Set([
    "qult-spec-reviewer",
    "qult-quality-reviewer",
    "qult-security-reviewer",
    "qult-adversarial-reviewer",
    "qult-plan-evaluator"
  ]);
  SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
  FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
  NO_ISSUES_RE2 = /no issues found/i;
  SPEC_PASS_RE = /^Spec:\s*PASS/im;
  SPEC_FAIL_RE = /^Spec:\s*FAIL/im;
  QUALITY_PASS_RE = /^Quality:\s*PASS/im;
  QUALITY_FAIL_RE = /^Quality:\s*FAIL/im;
  SECURITY_PASS_RE = /^Security:\s*PASS/im;
  SECURITY_FAIL_RE = /^Security:\s*FAIL/im;
  ADVERSARIAL_PASS_RE = /^Adversarial:\s*PASS/im;
  ADVERSARIAL_FAIL_RE = /^Adversarial:\s*FAIL/im;
  PLAN_PASS_RE = /^Plan:\s*PASS/im;
  PLAN_REVISE_RE = /^Plan:\s*REVISE/im;
  ALL_STAGES = ["Spec", "Quality", "Security", "Adversarial"];
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
  parseAdversarialScores: () => parseAdversarialScores,
  groundClaims: () => groundClaims,
  extractFindings: () => extractFindings,
  default: () => subagentStop,
  crossValidate: () => crossValidate,
  buildReviewBlockMessage: () => buildReviewBlockMessage,
  buildPlanEvalBlockMessage: () => buildPlanEvalBlockMessage,
  PLAN_EVAL_DIMENSIONS: () => PLAN_EVAL_DIMENSIONS
});
var init_subagent_stop = __esm(() => {
  init_agent_validators();
  init_claim_grounding();
  init_cross_validation();
  init_message_builders();
  init_plan_validators();
  init_score_parsers();
});

// src/hooks/detectors/test-quality-check.ts
import { existsSync as existsSync17, readFileSync as readFileSync14 } from "node:fs";
import { resolve as resolve5 } from "node:path";
function countAssertionsOutsideSetup(code) {
  const lines = code.split(`
`);
  let inSetupBlock = false;
  let braceDepth = 0;
  let setupStartDepth = 0;
  let count = 0;
  for (const line of lines) {
    if (!inSetupBlock && SETUP_BLOCK_RE.test(line)) {
      inSetupBlock = true;
      setupStartDepth = braceDepth;
    }
    for (const ch of line) {
      if (ch === "{")
        braceDepth++;
      else if (ch === "}") {
        braceDepth--;
        if (inSetupBlock && braceDepth <= setupStartDepth) {
          inSetupBlock = false;
        }
      }
    }
    if (!inSetupBlock) {
      const matches = line.match(ASSERTION_RE);
      if (matches)
        count += matches.length;
    }
  }
  return count;
}
function analyzeTestQuality(file) {
  const cwd = resolve5(process.cwd());
  const absPath = resolve5(cwd, file);
  if (!absPath.startsWith(cwd))
    return null;
  if (!existsSync17(absPath))
    return null;
  let content;
  try {
    content = readFileSync14(absPath, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_CHECK_SIZE4)
    return null;
  const codeOnly = content.split(`
`).filter((line) => !line.trimStart().startsWith("//")).join(`
`);
  const lines = content.split(`
`);
  const testCount = (codeOnly.match(TEST_CASE_RE) ?? []).length;
  if (testCount === 0)
    return null;
  const assertionCount = countAssertionsOutsideSetup(codeOnly);
  const avgAssertions = assertionCount / testCount;
  const smells = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//"))
      continue;
    for (const { re, name } of WEAK_MATCHERS) {
      if (re.test(line)) {
        smells.push({
          type: "weak-matcher",
          line: i + 1,
          message: `Weak matcher ${name} — consider asserting a specific value`
        });
        break;
      }
    }
    if (TRIVIAL_ASSERTION_RE.test(line)) {
      smells.push({
        type: "trivial-assertion",
        line: i + 1,
        message: "Trivial assertion: comparing variable to itself"
      });
    }
    if (EMPTY_TEST_RE.test(line)) {
      smells.push({
        type: "empty-test",
        line: i + 1,
        message: "Empty test body — no assertions"
      });
    }
    if (ALWAYS_TRUE_RE.test(line)) {
      smells.push({
        type: "always-true",
        line: i + 1,
        message: "Always-true assertion — tests a literal, not computed behavior"
      });
    }
    if (CONSTANT_SELF_RE.test(line)) {
      smells.push({
        type: "constant-self",
        line: i + 1,
        message: "Constant-to-constant assertion: literal compared to itself"
      });
    }
    if (IMPL_COUPLED_RE.test(line)) {
      smells.push({
        type: "impl-coupled",
        line: i + 1,
        message: "Tests mock calls instead of behavior — consider asserting outputs"
      });
    }
  }
  const snapshotCount = (codeOnly.match(SNAPSHOT_RE) ?? []).length;
  const nonSnapshotAssertions = assertionCount - snapshotCount;
  if (snapshotCount > 0 && nonSnapshotAssertions === 0) {
    smells.push({
      type: "snapshot-only",
      line: 0,
      message: `All ${snapshotCount} assertion(s) are snapshots — add value-based assertions to verify behavior`
    });
  }
  const mockCount = (codeOnly.match(MOCK_RE) ?? []).length;
  if (mockCount > 0 && mockCount > assertionCount) {
    smells.push({
      type: "mock-overuse",
      line: 0,
      message: `Mock overuse: ${mockCount} mocks vs ${assertionCount} assertions — tests may verify mocks, not behavior`
    });
  }
  return { testCount, assertionCount, avgAssertions, smells };
}
function formatTestQualityWarnings(file, result, taskKey) {
  const warnings = [];
  const prefix = taskKey ? `${taskKey}: ` : "";
  if (result.avgAssertions < 2) {
    warnings.push(`${prefix}${file} has ~${result.avgAssertions.toFixed(1)} assertions/test (minimum 2)`);
  }
  const smellsByType = new Map;
  for (const smell of result.smells) {
    const existing = smellsByType.get(smell.type) ?? [];
    existing.push(smell);
    smellsByType.set(smell.type, existing);
  }
  for (const [type, items] of smellsByType) {
    if (items.length === 1) {
      warnings.push(`${prefix}${file}:${items[0].line}: ${items[0].message}`);
    } else {
      const lineNums = items.slice(0, 5).map((s) => s.line).filter((l) => l > 0).join(",");
      const suffix = items.length > 5 ? ` (+${items.length - 5} more)` : "";
      warnings.push(`${prefix}${file}: ${items.length}x ${type} (L${lineNums}${suffix}) — ${items[0].message}`);
    }
  }
  return warnings;
}
var MAX_CHECK_SIZE4 = 500000, ASSERTION_RE, TEST_CASE_RE, WEAK_MATCHERS, TRIVIAL_ASSERTION_RE, EMPTY_TEST_RE, MOCK_RE, ALWAYS_TRUE_RE, CONSTANT_SELF_RE, SNAPSHOT_RE, IMPL_COUPLED_RE, SETUP_BLOCK_RE;
var init_test_quality_check = __esm(() => {
  ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
  TEST_CASE_RE = /\b(it|test)\s*\(/g;
  WEAK_MATCHERS = [
    { re: /\.toBeTruthy\s*\(\s*\)/, name: "toBeTruthy()" },
    { re: /\.toBeFalsy\s*\(\s*\)/, name: "toBeFalsy()" },
    { re: /\.toBeDefined\s*\(\s*\)/, name: "toBeDefined()" },
    { re: /\.toBeUndefined\s*\(\s*\)/, name: "toBeUndefined()" },
    { re: /\.toBe\s*\(\s*true\s*\)/, name: "toBe(true)" },
    { re: /\.toBe\s*\(\s*false\s*\)/, name: "toBe(false)" }
  ];
  TRIVIAL_ASSERTION_RE = /expect\s*\(\s*(\w+)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/;
  EMPTY_TEST_RE = /\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
  MOCK_RE = /\b(?:vi\.fn|jest\.fn|vi\.spyOn|jest\.spyOn|sinon\.stub|sinon\.spy|\.mockImplementation|\.mockReturnValue|\.mockResolvedValue|mock\()\s*\(/g;
  ALWAYS_TRUE_RE = /expect\s*\(\s*(?:true|1|"[^"]*"|'[^']*'|\d+)\s*\)\s*\.(?:toBe\s*\(\s*(?:true|1)\s*\)|toBeTruthy\s*\(\s*\)|toBeDefined\s*\(\s*\))/;
  CONSTANT_SELF_RE = /expect\s*\(\s*(["'`][^"'`]*["'`]|\d+)\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/;
  SNAPSHOT_RE = /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/g;
  IMPL_COUPLED_RE = /expect\s*\(\s*\w+\s*\)\s*\.(?:toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes)\s*\(/;
  SETUP_BLOCK_RE = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(/;
});

// src/hooks/task-completed.ts
var exports_task_completed = {};
__export(exports_task_completed, {
  default: () => taskCompleted,
  checkVerifyTestQuality: () => checkVerifyTestQuality
});
import { spawnSync } from "node:child_process";
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
  const result = analyzeTestQuality(testFile);
  if (!result)
    return;
  const warnings = formatTestQualityWarnings(testFile, result, taskKey);
  if (warnings.length > 0) {
    incrementEscalation("test_quality_warning_count");
    for (const w of warnings) {
      process.stderr.write(`[qult] Test quality: ${w}
`);
    }
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
var TEST_RUNNER_RE, VERIFY_TIMEOUT = 15000, SAFE_SHELL_ARG_RE;
var init_task_completed = __esm(() => {
  init_load();
  init_plan_status();
  init_session_state();
  init_test_quality_check();
  TEST_RUNNER_RE = [
    [/\bvitest\b/, (f, t) => ["vitest", "run", f, "-t", t]],
    [/\bjest\b/, (f, t) => ["jest", f, "-t", t]],
    [/\bpytest\b/, (f, t) => ["pytest", f, "-k", t]],
    [/\bgo\s+test\b/, (f, _t) => ["go", "test", `./${f}`]],
    [/\bcargo\s+test\b/, (_f, t) => ["cargo", "test", t]],
    [/\bmocha\b/, (f, t) => ["mocha", f, "--grep", t]]
  ];
  SAFE_SHELL_ARG_RE = /^[a-zA-Z0-9_/.@-]+$/;
});

// src/state/metrics.ts
import { existsSync as existsSync18, readFileSync as readFileSync15 } from "node:fs";
import { join as join14 } from "node:path";
function recordSessionMetrics(cwd, metrics) {
  try {
    const metricsPath = join14(cwd, STATE_DIR3, METRICS_FILE);
    let history = readMetricsHistory(cwd);
    history.push(metrics);
    if (history.length > MAX_ENTRIES2) {
      history = history.slice(-MAX_ENTRIES2);
    }
    atomicWriteJson(metricsPath, history);
  } catch {}
}
function readMetricsHistory(cwd) {
  try {
    const metricsPath = join14(cwd, STATE_DIR3, METRICS_FILE);
    if (!existsSync18(metricsPath))
      return [];
    const parsed = JSON.parse(readFileSync15(metricsPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function detectRecurringPatterns(cwd) {
  try {
    const history = readMetricsHistory(cwd);
    if (history.length < 5)
      return;
    const recent = history.slice(-5);
    const gateFailSessions = recent.filter((s) => s.gate_failures > 0).length;
    if (gateFailSessions >= 4) {
      process.stderr.write(`[qult] Pattern: gate failures in ${gateFailSessions}/5 recent sessions. Consider reviewing toolchain configuration.
`);
    }
    const secWarnSessions = recent.filter((s) => s.security_warnings > 0).length;
    if (secWarnSessions >= 4) {
      process.stderr.write(`[qult] Pattern: security warnings in ${secWarnSessions}/5 recent sessions. Consider adding .claude/rules/ for security patterns.
`);
    }
  } catch {}
}
var STATE_DIR3 = ".qult/.state", METRICS_FILE = "metrics-history.json", MAX_ENTRIES2 = 50;
var init_metrics = __esm(() => {
  init_atomic_write();
});

// src/hooks/session-start.ts
var exports_session_start = {};
__export(exports_session_start, {
  default: () => sessionStart
});
import { existsSync as existsSync19, mkdirSync as mkdirSync3 } from "node:fs";
import { join as join15 } from "node:path";
async function sessionStart(ev) {
  try {
    const stateDir = join15(process.cwd(), ".qult", ".state");
    if (!existsSync19(stateDir)) {
      mkdirSync3(stateDir, { recursive: true });
    }
    cleanupStaleScopedFiles(stateDir);
    if (ev.source === "startup" || ev.source === "clear") {
      try {
        const cwd = process.cwd();
        const prevState = readSessionState();
        const gateFailures = Object.values(prevState.gate_failure_counts ?? {}).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
        if (gateFailures > 0 || (prevState.security_warning_count ?? 0) > 0 || (prevState.changed_file_paths ?? []).length > 0) {
          recordSessionMetrics(cwd, {
            session_id: ev.session_id ?? "unknown",
            timestamp: new Date().toISOString(),
            gate_failures: gateFailures,
            security_warnings: prevState.security_warning_count ?? 0,
            review_score: prevState.review_completed_at ? Array.isArray(prevState.review_score_history) ? prevState.review_score_history.slice(-1)[0] ?? null : null : null,
            files_changed: (prevState.changed_file_paths ?? []).length
          });
        }
        detectRecurringPatterns(cwd);
      } catch {}
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
  init_metrics();
  init_pending_fixes();
  init_session_state();
  init_lazy_init();
});

// src/hooks/post-compact.ts
var exports_post_compact = {};
__export(exports_post_compact, {
  default: () => postCompact
});
import { existsSync as existsSync20, readdirSync as readdirSync6, readFileSync as readFileSync16, statSync as statSync6 } from "node:fs";
import { join as join16 } from "node:path";
async function postCompact(_ev) {
  try {
    const stateDir = join16(process.cwd(), ".qult", ".state");
    if (!existsSync20(stateDir))
      return;
    const parts = [];
    const fixesPath2 = findLatestFile(stateDir, "pending-fixes");
    if (fixesPath2) {
      const fixes = safeReadJson(fixesPath2, []);
      if (fixes.length > 0) {
        parts.push(`[qult] ${fixes.length} pending fix(es):`);
        for (const fix of fixes) {
          parts.push(`  [${fix.gate}] ${fix.file}`);
          if (fix.errors?.length > 0) {
            parts.push(`    ${sanitizeForStderr(fix.errors[0].slice(0, 200))}`);
          }
        }
      }
    }
    const statePath = findLatestFile(stateDir, "session-state");
    if (statePath) {
      const state = safeReadJson(statePath, {});
      if (Object.keys(state).length > 0) {
        const summary = [];
        const gatesPath = join16(process.cwd(), ".qult", "gates.json");
        const hasGates = existsSync20(gatesPath);
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
        const secWarn = state.security_warning_count;
        if (typeof secWarn === "number" && secWarn > 0)
          summary.push(`security warnings: ${secWarn}`);
        const testQWarn = state.test_quality_warning_count;
        if (typeof testQWarn === "number" && testQWarn > 0)
          summary.push(`test quality warnings: ${testQWarn}`);
        const driftWarn = state.drift_warning_count;
        if (typeof driftWarn === "number" && driftWarn > 0)
          summary.push(`drift warnings: ${driftWarn}`);
        const deadImpWarn = state.dead_import_warning_count;
        if (typeof deadImpWarn === "number" && deadImpWarn > 0)
          summary.push(`dead import warnings: ${deadImpWarn}`);
        if (summary.length > 0) {
          parts.push(`[qult] Session: ${summary.join(", ")}`);
        }
      }
    }
    try {
      const planDir = join16(process.cwd(), ".claude", "plans");
      if (existsSync20(planDir)) {
        const planFiles = readdirSync6(planDir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, mtime: statSync6(join16(planDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
        if (planFiles.length > 0) {
          const content = readFileSync16(join16(planDir, planFiles[0].name), "utf-8");
          const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
          const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
          if (taskCount > 0) {
            parts.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
          }
        }
      }
    } catch {}
    try {
      const findingsPath = join16(stateDir, "review-findings-history.json");
      if (existsSync20(findingsPath)) {
        const findings = safeReadJson(findingsPath, []);
        if (findings.length > 0) {
          const recent = findings.slice(-5);
          parts.push("[qult] Recent review findings:");
          for (const f of recent) {
            parts.push(`  [${sanitizeForStderr(f.severity)}] ${sanitizeForStderr(f.file)} — ${sanitizeForStderr(f.description.slice(0, 150))}`);
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
    const files = readdirSync6(stateDir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).map((f) => ({
      path: join16(stateDir, f),
      mtime: statSync6(join16(stateDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}
function safeReadJson(path, fallback) {
  try {
    if (!existsSync20(path))
      return fallback;
    return JSON.parse(readFileSync16(path, "utf-8"));
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
import { join as join17 } from "node:path";
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
    input = await new Promise((resolve6, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve6(data));
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
        atomicWriteJson(join17(process.cwd(), ".qult", ".state", "latest-session.json"), {
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
