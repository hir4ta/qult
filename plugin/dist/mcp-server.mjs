// @bun
var __require = import.meta.require;

// src/mcp-server.ts
import { resolve as resolve6 } from "path";
import { createInterface } from "readline";

// src/config.ts
import { existsSync, readFileSync } from "fs";

// src/state/paths.ts
import { realpathSync } from "fs";
import { resolve } from "path";
var RESERVED_SPEC_NAMES = new Set(["archive"]);
var WAVE_NUM_MIN = 1;
var WAVE_NUM_MAX = 99;
var SPEC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
var projectRootOverride = null;
function setProjectRoot(root) {
  projectRootOverride = root;
}
function getProjectRoot() {
  return projectRootOverride ?? process.cwd();
}
function qultDir() {
  return resolve(getProjectRoot(), ".qult");
}
function specsDir() {
  return resolve(qultDir(), "specs");
}
function archiveDir() {
  return resolve(specsDir(), "archive");
}
function specDir(name) {
  assertValidSpecName(name);
  return resolve(specsDir(), name);
}
function requirementsPath(name) {
  return resolve(specDir(name), "requirements.md");
}
function designPath(name) {
  return resolve(specDir(name), "design.md");
}
function tasksPath(name) {
  return resolve(specDir(name), "tasks.md");
}
function wavesDir(name) {
  return resolve(specDir(name), "waves");
}
function wavePath(name, waveNum) {
  assertValidWaveNum(waveNum);
  return resolve(wavesDir(name), `wave-${formatWaveNum(waveNum)}.md`);
}
function formatWaveNum(waveNum) {
  assertValidWaveNum(waveNum);
  return String(waveNum).padStart(2, "0");
}
function stateDir() {
  return resolve(qultDir(), "state");
}
function currentJsonPath() {
  return resolve(stateDir(), "current.json");
}
function pendingFixesJsonPath() {
  return resolve(stateDir(), "pending-fixes.json");
}
function stageScoresJsonPath() {
  return resolve(stateDir(), "stage-scores.json");
}
function configJsonPath() {
  return resolve(qultDir(), "config.json");
}
function assertValidSpecName(name) {
  if (typeof name !== "string" || !SPEC_NAME_RE.test(name)) {
    throw new Error(`invalid spec name: ${JSON.stringify(name)} (must match ${SPEC_NAME_RE} and be \u226464 chars)`);
  }
  if (RESERVED_SPEC_NAMES.has(name)) {
    throw new Error(`reserved spec name: ${JSON.stringify(name)}`);
  }
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`spec name must not contain path separators or leading dot: ${name}`);
  }
}
function assertValidWaveNum(waveNum) {
  if (!Number.isInteger(waveNum) || waveNum < WAVE_NUM_MIN || waveNum > WAVE_NUM_MAX) {
    throw new Error(`invalid wave_num: ${waveNum} (must be integer in [${WAVE_NUM_MIN}, ${WAVE_NUM_MAX}])`);
  }
}
function assertConfinedToQult(targetPath) {
  const resolved = resolve(targetPath);
  const qultRealPath = resolveExistingAncestor(qultDir());
  const targetRealPath = resolveExistingAncestor(resolved);
  if (targetRealPath !== qultRealPath && !targetRealPath.startsWith(`${qultRealPath}/`)) {
    throw new Error(`path escape detected: ${targetPath} resolves to ${targetRealPath}, outside ${qultRealPath}`);
  }
  return resolved;
}
function resolveExistingAncestor(absPath) {
  let current = absPath;
  for (let i = 0;i < 64; i++) {
    try {
      return realpathSync(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
  throw new Error(`unable to resolve real path for ${absPath} (parent chain exhausted)`);
}

// src/config.ts
var DEFAULTS = {
  review: {
    score_threshold: 30,
    max_iterations: 3,
    required_changed_files: 5,
    dimension_floor: 4,
    require_human_approval: false,
    low_only_passes: false,
    models: {
      spec: "sonnet",
      quality: "sonnet",
      security: "opus",
      adversarial: "opus"
    }
  },
  plan_eval: {
    score_threshold: 12,
    max_iterations: 2,
    registry_files: [],
    models: {
      generator: "sonnet",
      evaluator: "opus"
    }
  },
  gates: {
    output_max_chars: 3500,
    default_timeout: 1e4,
    extra_path: [],
    coverage_threshold: 0,
    import_graph_depth: 1
  },
  security: {
    require_semgrep: true
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
    if (typeof r.low_only_passes === "boolean")
      config.review.low_only_passes = r.low_only_passes;
    if (r.models && typeof r.models === "object") {
      const m = r.models;
      if (typeof m.spec === "string" && m.spec)
        config.review.models.spec = m.spec;
      if (typeof m.quality === "string" && m.quality)
        config.review.models.quality = m.quality;
      if (typeof m.security === "string" && m.security)
        config.review.models.security = m.security;
      if (typeof m.adversarial === "string" && m.adversarial)
        config.review.models.adversarial = m.adversarial;
    }
  }
  if (raw.plan_eval && typeof raw.plan_eval === "object") {
    const p = raw.plan_eval;
    if (typeof p.score_threshold === "number")
      config.plan_eval.score_threshold = p.score_threshold;
    if (typeof p.max_iterations === "number")
      config.plan_eval.max_iterations = p.max_iterations;
    if (Array.isArray(p.registry_files))
      config.plan_eval.registry_files = p.registry_files.filter((f) => typeof f === "string");
    if (p.models && typeof p.models === "object") {
      const m = p.models;
      if (typeof m.generator === "string" && m.generator)
        config.plan_eval.models.generator = m.generator;
      if (typeof m.evaluator === "string" && m.evaluator)
        config.plan_eval.models.evaluator = m.evaluator;
    }
  }
  if (raw.gates && typeof raw.gates === "object") {
    const g = raw.gates;
    if (typeof g.output_max_chars === "number")
      config.gates.output_max_chars = g.output_max_chars;
    if (typeof g.default_timeout === "number")
      config.gates.default_timeout = g.default_timeout;
    if (Array.isArray(g.extra_path))
      config.gates.extra_path = g.extra_path.filter((p) => typeof p === "string" && p.trim().length > 0);
    if (typeof g.coverage_threshold === "number")
      config.gates.coverage_threshold = Math.max(0, Math.min(100, g.coverage_threshold));
    if (typeof g.import_graph_depth === "number")
      config.gates.import_graph_depth = Math.max(1, Math.min(3, g.import_graph_depth));
  }
  if (raw.security && typeof raw.security === "object") {
    const s = raw.security;
    if (typeof s.require_semgrep === "boolean")
      config.security.require_semgrep = s.require_semgrep;
  }
}
function readConfigJson() {
  try {
    const path = configJsonPath();
    if (!existsSync(path))
      return {};
    const txt = readFileSync(path, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
var _cache = null;
function loadConfig() {
  if (_cache)
    return _cache;
  const config = structuredClone(DEFAULTS);
  const raw = readConfigJson();
  if (Object.keys(raw).length > 0) {
    applyConfigLayer(config, raw);
  }
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
  const lowOnlyPassesEnv = process.env.QULT_REVIEW_LOW_ONLY_PASSES;
  if (lowOnlyPassesEnv === "1" || lowOnlyPassesEnv === "true")
    config.review.low_only_passes = true;
  else if (lowOnlyPassesEnv === "0" || lowOnlyPassesEnv === "false")
    config.review.low_only_passes = false;
  const covThreshold = envInt("QULT_COVERAGE_THRESHOLD");
  if (covThreshold !== undefined)
    config.gates.coverage_threshold = Math.max(0, Math.min(100, covThreshold));
  const igDepth = envInt("QULT_IMPORT_GRAPH_DEPTH");
  if (igDepth !== undefined)
    config.gates.import_graph_depth = Math.max(1, Math.min(3, igDepth));
  const requireSemgrepEnv = process.env.QULT_REQUIRE_SEMGREP;
  if (requireSemgrepEnv === "1" || requireSemgrepEnv === "true")
    config.security.require_semgrep = true;
  else if (requireSemgrepEnv === "0" || requireSemgrepEnv === "false")
    config.security.require_semgrep = false;
  const envStr = (key) => {
    const val = process.env[key];
    return val?.trim() ? val.trim() : undefined;
  };
  config.review.models.spec = envStr("QULT_REVIEW_MODEL_SPEC") ?? config.review.models.spec;
  config.review.models.quality = envStr("QULT_REVIEW_MODEL_QUALITY") ?? config.review.models.quality;
  config.review.models.security = envStr("QULT_REVIEW_MODEL_SECURITY") ?? config.review.models.security;
  config.review.models.adversarial = envStr("QULT_REVIEW_MODEL_ADVERSARIAL") ?? config.review.models.adversarial;
  config.plan_eval.models.generator = envStr("QULT_PLAN_EVAL_MODEL_GENERATOR") ?? config.plan_eval.models.generator;
  config.plan_eval.models.evaluator = envStr("QULT_PLAN_EVAL_MODEL_EVALUATOR") ?? config.plan_eval.models.evaluator;
  _cache = config;
  return config;
}
function resetConfigCache() {
  _cache = null;
}
function setConfigKey(key, value) {
  const parts = key.split(".");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`unsupported config key depth: ${key}`);
  }
  const raw = readConfigJson();
  const top = parts[0];
  if (!raw[top] || typeof raw[top] !== "object" || Array.isArray(raw[top])) {
    raw[top] = {};
  }
  if (parts.length === 2) {
    raw[top][parts[1]] = value;
  } else {
    const sub = parts[1];
    const topObj = raw[top];
    if (!topObj[sub] || typeof topObj[sub] !== "object" || Array.isArray(topObj[sub])) {
      topObj[sub] = {};
    }
    topObj[sub][parts[2]] = value;
  }
  const path = configJsonPath();
  const { mkdirSync, writeFileSync, renameSync } = __require("fs");
  mkdirSync(path.replace(/\/[^/]+$/u, ""), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}
`, "utf8");
  renameSync(tmp, path);
}

// src/hooks/detectors/health-score.ts
import { existsSync as existsSync6 } from "fs";

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { extname } from "path";

// src/state/gate-state.ts
import { resolve as resolve2 } from "path";

// src/state/fs.ts
import { mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
var MAX_READ_BYTES = 1024 * 1024;
function ensureDir(absPath) {
  mkdirSync(absPath, { recursive: true });
}
function atomicWrite(targetPath, content) {
  assertConfinedToQult(targetPath);
  ensureDir(dirname(targetPath));
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 420 });
  renameSync(tmp, targetPath);
}
function readTextIfExists(absPath) {
  assertConfinedToQult(absPath);
  try {
    const buf = readFileSync2(absPath);
    if (buf.byteLength > MAX_READ_BYTES) {
      throw new Error(`file too large: ${absPath} (${buf.byteLength} bytes > ${MAX_READ_BYTES})`);
    }
    return buf.toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return null;
    throw err;
  }
}
function readText(absPath) {
  const txt = readTextIfExists(absPath);
  if (txt === null)
    throw new Error(`file not found: ${absPath}`);
  return txt;
}
function readJson(absPath, expectedVersion) {
  const txt = readTextIfExists(absPath);
  if (txt === null)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (err) {
    throw new Error(`malformed JSON in ${absPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.schema_version !== "number") {
    throw new Error(`missing or invalid schema_version in ${absPath}`);
  }
  const version = parsed.schema_version;
  if (version !== expectedVersion) {
    throw new Error(`schema_version mismatch in ${absPath}: expected ${expectedVersion}, got ${version}`);
  }
  return parsed;
}
function writeJson(absPath, value) {
  atomicWrite(absPath, `${JSON.stringify(value, null, 2)}
`);
}

// src/state/gate-state.ts
var SCHEMA_VERSION = 1;
var DEFAULT_STATE = { schema_version: SCHEMA_VERSION, disabled: [] };
function gatesJsonPath() {
  return resolve2(qultDir(), "state", "gates.json");
}
function readGateState() {
  const got = readJson(gatesJsonPath(), SCHEMA_VERSION);
  return got ?? structuredClone(DEFAULT_STATE);
}
function isGateDisabled(gateName) {
  try {
    return readGateState().disabled.some((g) => g.gate === gateName);
  } catch {
    return false;
  }
}
function disableGate(gateName, reason, now = new Date().toISOString()) {
  const cur = readGateState();
  const idx = cur.disabled.findIndex((g) => g.gate === gateName);
  if (idx >= 0) {
    cur.disabled[idx] = { gate: gateName, reason, disabled_at: now };
  } else {
    cur.disabled.push({ gate: gateName, reason, disabled_at: now });
  }
  writeJson(gatesJsonPath(), cur);
  return cur;
}
function enableGate(gateName) {
  const cur = readGateState();
  const next = {
    schema_version: SCHEMA_VERSION,
    disabled: cur.disabled.filter((g) => g.gate !== gateName)
  };
  writeJson(gatesJsonPath(), next);
  return next;
}
function listDisabledGateNames() {
  return readGateState().disabled.map((g) => g.gate);
}

// src/hooks/sanitize.ts
function sanitizeForStderr(input) {
  const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// src/hooks/detectors/dead-import-check.ts
var TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var PY_EXTS = new Set([".py", ".pyi"]);
var MAX_CHECK_SIZE = 500000;
var DEFAULT_IMPORT_RE = /^\s*import\s+(\w+)\s+from\s+["']/;
var NAMED_IMPORT_RE = /^\s*import\s*\{([^}]+)\}\s*from\s+["']/;
var NAMESPACE_IMPORT_RE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+["']/;
var SIDE_EFFECT_RE = /^\s*import\s+["']/;
var REEXPORT_RE = /^\s*export\s+\{[^}]*\}\s+from\s+["']/;
var TYPE_IMPORT_RE = /^\s*import\s+type\s+\{([^}]+)\}\s*from\s+["']/;
var PY_FROM_IMPORT_RE = /^\s*from\s+\S+\s+import\s+(.+)/;
var PY_IMPORT_RE = /^\s*import\s+(.+)/;
function detectDeadImports(file) {
  if (isGateDisabled("dead-import-check"))
    return [];
  const ext = extname(file).toLowerCase();
  if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext))
    return [];
  if (!existsSync2(file))
    return [];
  let content;
  try {
    content = readFileSync3(file, "utf-8");
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
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ")).map((line) => line.replace(/\/\/.*$/, "")).join(`
`).replace(/\/\*[\s\S]*?\*\//g, "");
  const warnings = [];
  for (const { name, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" \u2014 consider removing`));
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
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ") && !line.trimStart().startsWith("from ")).map((line) => line.replace(/#.*$/, "")).join(`
`);
  const warnings = [];
  for (const { name, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" \u2014 consider removing`));
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

// src/hooks/detectors/export-check.ts
import { execSync } from "child_process";
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
import { extname as extname2 } from "path";
var TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
var FUNC_SIG_RE = /\bexport\s+(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
function detectExportBreakingChanges(file) {
  if (isGateDisabled("export-check"))
    return [];
  const ext = extname2(file).toLowerCase();
  if (!TS_JS_EXTS2.has(ext))
    return [];
  if (!existsSync3(file))
    return [];
  let oldContent;
  try {
    const cwd = process.cwd();
    if (!file.startsWith(`${cwd}/`) && file !== cwd)
      return [];
    const relPath = file.slice(cwd.length + 1);
    oldContent = execSync(`git show HEAD:${relPath}`, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return [];
  }
  const newContent = readFileSync4(file, "utf-8");
  const oldExports = new Set;
  for (const match of oldContent.matchAll(EXPORT_RE)) {
    oldExports.add(match[1]);
  }
  const newExports = new Set;
  for (const match of newContent.matchAll(EXPORT_RE)) {
    newExports.add(match[1]);
  }
  const removed = [...oldExports].filter((name) => !newExports.has(name));
  const oldSigs = new Map;
  for (const match of oldContent.matchAll(FUNC_SIG_RE)) {
    const params = match[2].trim();
    oldSigs.set(match[1], params ? params.split(",").length : 0);
  }
  const signatureChanges = [];
  for (const match of newContent.matchAll(FUNC_SIG_RE)) {
    const name = match[1];
    const newParamCount = match[2].trim() ? match[2].trim().split(",").length : 0;
    const oldParamCount = oldSigs.get(name);
    if (oldParamCount !== undefined && oldParamCount !== newParamCount) {
      signatureChanges.push(`Signature change: "${sanitizeForStderr(name)}" params ${oldParamCount}\u2192${newParamCount}. Consumers may break.`);
    }
  }
  const typeChanges = detectTypeFieldChanges(oldContent, newContent);
  const errors = [
    ...removed.map((name) => `Breaking change: export "${sanitizeForStderr(name)}" was removed`),
    ...signatureChanges,
    ...typeChanges
  ];
  if (errors.length === 0)
    return [];
  return [{ file, errors, gate: "export-check" }];
}
function detectTypeFieldChanges(oldContent, newContent) {
  const TYPE_DEF_RE = /\bexport\s+(?:type|interface)\s+(\w+)\s*(?:=\s*)?{([^}]*)}/g;
  const countFields = (body) => body.split(/[;\n]/).map((s) => s.trim()).filter((s) => s && !s.startsWith("//")).length;
  const oldTypes = new Map;
  for (const m of oldContent.matchAll(TYPE_DEF_RE)) {
    oldTypes.set(m[1], countFields(m[2]));
  }
  const changes = [];
  for (const m of newContent.matchAll(TYPE_DEF_RE)) {
    const name = m[1];
    const newFields = countFields(m[2]);
    const oldFields = oldTypes.get(name);
    if (oldFields !== undefined && oldFields !== newFields) {
      changes.push(`Type change: "${sanitizeForStderr(name)}" fields ${oldFields}\u2192${newFields}. Consumers may need updates.`);
    }
  }
  return changes;
}

// src/hooks/detectors/security-check.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "fs";
import { basename, extname as extname3 } from "path";
var CHECKABLE_EXTS = new Set([
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
var MAX_CHECK_SIZE2 = 500000;
var SECRET_PATTERNS = [
  { re: /(?:AKIA|ASIA)[A-Z0-9]{16,}/, desc: "AWS access key" },
  { re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/, desc: "GitHub token" },
  { re: /xox[bpas]-[A-Za-z0-9-]{10,}/, desc: "Slack token" },
  { re: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}/, desc: "Stripe key" },
  { re: /AIzaSy[A-Za-z0-9_-]{33}/, desc: "Google API key" },
  { re: /\bSK[0-9a-fA-F]{32}\b/, desc: "Twilio API key" },
  { re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, desc: "SendGrid API key" },
  { re: /npm_[A-Za-z0-9]{20,}/, desc: "npm token" },
  { re: /pypi-[A-Za-z0-9_-]{40,}/, desc: "PyPI token" },
  { re: /dop_v1_[a-f0-9]{64}/, desc: "DigitalOcean token" },
  { re: /eyJ0eXAiOiJKV1Q[A-Za-z0-9._-]{20,}/, desc: "Hardcoded JWT token" },
  {
    re: /(?:heroku[_-]?(?:api[_-]?)?key|HEROKU[_-]?(?:API[_-]?)?KEY)\s*[:=]\s*["'`][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}["'`]/,
    desc: "Heroku API key"
  },
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
var JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var PY_EXTS2 = new Set([".py", ".pyi"]);
var GO_EXTS = new Set([".go"]);
var RB_EXTS = new Set([".rb"]);
var JAVA_EXTS = new Set([".java", ".kt"]);
var DANGEROUS_PATTERNS = [
  {
    re: /\beval\s*\(\s*(?!["'`])[a-zA-Z_$]/,
    desc: "eval() with dynamic input \u2014 command injection risk",
    exts: JS_TS_EXTS
  },
  {
    re: /\.innerHTML\s*=\s*(?!["'`]|`\s*$)[a-zA-Z_$]/,
    desc: "innerHTML assignment with dynamic value \u2014 XSS risk",
    exts: JS_TS_EXTS
  },
  {
    re: /document\.write\s*\(\s*(?!["'`])[a-zA-Z_$]/,
    desc: "document.write() with dynamic input \u2014 XSS risk",
    exts: JS_TS_EXTS
  },
  {
    re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[a-zA-Z_$](?!['"]))/,
    desc: "exec/execSync with dynamic command \u2014 command injection risk",
    exts: JS_TS_EXTS
  },
  {
    re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*["'`]\s*\+\s*[a-zA-Z_$]/i,
    desc: "SQL string concatenation \u2014 SQL injection risk"
  },
  {
    re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\$\{/i,
    desc: "SQL template literal with interpolation \u2014 SQL injection risk"
  },
  {
    re: /(?:os\.system|subprocess\.(?:call|run|Popen|check_output))\s*\(\s*f["']/,
    desc: "Shell command with f-string \u2014 command injection risk",
    exts: PY_EXTS2
  },
  {
    re: /\b(?:eval|exec)\s*\(\s*(?!["'])[a-zA-Z_]/,
    desc: "eval/exec with dynamic input \u2014 code injection risk",
    exts: PY_EXTS2
  },
  {
    re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`])[a-zA-Z_$]/,
    desc: "dangerouslySetInnerHTML with dynamic value \u2014 XSS risk",
    exts: JS_TS_EXTS
  },
  {
    re: /password\s*(?:===|!==|==|!=)\s*(?!null\b|undefined\b|["'`])[a-zA-Z_$]/i,
    desc: "Password compared with === instead of constant-time comparison \u2014 timing attack risk",
    exts: JS_TS_EXTS
  },
  {
    re: /[?&](?:token|sessionId|session_id|auth_token|access_token)=/i,
    desc: "Session/auth token in URL query parameter \u2014 token leakage via referrer/logs"
  },
  {
    re: /JSON\.parse\s*\(\s*(?:req(?:uest)?\.body|req\.query|req\.params|ctx\.request\.body)/,
    desc: "JSON.parse on raw user input without validation \u2014 insecure deserialization risk",
    exts: JS_TS_EXTS
  },
  {
    re: /(?:pickle\.loads?|yaml\.(?:load|unsafe_load))\s*\(/,
    desc: "Unsafe deserialization (pickle/yaml.load) \u2014 arbitrary code execution risk",
    exts: PY_EXTS2
  },
  {
    re: /(?:res\.(?:json|send|write)|response\.(?:json|send|write))\s*\(.*process\.env/,
    desc: "process.env leaked in HTTP response \u2014 environment variable disclosure",
    exts: JS_TS_EXTS
  },
  {
    re: /(?:readFile|writeFile|createReadStream|createWriteStream|readdir|unlink|rmSync)\s*\(.*(?:req\.|params\.|query\.|ctx\.(?:request|params|query))/,
    desc: "File operation with user-controlled path \u2014 path traversal risk",
    exts: JS_TS_EXTS
  },
  {
    re: /(?:fetch|axios\.(?:get|post|put|delete|patch|request)|http\.(?:get|request)|got|urllib\.request\.urlopen)\s*\(.*(?:req\.|params\.|query\.|ctx\.(?:request|params|query))/,
    desc: "HTTP request with user-controlled URL \u2014 SSRF risk",
    exts: JS_TS_EXTS
  },
  {
    re: /requests\.(?:get|post|put|delete|patch|head)\s*\(\s*(?!["'])[a-zA-Z_]/,
    desc: "HTTP request with dynamic URL \u2014 SSRF risk",
    exts: PY_EXTS2
  },
  {
    re: /(?:__proto__|constructor\s*\.\s*prototype)\s*(?:\[|\.\s*\w+\s*=)/,
    desc: "Prototype pollution \u2014 __proto__/constructor.prototype mutation",
    exts: JS_TS_EXTS
  },
  {
    re: /\brequire\s*\(\s*(?!["'`])[a-zA-Z_$]/,
    desc: "Dynamic require() with variable \u2014 supply-chain/injection risk",
    exts: JS_TS_EXTS
  },
  {
    re: /exec\.Command\s*\(.*\+/,
    desc: "exec.Command with string concatenation \u2014 command injection risk",
    exts: GO_EXTS
  },
  {
    re: /\bsystem\s*\(\s*(?!["'])[a-zA-Z_]/,
    desc: "system() with dynamic input \u2014 command injection risk",
    exts: RB_EXTS
  },
  {
    re: /\.send\s*\(\s*(?:params|request|args)/,
    desc: "send() with user input \u2014 arbitrary method call risk",
    exts: RB_EXTS
  },
  {
    re: /Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(\s*(?!["'])[a-zA-Z_]/,
    desc: "Runtime.exec() with dynamic input \u2014 command injection risk",
    exts: JAVA_EXTS
  },
  {
    re: /\b(?:createHash|MessageDigest\.getInstance)\s*\(\s*["'](?:md5|MD5)["']/,
    desc: "MD5 usage \u2014 cryptographically weak, use SHA-256+"
  },
  {
    re: /(?:sha1|SHA1).*(?:password|passwd|pwd)/i,
    desc: "SHA1 for password hashing \u2014 use bcrypt/scrypt/argon2"
  },
  {
    re: /(?:iv|nonce|IV|NONCE)\s*[:=]\s*["'`][a-fA-F0-9]{16,}["'`]/,
    desc: "Hardcoded IV/nonce \u2014 use random generation"
  },
  {
    re: /Access-Control-Allow-Origin['":\s]*\*/,
    suppress: /(?:localhost|127\.0\.0\.1|development|test)/i,
    desc: "CORS wildcard origin (*) \u2014 restrict to specific origins in production"
  },
  {
    re: /\bdebug\s*[:=]\s*true\b/,
    suppress: /(?:test|spec|mock|\.test\.|\.spec\.)/i,
    suppressFile: /(?:\.test\.|\bspec\b|\.spec\.)/i,
    desc: "Hardcoded debug=true \u2014 verify this is not in production config"
  },
  {
    re: /\bsourceMap\s*[:=]\s*true\b/,
    suppress: /(?:dev|development|test)/i,
    suppressFile: /(?:\.test\.|\bspec\b|\.spec\.)/i,
    desc: "Source maps enabled \u2014 verify they are not shipped to production (VibeGuard)"
  }
];
function detectSecurityPatterns(file) {
  if (isGateDisabled("security-check"))
    return [];
  const ext = extname3(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync4(file))
    return [];
  let content;
  try {
    content = readFileSync5(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE2)
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
    let scanLine = line;
    if (hasBlockComments) {
      if (inBlockComment) {
        const endIdx = line.indexOf("*/");
        if (endIdx >= 0) {
          inBlockComment = false;
          scanLine = line.slice(endIdx + 2);
          if (!scanLine.trim())
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
        scanLine = line.slice(endIdx + 2);
        if (!scanLine.trim())
          continue;
      }
    }
    const scanTrimmed = scanLine.trimStart();
    if (scanTrimmed.startsWith("//") || scanTrimmed.startsWith("#"))
      continue;
    if (starIsComment && scanTrimmed.startsWith("*"))
      continue;
    if (!isTestFile) {
      for (const { re, desc } of SECRET_PATTERNS) {
        if (re.test(scanLine)) {
          if (/process\.env\b/.test(scanLine))
            continue;
          if (/os\.environ/.test(scanLine))
            continue;
          if (/\$\{?\w*ENV\w*\}?/.test(scanLine))
            continue;
          errors.push(`L${i + 1}: ${desc}`);
          break;
        }
      }
    }
    for (const { re, desc, exts, suppress, suppressFile } of DANGEROUS_PATTERNS) {
      if (exts && !exts.has(ext))
        continue;
      if (re.test(scanLine)) {
        if (suppress?.test(scanLine))
          continue;
        if (suppressFile?.test(basename(file)))
          continue;
        errors.push(`L${i + 1}: ${desc}`);
      }
    }
  }
  emitAdvisoryWarnings(file, content);
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
var ADVISORY_PATTERNS = [
  {
    re: /\bapp\.(?:get|post|put|delete|patch)\s*\(\s*["'`]\/api\//,
    suppress: /(?:auth|middleware|protect|guard|verify|session)/i,
    desc: "API route \u2014 verify auth middleware is applied",
    exts: JS_TS_EXTS
  },
  {
    re: /\bwss?\.on\s*\(\s*["'`]connection["'`]/,
    suppress: /(?:auth|token|verify|session|guard)/i,
    desc: "WebSocket handler \u2014 verify authentication is applied",
    exts: JS_TS_EXTS
  },
  {
    re: /\bcors\s*\(\s*\)/,
    suppress: /(?:\/\/\s*(?:dev|test|local))/i,
    desc: "cors() with no options \u2014 allows all origins by default",
    exts: JS_TS_EXTS
  },
  {
    re: /(?:console\.(?:log|info|warn|debug)|logger\.(?:info|warn|debug|log))\s*\(.*(?:password|passwd|secret|token|apiKey|api_key|credential|private_key)/i,
    suppress: /(?:mask|redact|sanitize|\*{3,})/i,
    desc: "Potential sensitive data in log output \u2014 mask before logging",
    exts: JS_TS_EXTS
  },
  {
    re: /["']\s*(?:\*|latest)\s*["']\s*$/,
    suppress: /(?:peerDependencies|devDependencies|optionalDependencies)/i,
    desc: "Wildcard/latest dependency version \u2014 pin to specific version for supply-chain safety"
  },
  {
    re: /\.cookie\s*\(.*httpOnly\s*:\s*false/,
    suppress: /(?:test|spec|mock)/i,
    desc: "Cookie with httpOnly: false \u2014 session hijacking risk",
    exts: JS_TS_EXTS
  }
];
function matchAdvisoryPatterns(file, content) {
  const ext = extname3(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (content.length > MAX_CHECK_SIZE2)
    return [];
  const lines = content.split(`
`);
  const matches = [];
  for (let i = 0;i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*"))
      continue;
    for (const { re, suppress, desc, exts } of ADVISORY_PATTERNS) {
      if (exts && !exts.has(ext))
        continue;
      if (re.test(lines[i]) && !suppress?.test(lines[i])) {
        matches.push({ line: i + 1, desc });
      }
    }
  }
  return matches;
}
function emitAdvisoryWarnings(file, content) {
  try {
    const relative = file.split("/").slice(-3).join("/");
    for (const m of matchAdvisoryPatterns(file, content)) {
      process.stderr.write(`[qult] Security advisory: ${relative}:${m.line} \u2014 ${m.desc}
`);
    }
  } catch {}
}

// src/hooks/detectors/test-quality-check.ts
import { existsSync as existsSync5, readFileSync as readFileSync6 } from "fs";
import { basename as basename2, dirname as dirname2, extname as extname4, resolve as resolve3 } from "path";
var MAX_CHECK_SIZE3 = 500000;
var BLOCKING_SMELL_TYPES = new Set([
  "empty-test",
  "always-true",
  "trivial-assertion",
  "constant-self"
]);
var ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
var TEST_CASE_RE = /\b(it|test)\s*\(/g;
var WEAK_MATCHERS = [
  { re: /\.toBeTruthy\s*\(\s*\)/, name: "toBeTruthy()" },
  { re: /\.toBeFalsy\s*\(\s*\)/, name: "toBeFalsy()" },
  { re: /\.toBeDefined\s*\(\s*\)/, name: "toBeDefined()" },
  { re: /\.toBeUndefined\s*\(\s*\)/, name: "toBeUndefined()" },
  { re: /\.toBe\s*\(\s*true\s*\)/, name: "toBe(true)" },
  { re: /\.toBe\s*\(\s*false\s*\)/, name: "toBe(false)" }
];
var TRIVIAL_ASSERTION_RE = /expect\s*\(\s*(\w+)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/;
var EMPTY_TEST_RE = /\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
var MOCK_RE = /\b(?:vi\.fn|jest\.fn|vi\.spyOn|jest\.spyOn|sinon\.stub|sinon\.spy|\.mockImplementation|\.mockReturnValue|\.mockResolvedValue|mock\()\s*\(/g;
var ALWAYS_TRUE_RE = /expect\s*\(\s*(?:true|1|"[^"]*"|'[^']*'|\d+)\s*\)\s*\.(?:toBe\s*\(\s*(?:true|1)\s*\)|toBeTruthy\s*\(\s*\)|toBeDefined\s*\(\s*\))/;
var CONSTANT_SELF_RE = /expect\s*\(\s*(["'`][^"'`]*["'`]|\d+)\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/;
var SNAPSHOT_RE = /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/g;
var IMPL_COUPLED_RE = /expect\s*\(\s*\w+\s*\)\s*\.(?:toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes)\s*\(/;
var ASYNC_TEST_RE = /\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*async\s/;
var AWAIT_RE = /\bawait\b/;
var MODULE_LET_RE = /^let\s+\w+\s*(?:[:=])/;
var LARGE_TEST_FILE_LINES = 500;
var LARGE_SNAPSHOT_CHARS = 5000;
var PBT_RE = /\b(?:fc\.assert|fc\.property|fast-check|@fast-check\/vitest|hypothesis\.given|@given)\b/;
var PBT_DEGENERATE_RUNS_RE = /numRuns\s*:\s*1\b/;
var PBT_CONSTRAINED_GEN_RE = /fc\.\w+\(\s*\{\s*min\s*:\s*(\d+)\s*,\s*max\s*:\s*\1\s*\}/;
var SETUP_BLOCK_RE = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(/;
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
  const cwd = resolve3(process.cwd());
  const absPath = resolve3(cwd, file);
  if (!absPath.startsWith(cwd))
    return null;
  if (!existsSync5(absPath))
    return null;
  let content;
  try {
    content = readFileSync6(absPath, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_CHECK_SIZE3)
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
  const isPbt = PBT_RE.test(content);
  const smells = [];
  if (isPbt) {
    for (let i = 0;i < lines.length; i++) {
      const line = lines[i];
      if (PBT_DEGENERATE_RUNS_RE.test(line)) {
        smells.push({
          type: "pbt-degenerate-runs",
          line: i + 1,
          message: "numRuns: 1 defeats the purpose of property-based testing \u2014 increase run count"
        });
      }
      if (PBT_CONSTRAINED_GEN_RE.test(line)) {
        smells.push({
          type: "pbt-constrained-generator",
          line: i + 1,
          message: "Generator min equals max \u2014 produces a single constant value, not random input"
        });
      }
    }
  }
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//"))
      continue;
    if (!isPbt) {
      for (const { re, name } of WEAK_MATCHERS) {
        if (re.test(line)) {
          smells.push({
            type: "weak-matcher",
            line: i + 1,
            message: `Weak matcher ${name} \u2014 consider asserting a specific value`
          });
          break;
        }
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
        message: "Empty test body \u2014 no assertions"
      });
    }
    if (ALWAYS_TRUE_RE.test(line)) {
      smells.push({
        type: "always-true",
        line: i + 1,
        message: "Always-true assertion \u2014 tests a literal, not computed behavior"
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
        message: "Tests mock calls instead of behavior \u2014 consider asserting outputs"
      });
    }
  }
  const snapshotCount = (codeOnly.match(SNAPSHOT_RE) ?? []).length;
  const nonSnapshotAssertions = assertionCount - snapshotCount;
  if (snapshotCount > 0 && nonSnapshotAssertions <= 0) {
    smells.push({
      type: "snapshot-only",
      line: 0,
      message: `All ${snapshotCount} assertion(s) are snapshots \u2014 add value-based assertions to verify behavior`
    });
  }
  const mockCount = (codeOnly.match(MOCK_RE) ?? []).length;
  if (mockCount > 0 && mockCount > assertionCount) {
    smells.push({
      type: "mock-overuse",
      line: 0,
      message: `Mock overuse: ${mockCount} mocks vs ${assertionCount} assertions \u2014 tests may verify mocks, not behavior`
    });
  }
  let inAsyncTest = false;
  let asyncTestLine = 0;
  let asyncTestHasAwait = false;
  let asyncBraceDepth = 0;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (!inAsyncTest && ASYNC_TEST_RE.test(line)) {
      inAsyncTest = true;
      asyncTestLine = i + 1;
      asyncTestHasAwait = false;
      asyncBraceDepth = 0;
    }
    if (inAsyncTest) {
      if (AWAIT_RE.test(line))
        asyncTestHasAwait = true;
      let inStr = null;
      let escaped = false;
      for (const ch of line) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (inStr) {
          if (ch === inStr)
            inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          continue;
        }
        if (ch === "{")
          asyncBraceDepth++;
        else if (ch === "}") {
          asyncBraceDepth--;
          if (asyncBraceDepth <= 0) {
            if (!asyncTestHasAwait) {
              smells.push({
                type: "async-no-await",
                line: asyncTestLine,
                message: "Async test without await \u2014 promises may resolve after test completes"
              });
            }
            inAsyncTest = false;
          }
        }
      }
    }
  }
  let moduleLetCount = 0;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (MODULE_LET_RE.test(line)) {
      moduleLetCount++;
      if (moduleLetCount === 1) {
        smells.push({
          type: "shared-mutable-state",
          line: i + 1,
          message: "Module-level `let` in test file \u2014 shared mutable state may cause test isolation issues"
        });
      }
    }
  }
  if (lines.length > LARGE_TEST_FILE_LINES) {
    smells.push({
      type: "large-test-file",
      line: 0,
      message: `Test file has ${lines.length} lines (>${LARGE_TEST_FILE_LINES}) \u2014 consider splitting by concern`
    });
  }
  try {
    const snapDir = `${dirname2(absPath)}/__snapshots__/`;
    const snapFile = `${snapDir}${basename2(absPath)}.snap`;
    if (existsSync5(snapFile)) {
      const snapContent = readFileSync6(snapFile, "utf-8");
      if (snapContent.length > LARGE_SNAPSHOT_CHARS) {
        smells.push({
          type: "snapshot-bloat",
          line: 0,
          message: `Snapshot file is ${Math.round(snapContent.length / 1024)}KB \u2014 large snapshots capture implementation details`
        });
      }
    }
  } catch {}
  if (testCount >= 2) {
    const hasErrorAssertions = /(?:toThrow|rejects\.toThrow|\.rejects\.|\.catch\s*\(|expect\(.*error)/i.test(codeOnly);
    if (!hasErrorAssertions) {
      try {
        const implFile = findImplFile(absPath);
        if (implFile) {
          const implContent = readFileSync6(implFile, "utf-8");
          if (/\bthrow\b|\breject\b|Promise\.reject/m.test(implContent)) {
            smells.push({
              type: "no-error-path",
              line: 0,
              message: "Implementation has throw/reject but test has no error-path assertions (toThrow, rejects, catch)"
            });
          }
        }
      } catch {}
    }
  }
  if (testCount >= 3) {
    const descRe = /\b(?:it|test)\s*\(\s*["'`]([^"'`]*)["'`]/g;
    const negativeRe = /\b(?:invalid|error|fail|reject|throw|empty|null|missing|not\b|negative|undefined|wrong|bad|broken|illegal)/i;
    let allPositive = true;
    for (const match of codeOnly.matchAll(descRe)) {
      if (negativeRe.test(match[1])) {
        allPositive = false;
        break;
      }
    }
    if (allPositive) {
      smells.push({
        type: "happy-path-only",
        line: 0,
        message: "All test descriptions are positive \u2014 consider testing error/edge cases (invalid input, null, empty)"
      });
    }
  }
  if (testCount >= 3) {
    const boundaryValueRe = /(?:\b0\b|\b-1\b|\bnull\b|\bundefined\b|\bNaN\b|\bInfinity\b|["'`]{2}|\[\s*\])/;
    const hasExpectLine = /expect\s*\(/.test(codeOnly);
    const hasBoundary = hasExpectLine && codeOnly.split(`
`).some((line) => /expect\s*\(/.test(line) && boundaryValueRe.test(line));
    if (!hasBoundary) {
      smells.push({
        type: "missing-boundary",
        line: 0,
        message: "No boundary values tested (0, -1, null, undefined, NaN, empty string/array) \u2014 consider edge cases"
      });
    }
  }
  if (testCount >= 2) {
    const testBodyRe = /\b(?:it|test)\s*\(\s*["'`]([^"'`]*)["'`]/g;
    const assertRe = /\b(?:expect|assert|should)\s*[.(]/g;
    const testBodies = [];
    for (const match of codeOnly.matchAll(testBodyRe)) {
      if (testBodies.length > 0) {
        const prev = testBodies[testBodies.length - 1];
        const body = codeOnly.slice(prev.start, match.index);
        prev.assertions = (body.match(assertRe) ?? []).length;
      }
      testBodies.push({ name: match[1], start: match.index, assertions: 0 });
    }
    if (testBodies.length > 0) {
      const last = testBodies[testBodies.length - 1];
      const body = codeOnly.slice(last.start);
      last.assertions = (body.match(assertRe) ?? []).length;
    }
    for (const tb of testBodies) {
      if (tb.assertions === 0) {
        continue;
      }
      if (tb.assertions === 1 && testCount >= 3) {
        smells.push({
          type: "thin-test",
          line: 0,
          message: `Test "${tb.name}" has only 1 assertion \u2014 consider adding edge case/boundary assertions`
        });
      }
    }
  }
  if (testCount >= 5 && assertionCount >= 5) {
    const matcherNameRe = /\.(toBe|toEqual|toStrictEqual|toThrow|toMatch|toContain)\s*\(/g;
    const matcherCounts = new Map;
    let totalMatched = 0;
    for (const m of codeOnly.matchAll(matcherNameRe)) {
      const key = m[1];
      matcherCounts.set(key, (matcherCounts.get(key) ?? 0) + 1);
      totalMatched++;
    }
    if (totalMatched > 0) {
      for (const [matcher, count] of matcherCounts) {
        const ratio = Math.min(count / totalMatched, 1);
        if (ratio >= 0.8) {
          smells.push({
            type: "concentrated-pattern",
            line: 0,
            message: `${Math.round(ratio * 100)}% of assertions use .${matcher}() \u2014 tests may miss diverse behaviors`
          });
          break;
        }
      }
    }
  }
  const blockingSmells = smells.filter((s) => BLOCKING_SMELL_TYPES.has(s.type));
  return { testCount, assertionCount, avgAssertions, smells, blockingSmells, isPbt };
}
function findImplFile(testPath) {
  try {
    const dir = dirname2(testPath);
    const base = basename2(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve3(dir, implName);
    if (existsSync5(sameDirPath))
      return sameDirPath;
    const parentDir = dirname2(dir);
    const parentPath = resolve3(parentDir, implName);
    if (existsSync5(parentPath))
      return parentPath;
    const srcPath = resolve3(parentDir, "src", implName);
    if (existsSync5(srcPath))
      return srcPath;
    return null;
  } catch {
    return null;
  }
}

// src/hooks/detectors/health-score.ts
var WEIGHTS = {
  security: -2,
  export_breaking: -2,
  dead_imports: -1,
  test_quality: -1.5
};
var DEFAULT_WEIGHT = -1;
function countFindings(fixes) {
  return fixes.reduce((sum, f) => sum + f.errors.length, 0);
}
function computeFileHealthScore(file) {
  if (!existsSync6(file)) {
    return { score: 10, breakdown: {} };
  }
  const breakdown = {};
  try {
    const securityFixes = detectSecurityPatterns(file);
    const count = countFindings(securityFixes);
    if (count > 0)
      breakdown.security = (WEIGHTS.security ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const deadImports = detectDeadImports(file);
    if (deadImports.length > 0)
      breakdown.dead_imports = (WEIGHTS.dead_imports ?? DEFAULT_WEIGHT) * deadImports.length;
  } catch {}
  try {
    const exportFixes = detectExportBreakingChanges(file);
    const count = countFindings(exportFixes);
    if (count > 0)
      breakdown.export_breaking = (WEIGHTS.export_breaking ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const tqResult = analyzeTestQuality(file);
    if (tqResult !== null && tqResult.smells.length > 0)
      breakdown.test_quality = (WEIGHTS.test_quality ?? DEFAULT_WEIGHT) * tqResult.smells.length;
  } catch {}
  const totalPenalty = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.round((10 + totalPenalty) * 10) / 10);
  return { score, breakdown };
}

// src/hooks/detectors/import-graph.ts
import { existsSync as existsSync7, lstatSync, readdirSync, readFileSync as readFileSync7, statSync } from "fs";
import { dirname as dirname3, extname as extname5, join, resolve as resolve4 } from "path";
var SCAN_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs"
]);
var SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".git",
  ".qult",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor"
]);
var MAX_FILE_SIZE = 256 * 1024;
var MAX_FILES = 2000;
var MAX_DEPTH = 50;
function stripComments(content) {
  return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function extractRelativeImports(content, filePath) {
  const stripped = stripComments(content);
  const specifiers = [];
  const ext = filePath ? extname5(filePath).toLowerCase() : "";
  if (ext === ".py") {
    const pyRel = /from\s+(\.[\w.]*)\s+import/g;
    for (const match of stripped.matchAll(pyRel)) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }
  if (ext === ".go") {
    const goSingle = /import\s+"([^"]+)"/g;
    for (const match of stripped.matchAll(goSingle)) {
      specifiers.push(match[1]);
    }
    const goBlock = /import\s*\(([\s\S]*?)\)/g;
    for (const block of stripped.matchAll(goBlock)) {
      const lines = block[1];
      const lineRe = /\s*(?:\w+\s+)?"([^"]+)"/g;
      for (const m of lines.matchAll(lineRe)) {
        specifiers.push(m[1]);
      }
    }
    return specifiers;
  }
  if (ext === ".rs") {
    const modDecl = /\bmod\s+(\w+)\s*;/g;
    for (const match of stripped.matchAll(modDecl)) {
      specifiers.push(`mod:${match[1]}`);
    }
    const useCrate = /\buse\s+crate::(\w+)/g;
    for (const match of stripped.matchAll(useCrate)) {
      specifiers.push(`crate:${match[1]}`);
    }
    return specifiers;
  }
  const esm = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  const cjs = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const dynamic = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const match of stripped.matchAll(esm)) {
    specifiers.push(match[1]);
  }
  for (const match of stripped.matchAll(cjs)) {
    specifiers.push(match[1]);
  }
  for (const match of stripped.matchAll(dynamic)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}
function resolvePythonImport(specifier, fromFile) {
  const dir = dirname3(fromFile);
  const dotMatch = specifier.match(/^(\.+)(.*)/);
  if (!dotMatch)
    return null;
  const dots = dotMatch[1].length;
  const modulePart = dotMatch[2];
  let base = dir;
  for (let i = 1;i < dots; i++) {
    base = dirname3(base);
  }
  if (!modulePart) {
    return null;
  }
  const parts = modulePart.split(".");
  const candidate = join(base, ...parts);
  if (existsSync7(`${candidate}.py`))
    return `${candidate}.py`;
  if (existsSync7(join(candidate, "__init__.py")))
    return join(candidate, "__init__.py");
  return null;
}
function resolveRustImport(specifier, fromFile, scanRoot) {
  const dir = dirname3(fromFile);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const asFile = join(dir, `${name}.rs`);
    if (existsSync7(asFile))
      return asFile;
    const asDir = join(dir, name, "mod.rs");
    if (existsSync7(asDir))
      return asDir;
  } else if (specifier.startsWith("crate:")) {
    const name = specifier.slice(6);
    const srcDir = join(scanRoot, "src");
    const asFile = join(srcDir, `${name}.rs`);
    if (existsSync7(asFile))
      return asFile;
    const asDir = join(srcDir, name, "mod.rs");
    if (existsSync7(asDir))
      return asDir;
  }
  return null;
}
var _goModuleCache;
function getGoModulePath(scanRoot) {
  if (_goModuleCache !== undefined)
    return _goModuleCache;
  try {
    const goMod = readFileSync7(join(scanRoot, "go.mod"), "utf-8");
    const match = goMod.match(/^module\s+(\S+)/m);
    _goModuleCache = match ? match[1] : null;
  } catch {
    _goModuleCache = null;
  }
  return _goModuleCache;
}
function resolveGoImport(specifier, scanRoot) {
  const modulePath = getGoModulePath(scanRoot);
  if (!modulePath || !specifier.startsWith(modulePath))
    return null;
  const relPath = specifier.slice(modulePath.length + 1);
  const dir = join(scanRoot, relPath);
  if (existsSync7(dir) && statSync(dir).isDirectory())
    return dir;
  return null;
}
function resolveImportPath(specifier, fromFile, scanRoot) {
  const fileExt = extname5(fromFile).toLowerCase();
  if (fileExt === ".py") {
    return resolvePythonImport(specifier, fromFile);
  }
  if (fileExt === ".rs" && scanRoot) {
    return resolveRustImport(specifier, fromFile, scanRoot);
  }
  if (fileExt === ".go" && scanRoot) {
    return resolveGoImport(specifier, scanRoot);
  }
  const dir = dirname3(fromFile);
  const raw = resolve4(dir, specifier);
  if (existsSync7(raw) && statSync(raw).isFile())
    return raw;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const withExt = `${raw}${ext}`;
    if (existsSync7(withExt))
      return withExt;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const index = join(raw, `index${ext}`);
    if (existsSync7(index))
      return index;
  }
  return null;
}
function collectFiles(dir) {
  const files = [];
  let capped = false;
  function walk(current, depth) {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH)
      return;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        capped = true;
        return;
      }
      if (SKIP_DIRS.has(entry))
        continue;
      const full = join(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink())
          continue;
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile() && SCAN_EXTS.has(extname5(full))) {
          if (stat.size <= MAX_FILE_SIZE) {
            files.push(full);
          }
        }
      } catch {}
    }
  }
  walk(dir, 0);
  if (capped) {
    process.stderr.write(`[qult] import-graph: file scan capped at ${MAX_FILES} files, results may be incomplete
`);
  }
  return files;
}
function findImporters(targetFile, scanRoot, depth = 1) {
  if (!existsSync7(scanRoot))
    return [];
  const clampedDepth = Math.min(Math.max(depth, 1), 3);
  const files = collectFiles(scanRoot);
  const visited = new Set;
  const allImporters = [];
  function findDirectImporters(targetAbs) {
    const direct = [];
    const targetDir = dirname3(targetAbs);
    const targetExt = extname5(targetAbs).toLowerCase();
    for (const file of files) {
      const fileAbs = resolve4(file);
      if (fileAbs === targetAbs)
        continue;
      if (targetExt === ".go" && extname5(file).toLowerCase() === ".go" && dirname3(fileAbs) === targetDir) {
        direct.push(file);
        continue;
      }
      try {
        const content = readFileSync7(file, "utf-8");
        const specifiers = extractRelativeImports(content, file);
        for (const spec of specifiers) {
          const resolved = resolveImportPath(spec, file, scanRoot);
          if (!resolved)
            continue;
          if (extname5(file).toLowerCase() === ".go") {
            if (resolve4(resolved) === targetDir) {
              direct.push(file);
              break;
            }
          } else if (resolve4(resolved) === targetAbs) {
            direct.push(file);
            break;
          }
        }
      } catch {}
    }
    if (targetExt === ".py") {
      const targetName = targetAbs.replace(/\.py$/, "").split("/").pop();
      for (const file of files) {
        const fileAbs = resolve4(file);
        if (fileAbs === targetAbs || direct.includes(file))
          continue;
        if (extname5(file).toLowerCase() !== ".py")
          continue;
        try {
          const content = readFileSync7(file, "utf-8");
          const bareImport = new RegExp(`from\\s+\\.\\s+import\\s+(?:.*\\b${targetName}\\b)`, "m");
          if (bareImport.test(content) && dirname3(fileAbs) === targetDir) {
            direct.push(file);
          }
        } catch {}
      }
    }
    return direct;
  }
  let currentTargets = [resolve4(targetFile)];
  for (let d = 0;d < clampedDepth; d++) {
    const nextTargets = [];
    for (const target of currentTargets) {
      if (visited.has(target))
        continue;
      visited.add(target);
      const direct = findDirectImporters(target);
      for (const imp of direct) {
        const impAbs = resolve4(imp);
        if (!visited.has(impAbs) && impAbs !== resolve4(targetFile)) {
          allImporters.push(imp);
          nextTargets.push(impAbs);
        }
      }
    }
    currentTargets = nextTargets;
    if (!currentTargets.length)
      break;
  }
  return [...new Set(allImporters)];
}

// src/hooks/detectors/spec-trace-check.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "fs";
import { basename as basename3, dirname as dirname4, relative } from "path";
function validateTestCoversImpl(testFile, _testFunction, implFile, _projectRoot) {
  if (!existsSync8(testFile))
    return false;
  try {
    const content = readFileSync8(testFile, "utf-8");
    const implBasename = basename3(implFile).replace(/\.[^.]+$/, "");
    const implRelative = relative(dirname4(testFile), implFile).replace(/\\/g, "/").replace(/\.[^.]+$/, "");
    const importPatterns = [
      new RegExp(`(?:import|require).*['"].*${escapeRegex2(implRelative)}(?:\\.[^'"]*)?['"]`, "m"),
      new RegExp(`(?:import|require).*['"].*/${escapeRegex2(implBasename)}(?:\\.[^'"]*)?['"]`, "m")
    ];
    return importPatterns.some((pattern) => pattern.test(content));
  } catch {
    return false;
  }
}
function escapeRegex2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/mcp-tools/spec-tools.ts
import { existsSync as existsSync10 } from "fs";

// src/state/json-state.ts
var SCHEMA_VERSION2 = 1;
var DEFAULT_CURRENT = {
  schema_version: SCHEMA_VERSION2,
  test_passed_at: null,
  test_command: null,
  review_completed_at: null,
  review_score: null,
  finish_started_at: null,
  human_approval_at: null,
  last_active_wave: null
};
function readCurrent() {
  const got = readJson(currentJsonPath(), SCHEMA_VERSION2);
  return got ?? structuredClone(DEFAULT_CURRENT);
}
function patchCurrent(patch) {
  const next = { ...readCurrent(), ...patch, schema_version: SCHEMA_VERSION2 };
  writeJson(currentJsonPath(), next);
  return next;
}
var DEFAULT_PENDING = {
  schema_version: SCHEMA_VERSION2,
  fixes: []
};
function readPendingFixes() {
  const got = readJson(pendingFixesJsonPath(), SCHEMA_VERSION2);
  return got ?? structuredClone(DEFAULT_PENDING);
}
function writePendingFixes(fixes) {
  const next = { schema_version: SCHEMA_VERSION2, fixes };
  writeJson(pendingFixesJsonPath(), next);
  return next;
}
function clearPendingFixes() {
  return writePendingFixes([]);
}
var DEFAULT_STAGE_SCORES = {
  schema_version: SCHEMA_VERSION2,
  spec_name: null,
  review: { Spec: null, Quality: null, Security: null, Adversarial: null },
  spec_eval: { requirements: null, design: null, tasks: null }
};
function readStageScores() {
  const got = readJson(stageScoresJsonPath(), SCHEMA_VERSION2);
  return got ?? structuredClone(DEFAULT_STAGE_SCORES);
}
function recordReviewStage(stage, scores, now = new Date().toISOString()) {
  const cur = readStageScores();
  cur.review[stage] = { scores, recorded_at: now };
  writeJson(stageScoresJsonPath(), cur);
  return cur;
}
function recordSpecEvalPhase(phase, score) {
  const cur = readStageScores();
  cur.spec_eval[phase] = {
    total: score.total,
    dim_scores: score.dim_scores,
    forced_progress: score.forced_progress,
    iteration: score.iteration,
    evaluated_at: score.evaluated_at ?? new Date().toISOString()
  };
  writeJson(stageScoresJsonPath(), cur);
  return cur;
}

// src/state/spec.ts
import { execSync as execSync2 } from "child_process";
import { existsSync as existsSync9, readdirSync as readdirSync2, renameSync as renameSync2, statSync as statSync2 } from "fs";
import { dirname as dirname5 } from "path";
function listSpecNames() {
  const root = specsDir();
  if (!existsSync9(root))
    return [];
  const out = [];
  for (const entry of readdirSync2(root, { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue;
    if (entry.name === "archive")
      continue;
    try {
      assertValidSpecName(entry.name);
    } catch {
      continue;
    }
    out.push(entry.name);
  }
  return out.sort();
}
function getActiveSpec() {
  const names = listSpecNames();
  if (names.length === 0)
    return null;
  if (names.length > 1) {
    throw new Error(`multiple active specs detected: ${names.join(", ")} \u2014 only one non-archived spec is allowed`);
  }
  const name = names[0];
  const path = specDir(name);
  return {
    name,
    path,
    hasRequirements: existsSync9(requirementsPath(name)),
    hasDesign: existsSync9(designPath(name)),
    hasTasks: existsSync9(tasksPath(name)),
    wavesDirExists: existsSync9(wavesDir(name))
  };
}
function archiveSpec(name, now = new Date) {
  assertValidSpecName(name);
  const src = specDir(name);
  if (!existsSync9(src)) {
    throw new Error(`spec not found: ${name}`);
  }
  ensureDir(archiveDir());
  let dest = `${archiveDir()}/${name}`;
  if (existsSync9(dest)) {
    dest = `${archiveDir()}/${name}-${formatTimestamp(now)}`;
  }
  assertConfinedToQult(dest);
  ensureDir(dirname5(dest));
  renameSync2(src, dest);
  return dest;
}
function formatTimestamp(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}
function listWaveNumbers(name) {
  const dir = wavesDir(name);
  if (!existsSync9(dir))
    return [];
  const re = /^wave-(\d{2})\.md$/;
  const nums = [];
  for (const entry of readdirSync2(dir)) {
    const m = re.exec(entry);
    if (m?.[1]) {
      nums.push(Number.parseInt(m[1], 10));
    }
  }
  return nums.sort((a, b) => a - b);
}
function isCommitReachable(sha, cwd) {
  if (!/^[0-9a-f]{4,40}$/.test(sha))
    return false;
  try {
    execSync2(`git rev-parse --verify ${sha}^{commit}`, {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

// src/state/tasks-md.ts
var TASK_TITLE_MAX = 1024;
var STATUS_TO_CHAR = {
  pending: " ",
  in_progress: "~",
  done: "x",
  blocked: "!"
};
var CHAR_TO_STATUS = {
  " ": "pending",
  "~": "in_progress",
  x: "done",
  X: "done",
  "!": "blocked"
};
var TASK_LINE_RE = /^- \[([ x~!X])\] (T\d+\.\d+): (.*)$/;
var WAVE_HEADER_RE = /^## Wave (\d+):\s*(.*)$/;
var TITLE_RE = /^# Tasks:\s*(.+)$/;
var META_RE = /^\*\*([A-Za-z]+)\*\*:\s*(.*)$/;
function parseTasksMd(content) {
  const lines = content.split(`
`);
  const doc = { specName: null, waves: [] };
  let current = null;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i] ?? "";
    const titleMatch = TITLE_RE.exec(line);
    if (titleMatch && doc.specName === null) {
      doc.specName = (titleMatch[1] ?? "").trim();
      continue;
    }
    const waveMatch = WAVE_HEADER_RE.exec(line);
    if (waveMatch) {
      const num = Number.parseInt(waveMatch[1] ?? "0", 10);
      current = {
        num,
        title: (waveMatch[2] ?? "").trim(),
        goal: null,
        verify: null,
        scaffold: false,
        tasks: []
      };
      doc.waves.push(current);
      continue;
    }
    if (!current)
      continue;
    const metaMatch = META_RE.exec(line);
    if (metaMatch) {
      const key = (metaMatch[1] ?? "").toLowerCase();
      const val = (metaMatch[2] ?? "").trim();
      if (key === "goal")
        current.goal = val;
      else if (key === "verify")
        current.verify = val;
      else if (key === "scaffold")
        current.scaffold = /^true$/i.test(val);
      continue;
    }
    const taskMatch = TASK_LINE_RE.exec(line);
    if (taskMatch) {
      const statusChar = taskMatch[1] ?? " ";
      const id = taskMatch[2] ?? "";
      const title = taskMatch[3] ?? "";
      validateTaskTitle(title, id);
      const status = CHAR_TO_STATUS[statusChar] ?? "pending";
      current.tasks.push({ id, title, status });
    }
  }
  return doc;
}
function setTaskStatus(content, taskId, status) {
  const lines = content.split(`
`);
  const newChar = STATUS_TO_CHAR[status];
  let updatedLine = -1;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = TASK_LINE_RE.exec(line);
    if (m && m[2] === taskId) {
      lines[i] = `- [${newChar}] ${taskId}: ${m[3] ?? ""}`;
      updatedLine = i;
      break;
    }
  }
  if (updatedLine < 0) {
    throw new TaskNotFoundError(taskId);
  }
  return lines.join(`
`);
}
function summarizeTaskStatus(doc) {
  const counts = {
    pending: 0,
    in_progress: 0,
    done: 0,
    blocked: 0
  };
  for (const wave of doc.waves) {
    for (const t of wave.tasks)
      counts[t.status]++;
  }
  return counts;
}
function findNextIncompleteWave(doc) {
  for (const wave of doc.waves) {
    if (wave.tasks.some((t) => t.status !== "done"))
      return wave;
  }
  return null;
}
function validateTaskTitle(title, id) {
  if (title.length > TASK_TITLE_MAX) {
    throw new Error(`task ${id}: title exceeds ${TASK_TITLE_MAX} chars`);
  }
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error(`task ${id}: title contains control characters`);
  }
}

class TaskNotFoundError extends Error {
  taskId;
  constructor(taskId) {
    super(`task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

// src/state/wave-md.ts
var TITLE_RE2 = /^# Wave (\d+):\s*(.*)$/;
var META_RE2 = /^\*\*([A-Za-z][A-Za-z ]*?)\*\*:\s*(.*)$/;
var COMMIT_LINE_RE = /^- ([0-9a-f]{4,40}):\s*(.+)$/;
var WAVE_REF_RE = /^wave-(\d+)$/i;
function parseWaveMd(content) {
  const lines = content.split(`
`);
  const doc = {
    num: 0,
    title: "",
    goal: null,
    verify: null,
    scaffold: false,
    startedAt: null,
    completedAt: null,
    fixes: null,
    supersededBy: null,
    commits: [],
    range: null,
    notes: ""
  };
  let section = "header";
  const noteLines = [];
  for (const line of lines) {
    if (section === "header") {
      const tm = TITLE_RE2.exec(line);
      if (tm) {
        doc.num = Number.parseInt(tm[1] ?? "0", 10);
        doc.title = (tm[2] ?? "").trim();
        continue;
      }
      if (line === "## Commits") {
        section = "commits";
        continue;
      }
      if (line === "## Notes") {
        section = "notes";
        continue;
      }
      const mm = META_RE2.exec(line);
      if (mm) {
        assignMeta(doc, (mm[1] ?? "").trim().toLowerCase(), (mm[2] ?? "").trim());
      }
      continue;
    }
    if (section === "commits") {
      if (line === "## Notes") {
        section = "notes";
        continue;
      }
      const mm = META_RE2.exec(line);
      if (mm) {
        assignMeta(doc, (mm[1] ?? "").trim().toLowerCase(), (mm[2] ?? "").trim());
        continue;
      }
      const cm = COMMIT_LINE_RE.exec(line);
      if (cm?.[1] && cm[2]) {
        doc.commits.push({ sha: cm[1], subject: cm[2] });
      }
      continue;
    }
    noteLines.push(line);
  }
  doc.notes = trimBlankLines(noteLines).join(`
`);
  return doc;
}
function assignMeta(doc, key, value) {
  switch (key) {
    case "goal":
      doc.goal = value || null;
      break;
    case "verify":
      doc.verify = value || null;
      break;
    case "scaffold":
      doc.scaffold = /^true$/i.test(value);
      break;
    case "started at":
      doc.startedAt = value || null;
      break;
    case "completed at":
      doc.completedAt = value || null;
      break;
    case "fixes":
      doc.fixes = parseWaveRef(value);
      break;
    case "superseded by":
      doc.supersededBy = parseWaveRef(value);
      break;
    case "range":
      doc.range = value || null;
      break;
  }
}
function parseWaveRef(value) {
  const m = WAVE_REF_RE.exec(value.trim());
  if (!m)
    return null;
  const n = Number.parseInt(m[1] ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "")
    start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "")
    end--;
  return lines.slice(start, end);
}
function writeWaveMd(doc) {
  const out = [];
  out.push(`# Wave ${doc.num}: ${doc.title}`);
  out.push("");
  out.push(`**Goal**: ${doc.goal ?? ""}`);
  out.push(`**Verify**: ${doc.verify ?? ""}`);
  out.push(`**Started at**: ${doc.startedAt ?? ""}`);
  out.push(`**Completed at**: ${doc.completedAt ?? ""}`);
  out.push(`**Scaffold**: ${doc.scaffold ? "true" : "false"}`);
  if (doc.fixes !== null) {
    out.push(`**Fixes**: wave-${pad(doc.fixes)}`);
  }
  if (doc.supersededBy !== null) {
    out.push(`**Superseded by**: wave-${pad(doc.supersededBy)}`);
  }
  out.push("");
  out.push("## Commits");
  if (doc.commits.length === 0) {
    out.push("");
    out.push("(populated on /qult:wave-complete)");
  } else {
    for (const c of doc.commits) {
      out.push(`- ${c.sha}: ${c.subject}`);
    }
  }
  out.push("");
  out.push(`**Range**: ${doc.range ?? ""}`);
  out.push("");
  out.push("## Notes");
  out.push("");
  if (doc.notes.trim()) {
    out.push(doc.notes);
    out.push("");
  }
  return `${out.join(`
`).replace(/\n+$/u, "")}
`;
}
function pad(n) {
  return String(n).padStart(2, "0");
}

// src/mcp-tools/shared.ts
function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}
function requireSpecName(args, key = "spec_name") {
  const v = args?.[key];
  if (typeof v !== "string") {
    throw new Error(`missing or non-string ${key}`);
  }
  assertValidSpecName(v);
  return v;
}
function requireWaveNum(args, key = "wave_num") {
  const v = args?.[key];
  if (typeof v !== "number") {
    throw new Error(`missing or non-number ${key}`);
  }
  assertValidWaveNum(v);
  return v;
}

// src/mcp-tools/spec-tools.ts
function handleGetActiveSpec() {
  let info;
  try {
    info = getActiveSpec();
  } catch (err) {
    return errorResult(err.message);
  }
  if (info === null) {
    return jsonResult(null);
  }
  const tasksFile = tasksPath(info.name);
  let tasksDoc = null;
  if (existsSync10(tasksFile)) {
    try {
      tasksDoc = parseTasksMd(readText(tasksFile));
    } catch {
      tasksDoc = null;
    }
  }
  const totalWaves = tasksDoc?.waves.length ?? 0;
  const nextWave = tasksDoc ? findNextIncompleteWave(tasksDoc) : null;
  const summary = tasksDoc ? summarizeTaskStatus(tasksDoc) : null;
  return jsonResult({
    name: info.name,
    path: info.path,
    has_requirements: info.hasRequirements,
    has_design: info.hasDesign,
    has_tasks: info.hasTasks,
    total_waves: totalWaves,
    current_wave: nextWave?.num ?? null,
    task_summary: summary
  });
}
function handleCompleteWave(args) {
  let waveNum;
  let activeSpec;
  let commitRange;
  try {
    waveNum = requireWaveNum(args);
    activeSpec = getActiveSpec();
    const r = args?.commit_range;
    if (typeof r !== "string" || !/^[0-9a-f]{4,40}\.\.[0-9a-f]{4,40}$/.test(r)) {
      return errorResult("missing or malformed commit_range (expected 'startSha..endSha')");
    }
    commitRange = r;
  } catch (err) {
    return errorResult(err.message);
  }
  if (activeSpec === null) {
    return errorResult("no active spec");
  }
  const wavePathStr = wavePath(activeSpec.name, waveNum);
  if (!existsSync10(wavePathStr)) {
    return errorResult(`wave-${pad2(waveNum)}.md not found; run /qult:wave-start first`);
  }
  let waveDoc = parseWaveMd(readText(wavePathStr));
  if (waveDoc.completedAt) {
    return jsonResult({
      ok: false,
      reason: "already_completed",
      completed_at: waveDoc.completedAt
    });
  }
  const stale = [];
  for (const prior of listWaveNumbers(activeSpec.name)) {
    if (prior === waveNum)
      continue;
    const priorPath = wavePath(activeSpec.name, prior);
    if (!existsSync10(priorPath))
      continue;
    const priorDoc = parseWaveMd(readText(priorPath));
    if (!priorDoc.range)
      continue;
    const m = /^([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})$/.exec(priorDoc.range);
    if (!m)
      continue;
    if (!isCommitReachable(m[1]) || !isCommitReachable(m[2])) {
      stale.push(`wave-${pad2(prior)}`);
    }
  }
  if (stale.length > 0) {
    return jsonResult({ ok: false, reason: "sha_unreachable", stale });
  }
  waveDoc = {
    ...waveDoc,
    completedAt: new Date().toISOString(),
    range: commitRange
  };
  atomicWrite(wavePathStr, writeWaveMd(waveDoc));
  return jsonResult({ ok: true, range: commitRange });
}
function handleUpdateTaskStatus(args) {
  let activeSpec;
  const taskId = typeof args?.task_id === "string" ? args.task_id : null;
  const statusRaw = typeof args?.status === "string" ? args.status : null;
  if (!taskId)
    return errorResult("missing task_id");
  if (!statusRaw || !["pending", "in_progress", "done", "blocked"].includes(statusRaw)) {
    return errorResult("status must be one of: pending | in_progress | done | blocked");
  }
  try {
    activeSpec = getActiveSpec();
  } catch (err) {
    return errorResult(err.message);
  }
  if (activeSpec === null)
    return errorResult("no active spec");
  const tasksFile = tasksPath(activeSpec.name);
  if (!existsSync10(tasksFile))
    return errorResult("tasks.md not found");
  let updated;
  try {
    updated = setTaskStatus(readText(tasksFile), taskId, statusRaw);
  } catch (err) {
    if (err.name === "TaskNotFoundError") {
      return jsonResult({ ok: false, reason: "task_not_found", task_id: taskId });
    }
    return errorResult(err.message);
  }
  atomicWrite(tasksFile, updated);
  return jsonResult({ ok: true, task_id: taskId, status: statusRaw });
}
function handleArchiveSpec(args) {
  let name;
  try {
    name = requireSpecName(args);
  } catch (err) {
    return errorResult(err.message);
  }
  try {
    const dest = archiveSpec(name);
    return jsonResult({ ok: true, archived_to: dest });
  } catch (err) {
    return errorResult(err.message);
  }
}
function handleRecordSpecEvaluatorScore(args) {
  const phase = args?.phase;
  const total = args?.total;
  const dim = args?.dim_scores;
  const forced = args?.forced_progress ?? false;
  const iter = args?.iteration ?? 1;
  if (phase !== "requirements" && phase !== "design" && phase !== "tasks") {
    return errorResult("phase must be one of: requirements | design | tasks");
  }
  if (typeof total !== "number" || total < 0 || total > 20) {
    return errorResult("total must be a number in [0, 20]");
  }
  if (!dim || typeof dim !== "object") {
    return errorResult("dim_scores must be an object");
  }
  const dimRecord = {};
  for (const [k, v] of Object.entries(dim)) {
    if (typeof v === "number")
      dimRecord[k] = v;
  }
  if (typeof iter !== "number" || iter < 1) {
    return errorResult("iteration must be a positive integer");
  }
  if (typeof forced !== "boolean") {
    return errorResult("forced_progress must be a boolean");
  }
  const state = recordSpecEvalPhase(phase, {
    total,
    dim_scores: dimRecord,
    forced_progress: forced,
    iteration: iter
  });
  return jsonResult({ ok: true, phase, recorded: state.spec_eval[phase] });
}
function pad2(n) {
  return String(n).padStart(2, "0");
}

// src/state/audit-log.ts
import { appendFileSync, readFileSync as readFileSync9, renameSync as renameSync3, writeFileSync as writeFileSync2 } from "fs";
import { resolve as resolve5 } from "path";
var MAX_ENTRIES = 200;
function auditLogPath() {
  return resolve5(qultDir(), "state", "audit-log.ndjson");
}
function appendAuditLog(entry) {
  try {
    const path = auditLogPath();
    assertConfinedToQult(path);
    ensureDir(resolve5(path, ".."));
    appendFileSync(path, `${JSON.stringify(entry)}
`, { encoding: "utf8" });
    trimIfOverflowing(path);
  } catch {}
}
function trimIfOverflowing(path) {
  try {
    const txt = readFileSync9(path, "utf8");
    const lines = txt.split(`
`).filter((l) => l.trim().length > 0);
    if (lines.length <= MAX_ENTRIES * 1.5)
      return;
    const kept = lines.slice(-MAX_ENTRIES);
    const tmp = `${path}.tmp`;
    writeFileSync2(tmp, `${kept.join(`
`)}
`, "utf8");
    renameSync3(tmp, path);
  } catch {}
}

// src/mcp-server.ts
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_NAME = "qult";
var SERVER_VERSION = "1.0.0";
var VALID_DETECTOR_GATES = [
  "review",
  "security-check",
  "semgrep-required",
  "test-quality-check",
  "dep-vuln-check",
  "hallucinated-package-check"
];
function isValidGateName(name) {
  return VALID_DETECTOR_GATES.includes(name);
}
var TOOL_DEFS = [
  {
    name: "get_pending_fixes",
    description: "Returns lint/typecheck errors that must be fixed. Call when DENIED by qult. Response: '[gate] file\\n  error details' per fix, or 'No pending fixes.'",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_project_status",
    description: "Returns project state as JSON: test_passed_at, review_completed_at, review_iteration, plus the active_spec block (name, current_wave, total_waves, task_summary) when a spec exists under .qult/specs/. Call before committing to verify gates.",
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
    description: "Set a qult config value. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, review.models.{spec|quality|security|adversarial}, plan_eval.score_threshold, plan_eval.max_iterations, plan_eval.models.{generator|evaluator}, review.require_human_approval, review.low_only_passes.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key (e.g. 'review.score_threshold')" },
        value: { type: "number", description: "Numeric value to set" }
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
    description: "Record that tests have passed. Call after running tests successfully. Pre-commit checks read test_passed_at to verify test freshness before a commit.",
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
    description: "Returns a consolidated summary of all computational detector findings from the current session. Includes escalation counters and pending fixes grouped by gate. Call before /qult:review to collect ground truth for reviewers.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_file_health_score",
    description: "Compute a 0-10 health score for a file by aggregating Tier 1 detector findings (security, dead-imports, export-breaking, test-quality). 10 = no issues, 0 = critical. Returns score and per-detector breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file to score"
        }
      },
      required: ["file_path"]
    }
  },
  {
    name: "record_human_approval",
    description: "Record that the architect has reviewed and approved the changes. Required when review.require_human_approval is enabled.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "record_stage_scores",
    description: "Record review scores for a specific stage (Spec, Quality, Security, or Adversarial). Used for 4-stage aggregate score tracking (/40).",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description: "Stage name: 'Spec', 'Quality', 'Security', or 'Adversarial'"
        },
        scores: {
          type: "object",
          description: "Dimension scores (e.g. {completeness: 5, accuracy: 4})"
        }
      },
      required: ["stage", "scores"]
    }
  },
  {
    name: "record_finish_started",
    description: "Record that /qult:finish has been started. Call at the beginning of /qult:finish skill. Required for the commit gate to allow commits when a plan is active.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "archive_spec",
    description: "Archive a completed spec by moving .qult/specs/<name>/ to .qult/specs/archive/<name>[-timestamp]/. Call from /qult:finish after the spec is complete and merged. The spec_name must match the active spec; reserved name 'archive' is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        spec_name: {
          type: "string",
          description: "kebab-case spec name (e.g. 'add-oauth')"
        }
      },
      required: ["spec_name"]
    }
  },
  {
    name: "get_active_spec",
    description: "Return the unique active spec under .qult/specs/ (excluding archive/). Response: { name, path, has_requirements, has_design, has_tasks, total_waves, current_wave, task_summary } or null when no spec is active.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "complete_wave",
    description: "Finalize a Wave by writing completion timestamp and commit range to wave-NN.md. Idempotent: returns reason='already_completed' when called twice. Verifies prior Waves' Range SHAs are still reachable (rejects with reason='sha_unreachable' after rebase/reset).",
    inputSchema: {
      type: "object",
      properties: {
        wave_num: { type: "number", description: "Wave number (1-99)" },
        commit_range: {
          type: "string",
          description: "Commit range as 'startSha..endSha' (4-40 hex chars each)"
        }
      },
      required: ["wave_num", "commit_range"]
    }
  },
  {
    name: "update_task_status",
    description: "Update a single task's status in the active spec's tasks.md. Status: pending | in_progress | done | blocked. Returns reason='task_not_found' when task_id does not exist (NEVER silent no-op).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id like 'T1.3'" },
        status: {
          type: "string",
          description: "pending | in_progress | done | blocked"
        }
      },
      required: ["task_id", "status"]
    }
  },
  {
    name: "record_spec_evaluator_score",
    description: "Record a spec-evaluator score for a specific phase (requirements | design | tasks). Used during /qult:spec to gate progression through requirements \u2192 design \u2192 tasks.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string", description: "requirements | design | tasks" },
        total: { type: "number", description: "Total score 0-20" },
        dim_scores: {
          type: "object",
          description: "Per-dimension scores, e.g. { completeness: 5, testability: 4 }"
        },
        forced_progress: {
          type: "boolean",
          description: "true if user force-progressed past iteration cap"
        },
        iteration: { type: "number", description: "Iteration count (1-based)" }
      },
      required: ["phase", "total", "dim_scores"]
    }
  },
  {
    name: "get_impact_analysis",
    description: "Analyze the impact of changes to a file. Returns a list of consumer files (importers) that may be affected, using the import graph.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Absolute path to the changed file"
        }
      },
      required: ["file"]
    }
  },
  {
    name: "get_call_coverage",
    description: "Check whether a test file covers (imports from) an implementation file. Uses import graph to verify the test\u2192impl dependency path exists.",
    inputSchema: {
      type: "object",
      properties: {
        test_file: {
          type: "string",
          description: "Absolute path to the test file"
        },
        impl_file: {
          type: "string",
          description: "Absolute path to the implementation file"
        }
      },
      required: ["test_file", "impl_file"]
    }
  }
];
function handleTool(name, cwd, args) {
  setProjectRoot(cwd);
  switch (name) {
    case "get_active_spec":
      return handleGetActiveSpec();
    case "complete_wave":
      return handleCompleteWave(args);
    case "update_task_status":
      return handleUpdateTaskStatus(args);
    case "record_spec_evaluator_score":
      return handleRecordSpecEvaluatorScore(args);
    case "archive_spec":
      return handleArchiveSpec(args);
    case "get_pending_fixes": {
      const state = readPendingFixes();
      if (state.fixes.length === 0) {
        return { content: [{ type: "text", text: "No pending fixes." }] };
      }
      const lines = [`${state.fixes.length} pending fix(es):
`];
      for (const fix of state.fixes) {
        lines.push(`[${fix.detector}] (${fix.severity}) ${fix.file}${fix.line ? `:${fix.line}` : ""}`);
        lines.push(`  ${fix.message}`);
      }
      return { content: [{ type: "text", text: lines.join(`
`) }] };
    }
    case "get_project_status": {
      const cur = readCurrent();
      const config = loadConfig();
      let activeSpec = null;
      try {
        activeSpec = getActiveSpec();
      } catch {
        activeSpec = null;
      }
      const enriched = {
        path: cwd,
        test_passed_at: cur.test_passed_at,
        test_command: cur.test_command,
        review_completed_at: cur.review_completed_at,
        review_score: cur.review_score,
        finish_started_at: cur.finish_started_at,
        human_approval_at: cur.human_approval_at,
        review_models: config.review.models,
        review_config: config.review,
        active_spec: activeSpec ? {
          name: activeSpec.name,
          has_requirements: activeSpec.hasRequirements,
          has_design: activeSpec.hasDesign,
          has_tasks: activeSpec.hasTasks
        } : null
      };
      return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
    }
    case "disable_gate": {
      const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!gateName) {
        return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
      }
      if (!reason || reason.length < 10 || new Set(reason).size < 5) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." }
          ]
        };
      }
      if (!isValidGateName(gateName)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown gate '${gateName}'. Valid: ${VALID_DETECTOR_GATES.join(", ")}`
            }
          ]
        };
      }
      const disabledNames = listDisabledGateNames();
      if (!disabledNames.includes(gateName) && disabledNames.length >= 2) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Maximum 2 gates disabled. Currently: ${disabledNames.join(", ")}`
            }
          ]
        };
      }
      disableGate(gateName, reason);
      appendAuditLog({
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
      enableGate(gateName);
      return { content: [{ type: "text", text: `Gate '${gateName}' re-enabled.` }] };
    }
    case "set_config": {
      const key = typeof args?.key === "string" ? args.key : null;
      const rawValue = args?.value;
      const value = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? rawValue : typeof rawValue === "boolean" ? rawValue : null;
      if (!key || value === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing key or value parameter." }]
        };
      }
      const ALLOWED_NUMBER_KEYS = [
        "review.score_threshold",
        "review.max_iterations",
        "review.required_changed_files",
        "review.dimension_floor",
        "plan_eval.score_threshold",
        "plan_eval.max_iterations"
      ];
      const ALLOWED_MODEL_KEYS = [
        "review.models.spec",
        "review.models.quality",
        "review.models.security",
        "review.models.adversarial",
        "plan_eval.models.generator",
        "plan_eval.models.evaluator"
      ];
      const ALLOWED_BOOLEAN_KEYS = ["review.require_human_approval", "review.low_only_passes"];
      const ALL_ALLOWED = [...ALLOWED_NUMBER_KEYS, ...ALLOWED_MODEL_KEYS, ...ALLOWED_BOOLEAN_KEYS];
      if (!ALL_ALLOWED.includes(key)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid key. Allowed: ${ALL_ALLOWED.join(", ")}` }]
        };
      }
      if (ALLOWED_NUMBER_KEYS.includes(key) && typeof value !== "number") {
        return {
          isError: true,
          content: [{ type: "text", text: `Key '${key}' requires a number value.` }]
        };
      }
      if (ALLOWED_MODEL_KEYS.includes(key)) {
        const VALID_MODELS = ["sonnet", "opus", "haiku", "inherit"];
        if (typeof value !== "string" || !VALID_MODELS.includes(value)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Model must be one of: ${VALID_MODELS.join(", ")}` }]
          };
        }
      }
      if (ALLOWED_BOOLEAN_KEYS.includes(key) && typeof value !== "boolean") {
        return {
          isError: true,
          content: [{ type: "text", text: `Key '${key}' requires a boolean value.` }]
        };
      }
      if (key === "review.dimension_floor" && typeof value === "number" && (value < 1 || value > 5)) {
        return { isError: true, content: [{ type: "text", text: "dimension_floor must be 1-5." }] };
      }
      setConfigKey(key, value);
      resetConfigCache();
      return { content: [{ type: "text", text: `Config set: ${key} = ${value}` }] };
    }
    case "clear_pending_fixes": {
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!reason || reason.length < 10 || new Set(reason).size < 5) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." }
          ]
        };
      }
      clearPendingFixes();
      appendAuditLog({
        action: "clear_pending_fixes",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
    }
    case "get_detector_summary": {
      const state = readPendingFixes();
      const lines = [];
      if (state.fixes.length > 0) {
        const byDetector = {};
        for (const fix of state.fixes) {
          const d = fix.detector || "unknown";
          if (!byDetector[d])
            byDetector[d] = [];
          byDetector[d].push(fix);
        }
        for (const [detector, fixes] of Object.entries(byDetector)) {
          lines.push(`
[${detector}] ${fixes.length} issue(s):`);
          for (const fix of fixes) {
            const relPath = fix.file.startsWith(`${cwd}/`) ? fix.file.slice(cwd.length + 1) : fix.file;
            const loc = fix.line ? `:${fix.line}` : "";
            lines.push(`  (${fix.severity}) ${relPath}${loc}`);
            lines.push(`    ${fix.message.slice(0, 200)}`);
          }
        }
      }
      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No detector findings." }] };
      }
      return { content: [{ type: "text", text: lines.join(`
`) }] };
    }
    case "get_file_health_score": {
      const filePath = typeof args?.file_path === "string" ? args.file_path : "";
      if (!filePath) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ score: 10, breakdown: {}, error: "file_path required" })
            }
          ]
        };
      }
      const resolvedHealth = resolve6(filePath);
      if (!resolvedHealth.startsWith(`${cwd}/`)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                score: 10,
                breakdown: {},
                error: "file_path must be within project directory"
              })
            }
          ]
        };
      }
      try {
        const result = computeFileHealthScore(resolvedHealth);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ score: 10, breakdown: {} }) }] };
      }
    }
    case "record_review": {
      const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
      patchCurrent({
        review_completed_at: new Date().toISOString(),
        review_score: score
      });
      const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
      return { content: [{ type: "text", text: msg }] };
    }
    case "record_test_pass": {
      const cmd = typeof args?.command === "string" ? args.command : null;
      if (!cmd) {
        return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
      }
      patchCurrent({
        test_passed_at: new Date().toISOString(),
        test_command: cmd
      });
      return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
    }
    case "record_human_approval": {
      const cur = readCurrent();
      if (!cur.review_completed_at) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Cannot record approval: no review completed. Run /qult:review first."
            }
          ]
        };
      }
      patchCurrent({ human_approval_at: new Date().toISOString() });
      appendAuditLog({
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
          content: [{ type: "text", text: `Invalid stage. Must be: ${validStages.join(", ")}` }]
        };
      }
      const dimRecord = {};
      for (const [dim, val] of Object.entries(scores)) {
        if (typeof val === "number")
          dimRecord[dim] = val;
      }
      recordReviewStage(stage, dimRecord);
      return {
        content: [
          { type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` }
        ]
      };
    }
    case "record_finish_started": {
      patchCurrent({ finish_started_at: new Date().toISOString() });
      return { content: [{ type: "text", text: "Finish started recorded." }] };
    }
    case "get_impact_analysis": {
      const file = typeof args?.file === "string" ? args.file : "";
      if (!file) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing file parameter." }]
        };
      }
      try {
        const config = loadConfig();
        const consumers = findImporters(file, cwd, config.gates.import_graph_depth);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ file, consumers, count: consumers.length })
            }
          ]
        };
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ file, consumers: [], count: 0 }) }]
        };
      }
    }
    case "get_call_coverage": {
      const testFile = typeof args?.test_file === "string" ? args.test_file : "";
      const implFile = typeof args?.impl_file === "string" ? args.impl_file : "";
      if (!testFile || !implFile) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing test_file or impl_file parameter." }]
        };
      }
      try {
        const covered = validateTestCoversImpl(testFile, "", implFile, cwd);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ test_file: testFile, impl_file: implFile, covered })
            }
          ]
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ test_file: testFile, impl_file: implFile, covered: false })
            }
          ]
        };
      }
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
            "qult is a quality aid for Claude. It provides workflow rules (at ~/.claude/rules/qult-*.md), independent reviewers, and Tier 1 detectors as MCP tools.",
            "",
            "Run /qult:init once after installing qult to install workflow rules to ~/.claude/rules/.",
            "",
            "## Workflow",
            "- Plan \u2192 Implement \u2192 Review \u2192 Finish",
            "- For any non-trivial work: use /qult:plan-generator (do NOT use EnterPlanMode directly; it bypasses plan-evaluator).",
            "- Track each plan task with TaskCreate; mark [done] as you complete them.",
            "- For changes spanning 5+ files or any commit with an active plan: run /qult:review (4-stage independent review).",
            "- After implementation completes: use /qult:finish for the structured completion checklist.",
            "",
            "## State recording (authoritative)",
            "- After running tests successfully: call record_test_pass with the test command.",
            "- At the end of /qult:review: record_review with the aggregate score.",
            "- During /qult:finish: record_finish_started.",
            "- Before committing: call get_project_status to verify test/review gates.",
            "",
            "## Tier 1 detectors (reviewer ground truth)",
            "- Before /qult:review: call get_detector_summary to collect detector findings (security, dep-vuln, hallucinated-package, test-quality, export-check).",
            "- Reviewers must NOT contradict detector findings \u2014 cross-validation will flag 'No issues found' when detectors reported problems.",
            "",
            "## Human approval",
            "- If review.require_human_approval is enabled, call record_human_approval after the architect has reviewed and approved.",
            "",
            "## Impact analysis",
            "- After modifying types or exported interfaces: call get_impact_analysis to find affected consumer files.",
            "- Use get_call_coverage to verify a test file imports and exercises the implementation under test."
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
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
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
export {
  handleTool,
  handleRequest,
  TOOL_DEFS
};
