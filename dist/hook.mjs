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

// src/state/pending-fixes.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { join } from "node:path";
function setFixesSessionScope(sessionId) {
  _sessionScope = sessionId;
}
function fixesPath() {
  const file = _sessionScope ? `pending-fixes-${_sessionScope}.json` : FIXES_FILE;
  return join(process.cwd(), STATE_DIR, file);
}
function readPendingFixes() {
  if (_cache)
    return _cache;
  try {
    const path = fixesPath();
    if (!existsSync2(path)) {
      _cache = [];
      return _cache;
    }
    const raw = readFileSync(path, "utf-8");
    _cache = JSON.parse(raw);
    return _cache;
  } catch {
    _cache = [];
    return _cache;
  }
}
function writePendingFixes(fixes) {
  _cache = fixes;
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
  if (!_dirty || !_cache)
    return;
  try {
    atomicWriteJson(fixesPath(), _cache);
  } catch (e) {
    if (e instanceof Error)
      process.stderr.write(`[qult] write error: ${e.message}
`);
  }
  _dirty = false;
}
var STATE_DIR = ".qult/.state", FIXES_FILE = "pending-fixes.json", _cache = null, _dirty = false, _sessionScope = null;
var init_pending_fixes = __esm(() => {
  init_atomic_write();
});

// src/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function loadConfig() {
  if (_cache2)
    return _cache2;
  const config = structuredClone(DEFAULTS);
  try {
    const configPath = join2(process.cwd(), ".qult", "config.json");
    if (existsSync3(configPath)) {
      const raw = JSON.parse(readFileSync2(configPath, "utf-8"));
      if (raw.review) {
        if (typeof raw.review.score_threshold === "number")
          config.review.score_threshold = raw.review.score_threshold;
        if (typeof raw.review.max_iterations === "number")
          config.review.max_iterations = raw.review.max_iterations;
        if (typeof raw.review.required_changed_files === "number")
          config.review.required_changed_files = raw.review.required_changed_files;
      }
      if (raw.gates) {
        if (typeof raw.gates.output_max_chars === "number")
          config.gates.output_max_chars = raw.gates.output_max_chars;
        if (typeof raw.gates.default_timeout === "number")
          config.gates.default_timeout = raw.gates.default_timeout;
      }
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
  config.gates.output_max_chars = envInt("QULT_GATE_OUTPUT_MAX") ?? config.gates.output_max_chars;
  config.gates.default_timeout = envInt("QULT_GATE_DEFAULT_TIMEOUT") ?? config.gates.default_timeout;
  _cache2 = config;
  return config;
}
var DEFAULTS, _cache2 = null;
var init_config = __esm(() => {
  DEFAULTS = {
    review: {
      score_threshold: 12,
      max_iterations: 3,
      required_changed_files: 5
    },
    gates: {
      output_max_chars: 2000,
      default_timeout: 1e4
    }
  };
});

// src/gates/load.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function loadGates() {
  try {
    const path = join3(process.cwd(), ".qult", "gates.json");
    if (!existsSync4(path))
      return null;
    return JSON.parse(readFileSync3(path, "utf-8"));
  } catch {
    return null;
  }
}
var init_load = () => {};

// src/state/plan-status.ts
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync4, statSync } from "node:fs";
import { join as join4 } from "node:path";
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
      const status = taskMatch[3] ?? "pending";
      let verify;
      for (let j = i + 1;j < lines.length; j++) {
        const nextTrimmed = lines[j].trim();
        if (/^###?\s/.test(nextTrimmed))
          break;
        const verifyMatch = nextTrimmed.match(VERIFY_LINE_RE);
        if (verifyMatch) {
          verify = verifyMatch[1].trim();
          break;
        }
      }
      tasks.push({ name, status, taskNumber, verify });
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
  try {
    const content = readFileSync4(path, "utf-8");
    const tasks = parsePlanTasks(content);
    if (tasks.length === 0)
      return null;
    return { tasks, path };
  } catch {
    return null;
  }
}
var TASK_RE, CHECKBOX_RE, VERIFY_LINE_RE;
var init_plan_status = __esm(() => {
  TASK_RE = /^###\s+Task\s+(\d+):\s*(.+?)(?:\s*\[(done|pending|in-progress)\])?\s*$/;
  CHECKBOX_RE = /^-\s+\[([ xX])\]\s*(.+)$/;
  VERIFY_LINE_RE = /^\s*-\s*\*\*Verify\*\*:\s*(.+)$/;
});

// src/state/session-state.ts
import { existsSync as existsSync6, readFileSync as readFileSync5 } from "node:fs";
import { extname, join as join5 } from "node:path";
function setStateSessionScope(sessionId) {
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
    plan_eval_iteration: 0,
    plan_eval_score_history: [],
    plan_selfcheck_blocked_at: null
  };
}
function readSessionState() {
  if (_cache3)
    return _cache3;
  try {
    const path = filePath();
    if (!existsSync6(path)) {
      _cache3 = defaultState();
      return _cache3;
    }
    const raw = JSON.parse(readFileSync5(path, "utf-8"));
    if (!Array.isArray(raw.review_score_history) && typeof raw.review_last_aggregate === "number" && raw.review_last_aggregate > 0) {
      raw.review_score_history = [raw.review_last_aggregate];
    }
    if (!Array.isArray(raw.plan_eval_score_history) && typeof raw.plan_eval_last_aggregate === "number" && raw.plan_eval_last_aggregate > 0) {
      raw.plan_eval_score_history = [raw.plan_eval_last_aggregate];
    }
    const state = { ...defaultState(), ...raw };
    _cache3 = state;
    return state;
  } catch {
    _cache3 = defaultState();
    return _cache3;
  }
}
function writeState(state) {
  _cache3 = state;
  _dirty2 = true;
}
function flush2() {
  if (!_dirty2 || !_cache3)
    return;
  try {
    atomicWriteJson(filePath(), _cache3);
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
function countGatedFiles() {
  const state = readSessionState();
  const paths = state.changed_file_paths ?? [];
  if (paths.length === 0)
    return 0;
  const exts = getGatedExtensions();
  if (exts.size === 0)
    return 0;
  return paths.filter((p) => exts.has(extname(p).toLowerCase())).length;
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
  if (countGatedFiles() >= loadConfig().review.required_changed_files)
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
  state.plan_eval_iteration = 0;
  state.plan_eval_score_history = [];
  state.plan_selfcheck_blocked_at = null;
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
function wasPlanSelfcheckBlocked() {
  return readSessionState().plan_selfcheck_blocked_at != null;
}
function recordPlanSelfcheckBlocked() {
  const state = readSessionState();
  state.plan_selfcheck_blocked_at = new Date().toISOString();
  writeState(state);
}
var STATE_DIR2 = ".qult/.state", FILE = "session-state.json", _cache3 = null, _dirty2 = false, _sessionScope2 = null, TOOL_EXTS;
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
  init_pending_fixes();
  init_session_state();
});

// src/hooks/respond.ts
function setCurrentEvent(event) {
  _currentEvent = event;
}
function deny(reason) {
  try {
    flushAll();
  } catch {}
  process.stderr.write(reason);
  process.exit(2);
}
function block(reason) {
  try {
    flushAll();
  } catch {}
  process.stderr.write(reason);
  process.exit(2);
}
var _currentEvent = "unknown";
var init_respond = __esm(() => {
  init_flush();
});

// src/gates/runner.ts
import { execSync } from "node:child_process";
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
    const e = err;
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const output = smartTruncate(stdout + stderr, maxChars) || `Exit code ${e.status ?? 1}`;
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
import { extname as extname2, resolve } from "node:path";
function isTestCommand(command, gates) {
  if (gates?.on_commit) {
    for (const gate of Object.values(gates.on_commit)) {
      if (command.includes(gate.command)) {
        return true;
      }
    }
    return false;
  }
  return TEST_CMD_RE.test(command);
}
async function postTool(ev) {
  const tool = ev.tool_name;
  if (!tool)
    return;
  if (tool === "Edit" || tool === "Write") {
    handleEditWrite(ev);
  } else if (tool === "Bash") {
    handleBash(ev);
  }
}
function handleEditWrite(ev) {
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
  const fileExt = extname2(file).toLowerCase();
  const gatedExts = getGatedExtensions();
  const newFixes = [];
  const messages = [];
  const sessionId = ev.session_id;
  for (const [name, gate] of Object.entries(gates.on_write)) {
    try {
      if (gate.run_once_per_batch && sessionId && shouldSkipGate(name, sessionId)) {
        continue;
      }
      const hasPlaceholder = gate.command.includes("{file}");
      if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt)) {
        continue;
      }
      const result = runGate(name, gate, hasPlaceholder ? file : undefined);
      if (gate.run_once_per_batch && sessionId) {
        markGateRan(name, sessionId);
      }
      if (!result.passed) {
        newFixes.push({ file, errors: [result.output], gate: name });
        messages.push(`[${name}] ${result.output.slice(0, 200)}`);
      }
    } catch {}
  }
  if (newFixes.length > 0) {
    addPendingFixes(file, newFixes);
  } else {
    clearPendingFixesForFile(file);
  }
  try {
    recordChangedFile(file);
  } catch {}
}
function handleBash(ev) {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
  if (!command)
    return;
  if (/\bgit\s+commit\b/.test(command)) {
    clearOnCommit();
    const gates2 = loadGates();
    if (!gates2?.on_commit)
      return;
    const messages = [];
    for (const [name, gate] of Object.entries(gates2.on_commit)) {
      try {
        const result = runGate(name, gate);
        if (!result.passed) {
          messages.push(`[${name}] ${result.output.slice(0, 200)}`);
        }
      } catch {}
    }
    return;
  }
  if (/\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/.test(command)) {
    revalidatePendingFixes();
  }
  const gates = loadGates();
  if (isTestCommand(command, gates)) {
    const output = getToolOutput(ev);
    const exitCodeMatch = output.match(/exit code (\d+)/i) ?? output.match(/exited with (\d+)/i);
    const isError = exitCodeMatch ? Number(exitCodeMatch[1]) !== 0 : false;
    if (!isError) {
      recordTestPass(command);
    }
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
function revalidatePendingFixes() {
  try {
    const fixes = readPendingFixes();
    if (fixes.length === 0)
      return;
    const gates = loadGates();
    if (!gates?.on_write)
      return;
    const remaining = fixes.filter((fix) => {
      for (const [name, gate] of Object.entries(gates.on_write)) {
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
var TEST_CMD_RE;
var init_post_tool = __esm(() => {
  init_load();
  init_runner();
  init_pending_fixes();
  init_session_state();
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
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const resolvedTarget = resolve2(targetFile);
    const isFixingPendingFile = fixes.some((f) => resolve2(f.file) === resolvedTarget);
    if (!isFixingPendingFile) {
      const fileList = fixes.map((f) => `  ${f.file}: ${f.errors[0]?.slice(0, 100) ?? "error"}`).join(`
`);
      deny(`Fix existing errors before editing other files:
${fileList}`);
    }
  }
}
function checkBash(ev) {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
  if (!command)
    return;
  if (!GIT_COMMIT_RE.test(command))
    return;
  const gates = loadGates();
  if (!gates)
    return;
  if (gates.on_commit && Object.keys(gates.on_commit).length > 0) {
    if (!readLastTestPass()) {
      deny("Run tests before committing. No test pass recorded since last commit.");
    }
  }
  if (!readLastReview()) {
    if (isReviewRequired()) {
      deny("Run /qult:review before committing. Independent review is required.");
    }
  }
}
var GIT_COMMIT_RE;
var init_pre_tool = __esm(() => {
  init_load();
  init_pending_fixes();
  init_session_state();
  init_respond();
  GIT_COMMIT_RE = /\bgit\s+commit\b/;
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
  }
  if (!readLastReview()) {
    if (isReviewRequired()) {
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

// src/hooks/subagent-stop.ts
var exports_subagent_stop = {};
__export(exports_subagent_stop, {
  validatePlanStructure: () => validatePlanStructure,
  validatePlanHeuristics: () => validatePlanHeuristics,
  parseScores: () => parseScores,
  parseDimensionScores: () => parseDimensionScores,
  default: () => subagentStop,
  buildReviewBlockMessage: () => buildReviewBlockMessage,
  buildPlanEvalBlockMessage: () => buildPlanEvalBlockMessage
});
function parseScores(output) {
  for (const re of [SCORE_STRICT_RE, SCORE_COLON_RE, SCORE_LOOSE_RE]) {
    const m = re.exec(output);
    if (m) {
      return {
        correctness: Number.parseInt(m[1], 10),
        design: Number.parseInt(m[2], 10),
        security: Number.parseInt(m[3], 10)
      };
    }
  }
  return null;
}
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
function parseDimensionScores(output, dimensions) {
  const strictPattern = dimensions.map((d) => `${d}=(\\d)`).join("\\s+");
  const strictRe = new RegExp(`Score:\\s*${strictPattern}`, "i");
  const colonParts = dimensions.map((d) => `${d}[=:]\\s*(\\d)`).join(".*?");
  const colonRe = new RegExp(colonParts, "i");
  for (const re of [strictRe, colonRe]) {
    const m = re.exec(output);
    if (m) {
      const result = {};
      for (let i = 0;i < dimensions.length; i++) {
        result[dimensions[i]] = Number.parseInt(m[i + 1], 10);
      }
      return result;
    }
  }
  return null;
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
  const tasksSection = content.slice(content.search(/^## Tasks/m));
  const firstNewline = tasksSection.indexOf(`
`);
  const nextSection = firstNewline >= 0 ? tasksSection.slice(firstNewline).search(/^## /m) : -1;
  const tasksContent = nextSection >= 0 ? tasksSection.slice(0, firstNewline + nextSection) : tasksSection;
  const taskHeaders = [...tasksContent.matchAll(/^### Task (\d+):.*$/gm)];
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
  if (!/^## Tasks/m.test(content))
    return warnings;
  const tasksSection = content.slice(content.search(/^## Tasks/m));
  const firstNewline = tasksSection.indexOf(`
`);
  const nextSection = firstNewline >= 0 ? tasksSection.slice(firstNewline).search(/^## /m) : -1;
  const tasksContent = nextSection >= 0 ? tasksSection.slice(0, firstNewline + nextSection) : tasksSection;
  const taskHeaders = [...tasksContent.matchAll(/^### Task (\d+):.*$/gm)];
  const taskBlocks = [];
  for (let i = 0;i < taskHeaders.length; i++) {
    const start = taskHeaders[i].index;
    const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1].index : tasksContent.length;
    taskBlocks.push({ num: taskHeaders[i][1], block: tasksContent.slice(start, end) });
  }
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
        if (words.length < 6) {
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
    if (fileMatch) {
      const fileValue = fileMatch[1];
      for (const registry of REGISTRY_FILES) {
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
async function subagentStop(ev) {
  if (ev.stop_hook_active)
    return;
  const agentType = ev.agent_type;
  const output = ev.last_assistant_message;
  if (!agentType || !output)
    return;
  if (agentType === "qult-reviewer") {
    validateReviewer(output);
    const passed = REVIEW_PASS_RE.test(output);
    const failed = REVIEW_FAIL_RE.test(output);
    if (failed) {
      block("Review: FAIL. Fix the issues found by the reviewer and run /qult:review again.");
    }
    const scores = parseScores(output);
    if (passed && scores) {
      const aggregate = scores.correctness + scores.design + scores.security;
      const config = loadConfig();
      const threshold = config.review.score_threshold;
      const maxIter = config.review.max_iterations;
      try {
        recordReviewIteration(aggregate);
      } catch {}
      const iterCount = getReviewIteration();
      const history = getReviewScoreHistory();
      if (aggregate < threshold && iterCount < maxIter) {
        block(buildReviewBlockMessage(scores, history, aggregate, threshold, iterCount, maxIter));
      }
    }
    resetReviewIteration();
    recordReview();
  } else if (agentType === "qult-plan-evaluator") {
    validatePlanEvaluator(output);
  } else if (agentType === "Plan") {
    validatePlan();
  }
}
function validatePlan() {
  try {
    const { existsSync: existsSync8, readdirSync: readdirSync3, readFileSync: readFileSync6, statSync: statSync3 } = __require("node:fs");
    const { join: join7 } = __require("node:path");
    const planDir = join7(process.cwd(), ".claude", "plans");
    if (!existsSync8(planDir))
      return;
    const files = readdirSync3(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync3(join7(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return;
    const content = readFileSync6(join7(planDir, files[0].name), "utf-8");
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
    const threshold = DEFAULT_PLAN_EVAL_SCORE_THRESHOLD;
    const maxIter = DEFAULT_MAX_PLAN_EVAL_ITERATIONS;
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
function validateReviewer(output) {
  const hasVerdict = REVIEW_PASS_RE.test(output) || REVIEW_FAIL_RE.test(output);
  const hasFindings = FINDING_RE.test(output) || NO_ISSUES_RE.test(output);
  const hasScore = parseScores(output) !== null;
  if (hasFindings)
    return;
  if (hasVerdict && hasScore)
    return;
  block("Reviewer output must include: (1) 'Review: PASS' or 'Review: FAIL', (2) 'Score: Correctness=N Design=N Security=N', and (3) findings ([severity] file:line) or 'No issues found'. Rerun the review.");
}
var SEVERITY_PATTERN, FINDING_RE, NO_ISSUES_RE, REVIEW_PASS_RE, REVIEW_FAIL_RE, SCORE_STRICT_RE, SCORE_COLON_RE, SCORE_LOOSE_RE, DEFAULT_PLAN_EVAL_SCORE_THRESHOLD = 10, DEFAULT_MAX_PLAN_EVAL_ITERATIONS = 2, PLAN_PASS_RE, PLAN_REVISE_RE, TASK_HEADER_G, FIELD_RES, VAGUE_VERBS_RE, VERIFY_FORMAT_RE, REGISTRY_FILES, PLAN_EVAL_DIMENSIONS;
var init_subagent_stop = __esm(() => {
  init_config();
  init_session_state();
  init_respond();
  SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
  FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
  NO_ISSUES_RE = /no issues found/i;
  REVIEW_PASS_RE = /^Review:\s*PASS/im;
  REVIEW_FAIL_RE = /^Review:\s*FAIL/im;
  SCORE_STRICT_RE = /Score:\s*Correctness=(\d)\s+Design=(\d)\s+Security=(\d)/i;
  SCORE_COLON_RE = /Correctness[=:]\s*(\d).*?Design[=:]\s*(\d).*?Security[=:]\s*(\d)/i;
  SCORE_LOOSE_RE = /Score:.*?[=:]\s*(\d).*?[=:]\s*(\d).*?[=:]\s*(\d)/i;
  PLAN_PASS_RE = /^Plan:\s*PASS/im;
  PLAN_REVISE_RE = /^Plan:\s*REVISE/im;
  TASK_HEADER_G = /^### Task \d+:/gm;
  FIELD_RES = {
    File: /^\s*-\s*\*\*File\*\*/m,
    Change: /^\s*-\s*\*\*Change\*\*/m,
    Boundary: /^\s*-\s*\*\*Boundary\*\*/m,
    Verify: /^\s*-\s*\*\*Verify\*\*/m
  };
  VAGUE_VERBS_RE = /^(improve|update|fix|refactor|clean\s*up|enhance|optimize|modify|adjust|change)\b/i;
  VERIFY_FORMAT_RE = /\S+\.\w+:\S+/;
  REGISTRY_FILES = ["init.ts", "types.ts", "session-state.ts"];
  PLAN_EVAL_DIMENSIONS = ["Feasibility", "Completeness", "Clarity"];
});

// src/hooks/task-completed.ts
var exports_task_completed = {};
__export(exports_task_completed, {
  default: () => taskCompleted
});
import { execSync as execSync2 } from "node:child_process";
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
  const cmdBuilder = detectTestRunner();
  if (!cmdBuilder)
    return;
  const command = cmdBuilder(parsed.file, parsed.testName);
  try {
    execSync2(command, {
      cwd: process.cwd(),
      timeout: VERIFY_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`
      },
      encoding: "utf-8"
    });
  } catch {}
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
  TEST_RUNNER_RE = [
    [/\bvitest\b/, (f, t) => `vitest run ${f} -t "${t}"`],
    [/\bjest\b/, (f, t) => `jest ${f} -t "${t}"`],
    [/\bpytest\b/, (f, t) => `pytest ${f} -k "${t}"`],
    [/\bgo\s+test\b/, (f, _t) => `go test ./${f}`],
    [/\bcargo\s+test\b/, (_f, t) => `cargo test ${t}`],
    [/\bmocha\b/, (f, t) => `mocha ${f} --grep "${t}"`]
  ];
  SAFE_SHELL_ARG_RE = /^[a-zA-Z0-9_/.\-:]+$/;
});

// src/hooks/dispatcher.ts
init_flush();
init_pending_fixes();
init_session_state();

// src/hooks/lazy-init.ts
init_pending_fixes();
import { existsSync as existsSync7, mkdirSync as mkdirSync2, readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join6 } from "node:path";
var STALE_MS = 24 * 60 * 60 * 1000;
var SCOPED_FILE_RE = /^(session-state|pending-fixes)-.+\.json$/;
var _initialized = false;
function lazyInit() {
  if (_initialized)
    return;
  _initialized = true;
  try {
    const stateDir = join6(process.cwd(), ".qult", ".state");
    if (!existsSync7(stateDir)) {
      mkdirSync2(stateDir, { recursive: true });
    }
    cleanupStaleScopedFiles(stateDir);
    writePendingFixes([]);
  } catch {}
}
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

// src/hooks/dispatcher.ts
init_respond();
var EVENT_MAP = {
  "post-tool": () => Promise.resolve().then(() => (init_post_tool(), exports_post_tool)),
  "pre-tool": () => Promise.resolve().then(() => (init_pre_tool(), exports_pre_tool)),
  stop: () => Promise.resolve().then(() => (init_stop(), exports_stop)),
  "subagent-stop": () => Promise.resolve().then(() => (init_subagent_stop(), exports_subagent_stop)),
  "task-completed": () => Promise.resolve().then(() => (init_task_completed(), exports_task_completed))
};
async function dispatch(event) {
  const loader = EVENT_MAP[event];
  if (!loader) {
    process.stderr.write(`Unknown hook event: ${event}
`);
    process.exit(1);
  }
  let input;
  try {
    input = await Bun.stdin.text();
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
