// @bun
var __require = import.meta.require;

// src/mcp-server.ts
import { existsSync as existsSync10 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join5, resolve as resolve4 } from "path";
import { createInterface } from "readline";

// src/state/db.ts
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var SCHEMA_VERSION = 5;
var DB_DIR = join(homedir(), ".qult");
var DB_PATH = join(DB_DIR, "qult.db");
var DEFAULT_SESSION_ID = "__default__";
var _db = null;
function getDb() {
  if (_db)
    return _db;
  mkdirSync(DB_DIR, { recursive: true, mode: 448 });
  try {
    chmodSync(DB_DIR, 448);
  } catch {}
  _db = new Database(DB_PATH);
  configurePragmas(_db);
  migrateSchema(_db);
  return _db;
}
function configurePragmas(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}
function migrateSchema(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= SCHEMA_VERSION)
    return;
  if (version < 1) {
    createTablesV1(db);
  }
  if (version < 2) {
    db.exec("DROP TABLE IF EXISTS calibration");
  }
  if (version < 3) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN semantic_warning_count INTEGER NOT NULL DEFAULT 0");
    } catch {}
  }
  if (version < 4) {
    const v4Columns = [
      "test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
      "duplication_warning_count INTEGER NOT NULL DEFAULT 0",
      "semantic_warning_count INTEGER NOT NULL DEFAULT 0",
      "drift_warning_count INTEGER NOT NULL DEFAULT 0",
      "escalation_hit INTEGER NOT NULL DEFAULT 0"
    ];
    for (const col of v4Columns) {
      try {
        db.exec(`ALTER TABLE session_metrics ADD COLUMN ${col}`);
      } catch {}
    }
  }
  if (version < 5) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		)`);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
function createTablesV1(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id         INTEGER PRIMARY KEY,
			path       TEXT    NOT NULL UNIQUE,
			created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id                          TEXT    PRIMARY KEY,
			project_id                  INTEGER NOT NULL REFERENCES projects(id),
			started_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			last_commit_at              TEXT,
			test_passed_at              TEXT,
			test_command                TEXT,
			review_completed_at         TEXT,
			review_iteration            INTEGER NOT NULL DEFAULT 0,
			plan_eval_iteration         INTEGER NOT NULL DEFAULT 0,
			plan_selfcheck_blocked_at   TEXT,
			human_review_approved_at    TEXT,
			security_warning_count      INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count  INTEGER NOT NULL DEFAULT 0,
			drift_warning_count         INTEGER NOT NULL DEFAULT 0,
			dead_import_warning_count   INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count   INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count     INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

		CREATE TABLE IF NOT EXISTS pending_fixes (
			id         INTEGER PRIMARY KEY,
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			gate       TEXT    NOT NULL,
			errors     TEXT    NOT NULL,
			UNIQUE(session_id, file, gate)
		);
		CREATE INDEX IF NOT EXISTS idx_pending_fixes_session ON pending_fixes(session_id);

		CREATE TABLE IF NOT EXISTS changed_files (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file_path  TEXT NOT NULL,
			changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, file_path)
		);

		CREATE TABLE IF NOT EXISTS disabled_gates (
			session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			gate_name   TEXT NOT NULL,
			reason      TEXT NOT NULL,
			disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, gate_name)
		);

		CREATE TABLE IF NOT EXISTS ran_gates (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			gate_name  TEXT NOT NULL,
			ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, gate_name)
		);

		CREATE TABLE IF NOT EXISTS task_verify_results (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			task_key   TEXT    NOT NULL,
			passed     INTEGER NOT NULL,
			ran_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, task_key)
		);

		CREATE TABLE IF NOT EXISTS gate_failure_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			gate       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file, gate)
		);

		CREATE TABLE IF NOT EXISTS review_scores (
			id              INTEGER PRIMARY KEY,
			session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			iteration       INTEGER NOT NULL,
			aggregate_score REAL    NOT NULL,
			recorded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, iteration)
		);
		CREATE INDEX IF NOT EXISTS idx_review_scores_session ON review_scores(session_id);

		CREATE TABLE IF NOT EXISTS review_stage_scores (
			id          INTEGER PRIMARY KEY,
			session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			stage       TEXT NOT NULL,
			dimension   TEXT NOT NULL,
			score       REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, stage, dimension)
		);
		CREATE INDEX IF NOT EXISTS idx_stage_scores_session ON review_stage_scores(session_id);

		CREATE TABLE IF NOT EXISTS plan_eval_scores (
			id              INTEGER PRIMARY KEY,
			session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			iteration       INTEGER NOT NULL,
			aggregate_score REAL    NOT NULL,
			recorded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, iteration)
		);

		CREATE TABLE IF NOT EXISTS gate_configs (
			project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			phase              TEXT    NOT NULL,
			gate_name          TEXT    NOT NULL,
			command            TEXT    NOT NULL,
			timeout            INTEGER,
			run_once_per_batch INTEGER NOT NULL DEFAULT 0,
			extensions         TEXT,
			PRIMARY KEY (project_id, phase, gate_name)
		);

		CREATE TABLE IF NOT EXISTS project_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			key        TEXT    NOT NULL,
			value      TEXT    NOT NULL,
			PRIMARY KEY (project_id, key)
		);

		CREATE TABLE IF NOT EXISTS global_configs (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS audit_log (
			id         INTEGER PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			session_id TEXT,
			action     TEXT NOT NULL,
			gate_name  TEXT,
			reason     TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);

		CREATE TABLE IF NOT EXISTS session_metrics (
			id                              INTEGER PRIMARY KEY,
			session_id                      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			project_id                      INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count              INTEGER NOT NULL DEFAULT 0,
			security_warning_count          INTEGER NOT NULL DEFAULT 0,
			review_aggregate                REAL,
			files_changed                   INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count      INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count       INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count          INTEGER NOT NULL DEFAULT 0,
			drift_warning_count             INTEGER NOT NULL DEFAULT 0,
			escalation_hit                  INTEGER NOT NULL DEFAULT 0,
			recorded_at                     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_metrics_project ON session_metrics(project_id);

		CREATE TABLE IF NOT EXISTS review_findings (
			id          INTEGER PRIMARY KEY,
			session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			project_id  INTEGER NOT NULL REFERENCES projects(id),
			file        TEXT    NOT NULL,
			severity    TEXT    NOT NULL,
			description TEXT    NOT NULL,
			stage       TEXT    NOT NULL,
			recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_review_findings_session ON review_findings(session_id);
		CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		);
	`);
}
var _projectIdCache = null;
var _projectPathCache = null;
function setProjectPath(path) {
  if (path === _projectPathCache)
    return;
  _projectPathCache = path;
  _projectIdCache = null;
}
function getProjectId() {
  if (_projectIdCache !== null)
    return _projectIdCache;
  const path = _projectPathCache ?? process.cwd();
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO projects (path) VALUES (?)").run(path);
  const row = db.prepare("SELECT id FROM projects WHERE path = ?").get(path);
  if (!row)
    throw new Error(`Failed to resolve project: ${path}`);
  _projectIdCache = row.id;
  return _projectIdCache;
}
var _sessionId = DEFAULT_SESSION_ID;
function setSessionScope(sessionId) {
  if (!/^[\w.\-:]+$/.test(sessionId)) {
    process.stderr.write(`[qult] Ignoring invalid session_id (contains illegal characters): ${sessionId.slice(0, 64)}
`);
    return false;
  }
  _sessionId = sessionId;
  return true;
}
function getSessionId() {
  return _sessionId;
}
function ensureSession() {
  const db = getDb();
  const projectId = getProjectId();
  db.prepare("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)").run(_sessionId, projectId);
}
function findLatestSessionId() {
  const db = getDb();
  const projectId = getProjectId();
  const row = db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1").get(projectId);
  return row?.id ?? null;
}

// src/config.ts
var DEFAULTS = {
  review: {
    score_threshold: 30,
    max_iterations: 3,
    required_changed_files: 5,
    dimension_floor: 4,
    require_human_approval: false,
    models: {
      spec: "sonnet",
      quality: "opus",
      security: "opus",
      adversarial: "sonnet"
    }
  },
  plan_eval: {
    score_threshold: 12,
    max_iterations: 2,
    registry_files: [],
    models: {
      generator: "opus",
      evaluator: "opus"
    }
  },
  gates: {
    output_max_chars: 3500,
    default_timeout: 1e4,
    test_on_edit: false,
    test_on_edit_timeout: 15000,
    extra_path: []
  },
  security: {
    require_semgrep: true
  },
  escalation: {
    security_threshold: 10,
    drift_threshold: 8,
    test_quality_threshold: 8,
    duplication_threshold: 8,
    semantic_threshold: 8,
    security_iterative_threshold: 5,
    dead_import_blocking_threshold: 5
  },
  flywheel: {
    enabled: true,
    min_sessions: 10
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
    if (typeof g.test_on_edit === "boolean")
      config.gates.test_on_edit = g.test_on_edit;
    if (typeof g.test_on_edit_timeout === "number")
      config.gates.test_on_edit_timeout = g.test_on_edit_timeout;
    if (Array.isArray(g.extra_path))
      config.gates.extra_path = g.extra_path.filter((p) => typeof p === "string" && p.trim().length > 0);
  }
  if (raw.security && typeof raw.security === "object") {
    const s = raw.security;
    if (typeof s.require_semgrep === "boolean")
      config.security.require_semgrep = s.require_semgrep;
  }
  if (raw.escalation && typeof raw.escalation === "object") {
    const e = raw.escalation;
    if (typeof e.security_threshold === "number")
      config.escalation.security_threshold = Math.max(1, e.security_threshold);
    if (typeof e.drift_threshold === "number")
      config.escalation.drift_threshold = Math.max(1, e.drift_threshold);
    if (typeof e.test_quality_threshold === "number")
      config.escalation.test_quality_threshold = Math.max(1, e.test_quality_threshold);
    if (typeof e.duplication_threshold === "number")
      config.escalation.duplication_threshold = Math.max(1, e.duplication_threshold);
    if (typeof e.semantic_threshold === "number")
      config.escalation.semantic_threshold = Math.max(1, e.semantic_threshold);
    if (typeof e.security_iterative_threshold === "number")
      config.escalation.security_iterative_threshold = Math.max(1, e.security_iterative_threshold);
    if (typeof e.dead_import_blocking_threshold === "number")
      config.escalation.dead_import_blocking_threshold = Math.max(1, e.dead_import_blocking_threshold);
  }
  if (raw.flywheel && typeof raw.flywheel === "object") {
    const f = raw.flywheel;
    if (typeof f.enabled === "boolean")
      config.flywheel.enabled = f.enabled;
    if (typeof f.min_sessions === "number")
      config.flywheel.min_sessions = Math.max(1, f.min_sessions);
  }
}
function kvRowsToRaw(rows) {
  const raw = {};
  for (const row of rows) {
    const parts = row.key.split(".");
    if (parts.length < 2)
      continue;
    const section = parts[0];
    if (!raw[section])
      raw[section] = {};
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    if (parts.length === 2) {
      raw[section][parts[1]] = parsed;
    } else if (parts.length === 3) {
      const sub = parts[1];
      if (!raw[section][sub] || typeof raw[section][sub] !== "object") {
        raw[section][sub] = {};
      }
      raw[section][sub][parts[2]] = parsed;
    }
  }
  return raw;
}
var _cache = null;
function loadConfig() {
  if (_cache)
    return _cache;
  const config = structuredClone(DEFAULTS);
  try {
    const db = getDb();
    const globalRows = db.prepare("SELECT key, value FROM global_configs").all();
    if (globalRows.length > 0) {
      applyConfigLayer(config, kvRowsToRaw(globalRows));
    }
  } catch {}
  try {
    const db = getDb();
    const projectId = getProjectId();
    const projectRows = db.prepare("SELECT key, value FROM project_configs WHERE project_id = ?").all(projectId);
    if (projectRows.length > 0) {
      applyConfigLayer(config, kvRowsToRaw(projectRows));
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
  const secEsc = envInt("QULT_ESCALATION_SECURITY");
  if (secEsc !== undefined)
    config.escalation.security_threshold = Math.max(1, secEsc);
  const driftEsc = envInt("QULT_ESCALATION_DRIFT");
  if (driftEsc !== undefined)
    config.escalation.drift_threshold = Math.max(1, driftEsc);
  const tqEsc = envInt("QULT_ESCALATION_TEST_QUALITY");
  if (tqEsc !== undefined)
    config.escalation.test_quality_threshold = Math.max(1, tqEsc);
  const dupEsc = envInt("QULT_ESCALATION_DUPLICATION");
  if (dupEsc !== undefined)
    config.escalation.duplication_threshold = Math.max(1, dupEsc);
  const semEsc = envInt("QULT_ESCALATION_SEMANTIC");
  if (semEsc !== undefined)
    config.escalation.semantic_threshold = Math.max(1, semEsc);
  const secIterEsc = envInt("QULT_ESCALATION_SECURITY_ITERATIVE");
  if (secIterEsc !== undefined)
    config.escalation.security_iterative_threshold = Math.max(1, secIterEsc);
  const deadImportEsc = envInt("QULT_ESCALATION_DEAD_IMPORT_BLOCKING");
  if (deadImportEsc !== undefined)
    config.escalation.dead_import_blocking_threshold = Math.max(1, deadImportEsc);
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
  const flywheelEnv = process.env.QULT_FLYWHEEL_ENABLED;
  if (flywheelEnv === "1" || flywheelEnv === "true")
    config.flywheel.enabled = true;
  else if (flywheelEnv === "0" || flywheelEnv === "false")
    config.flywheel.enabled = false;
  const flywheelMin = envInt("QULT_FLYWHEEL_MIN_SESSIONS");
  if (flywheelMin !== undefined)
    config.flywheel.min_sessions = Math.max(1, flywheelMin);
  _cache = config;
  return config;
}
function resetConfigCache() {
  _cache = null;
}

// src/gates/load.ts
var _cache2;
function loadGates() {
  if (_cache2 !== undefined)
    return _cache2;
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare("SELECT phase, gate_name, command, timeout, run_once_per_batch, extensions FROM gate_configs WHERE project_id = ?").all(projectId);
    if (rows.length === 0) {
      _cache2 = null;
      return null;
    }
    const config = {};
    for (const row of rows) {
      const phase = row.phase;
      if (!config[phase])
        config[phase] = {};
      const gate = { command: row.command };
      if (row.timeout !== null)
        gate.timeout = row.timeout;
      if (row.run_once_per_batch)
        gate.run_once_per_batch = true;
      if (row.extensions) {
        try {
          gate.extensions = JSON.parse(row.extensions);
        } catch {}
      }
      config[phase][row.gate_name] = gate;
    }
    _cache2 = config;
    return config;
  } catch {
    _cache2 = null;
    return null;
  }
}
function saveGates(gates) {
  const db = getDb();
  const projectId = getProjectId();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM gate_configs WHERE project_id = ?").run(projectId);
    const insert = db.prepare("INSERT INTO gate_configs (project_id, phase, gate_name, command, timeout, run_once_per_batch, extensions) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [phase, gateMap] of Object.entries(gates)) {
      if (!gateMap)
        continue;
      for (const [name, gate] of Object.entries(gateMap)) {
        insert.run(projectId, phase, name, gate.command, gate.timeout ?? null, gate.run_once_per_batch ? 1 : 0, gate.extensions ? JSON.stringify(gate.extensions) : null);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  _cache2 = undefined;
}

// src/handoff.ts
function generateHandoffDocument(input) {
  const { changedFiles, pendingFixes, planTasks, testPassed, reviewDone, disabledGates } = input;
  if (changedFiles.length === 0 && !planTasks && pendingFixes.length === 0) {
    return "No active session data to hand off.";
  }
  const sections = [];
  sections.push(`## Session Handoff
`);
  const gateLines = [];
  gateLines.push(`- Tests: ${testPassed ? "PASSED" : "NOT PASSED"}`);
  gateLines.push(`- Review: ${reviewDone ? "DONE" : "NOT DONE"}`);
  if (disabledGates.length > 0) {
    gateLines.push(`- Disabled gates: ${disabledGates.join(", ")}`);
  }
  sections.push(`## Gate Status
${gateLines.join(`
`)}
`);
  if (changedFiles.length > 0) {
    const fileList = changedFiles.map((f) => `- ${f}`).join(`
`);
    sections.push(`## Files Changed (${changedFiles.length})
${fileList}
`);
  }
  if (pendingFixes.length > 0) {
    const fixLines = pendingFixes.map((f) => `- [${f.gate}] ${f.file}: ${f.errors[0]?.slice(0, 150) ?? "error"}`).join(`
`);
    sections.push(`## Pending Fixes
${fixLines}
`);
  }
  if (planTasks && planTasks.length > 0) {
    const done = planTasks.filter((t) => t.status === "done").length;
    const taskLines = planTasks.map((t) => `- [${t.status}] ${t.taskNumber ? `Task ${t.taskNumber}: ` : ""}${t.name}`).join(`
`);
    sections.push(`## Plan Progress (${done}/${planTasks.length} done)
${taskLines}
`);
  }
  return sections.join(`
`);
}

// src/state/metrics.ts
var MAX_ENTRIES = 50;
function readMetricsHistory() {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare(`SELECT session_id, recorded_at, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit
				 FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?`).all(projectId, MAX_ENTRIES);
    return rows.map((r) => ({
      session_id: r.session_id,
      timestamp: r.recorded_at,
      gate_failures: r.gate_failure_count,
      security_warnings: r.security_warning_count,
      review_score: r.review_aggregate,
      files_changed: r.files_changed,
      test_quality_warnings: r.test_quality_warning_count ?? 0,
      duplication_warnings: r.duplication_warning_count ?? 0,
      semantic_warnings: r.semantic_warning_count ?? 0,
      drift_warnings: r.drift_warning_count ?? 0,
      escalation_hit: !!(r.escalation_hit ?? 0)
    }));
  } catch {
    return [];
  }
}
var METRIC_KEYS = [
  "gate_failures",
  "security_warnings",
  "test_quality_warnings",
  "duplication_warnings",
  "semantic_warnings",
  "drift_warnings"
];
var WINDOW_SIZES = [5, 10, 20];
function computeWindowStats(values) {
  const total = values.length;
  const nonZero = values.filter((v) => v > 0);
  const frequency = nonZero.length / total;
  const intensity = nonZero.length > 0 ? nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length : 0;
  const mid = Math.floor(total / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
  const diff = avgSecond - avgFirst;
  const threshold = Math.max(0.1, avgFirst * 0.1);
  const trend = diff > threshold ? "worsening" : diff < -threshold ? "improving" : "stable";
  return { frequency, intensity, trend, sessionCount: total };
}
function analyzePatterns(history) {
  const chronological = [...history].reverse();
  return METRIC_KEYS.map((metric) => {
    const windows = { short: null, medium: null, long: null };
    const windowEntries = [
      ["short", WINDOW_SIZES[0]],
      ["medium", WINDOW_SIZES[1]],
      ["long", WINDOW_SIZES[2]]
    ];
    for (const [key, size] of windowEntries) {
      if (chronological.length >= size) {
        const slice = chronological.slice(-size);
        const values = slice.map((s) => s[metric] ?? 0);
        windows[key] = computeWindowStats(values);
      }
    }
    return { metric, windows };
  });
}
var METRIC_TO_THRESHOLD = {
  security_warnings: { key: "security_threshold", name: "security" },
  test_quality_warnings: { key: "test_quality_threshold", name: "test quality" },
  duplication_warnings: { key: "duplication_threshold", name: "duplication" },
  semantic_warnings: { key: "semantic_threshold", name: "semantic" },
  drift_warnings: { key: "drift_threshold", name: "drift" }
};
function getFlywheelRecommendations(history, config) {
  if (!config.flywheel.enabled)
    return [];
  if (history.length < config.flywheel.min_sessions)
    return [];
  const analyses = analyzePatterns(history);
  const recs = [];
  for (const analysis of analyses) {
    const mapping = METRIC_TO_THRESHOLD[analysis.metric];
    if (!mapping)
      continue;
    const currentThreshold = config.escalation[mapping.key];
    const stats = analysis.windows.medium ?? analysis.windows.short;
    if (!stats)
      continue;
    const confidence = analysis.windows.long ? "high" : analysis.windows.medium ? "medium" : "low";
    if (stats.frequency > 0.8 && stats.trend === "worsening") {
      const suggested = Math.max(1, Math.floor(currentThreshold * 0.7));
      if (suggested < currentThreshold) {
        recs.push({
          metric: mapping.name,
          current_threshold: currentThreshold,
          suggested_threshold: suggested,
          direction: "lower",
          confidence,
          reason: `${mapping.name} warnings in ${(stats.frequency * 100).toFixed(0)}% of sessions with worsening trend`
        });
      }
    } else if (stats.frequency < 0.2 && stats.trend === "stable" && analysis.windows.long && analysis.windows.long.frequency < 0.2) {
      const suggested = Math.min(currentThreshold + 3, currentThreshold * 2, 100);
      if (suggested > currentThreshold) {
        recs.push({
          metric: mapping.name,
          current_threshold: currentThreshold,
          suggested_threshold: Math.floor(suggested),
          direction: "raise",
          confidence,
          reason: `${mapping.name} warnings in only ${(stats.frequency * 100).toFixed(0)}% of sessions, stable over ${stats.sessionCount} sessions`
        });
      }
    }
  }
  return recs;
}

// src/harness-report.ts
var MIN_TREND_SESSIONS = 3;
var IDLE_GATE_THRESHOLD = 10;
function generateHarnessReport(metrics, auditLog, config) {
  const recommendations = [];
  const gateFailureSessions = metrics.filter((m) => m.gate_failures > 0).length;
  const securityWarningSessions = metrics.filter((m) => m.security_warnings > 0).length;
  const reviewScores = metrics.filter((m) => m.review_score !== null).map((m) => m.review_score);
  const averageReviewScore = reviewScores.length > 0 ? reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length : null;
  const reviewTrend = computeReviewTrend(reviewScores);
  const disableEntries = auditLog.filter((e) => e.action === "disable_gate");
  const disablesByGate = {};
  for (const entry of disableEntries) {
    const gate = entry.gate_name ?? "unknown";
    disablesByGate[gate] = (disablesByGate[gate] ?? 0) + 1;
  }
  if (metrics.length >= IDLE_GATE_THRESHOLD && gateFailureSessions === 0) {
    recommendations.push({
      type: "idle_gate",
      message: `No gate failures in ${metrics.length} sessions. Consider reviewing if all gates are still necessary.`
    });
  }
  if (metrics.length >= 5 && securityWarningSessions >= Math.ceil(metrics.length * 0.6)) {
    recommendations.push({
      type: "security_recurring",
      message: `Security warnings in ${securityWarningSessions}/${metrics.length} sessions. Consider adding .claude/rules/ for security patterns.`
    });
  }
  let flywheel_recommendations = [];
  const metricTrends = {};
  if (config) {
    try {
      const analyses = analyzePatterns(metrics);
      for (const a of analyses) {
        metricTrends[a.metric] = a.windows;
      }
      flywheel_recommendations = getFlywheelRecommendations(metrics, config);
    } catch {}
  }
  return {
    totalSessions: metrics.length,
    gateFailureSessions,
    securityWarningSessions,
    averageReviewScore,
    reviewTrend,
    gateDisableCount: disableEntries.length,
    disablesByGate,
    recommendations,
    flywheel_recommendations,
    metricTrends
  };
}
function computeReviewTrend(scores) {
  if (scores.length < MIN_TREND_SESSIONS)
    return "insufficient_data";
  const recent = scores.slice(-MIN_TREND_SESSIONS);
  let improving = 0;
  let declining = 0;
  for (let i = 1;i < recent.length; i++) {
    if (recent[i] > recent[i - 1])
      improving++;
    else if (recent[i] < recent[i - 1])
      declining++;
  }
  if (improving > declining)
    return "improving";
  if (declining > improving)
    return "declining";
  return "stable";
}

// src/hooks/detectors/health-score.ts
import { existsSync as existsSync9 } from "fs";

// src/hooks/detectors/convention-check.ts
import { readdirSync, statSync } from "fs";
import { basename, dirname, extname, join as join2 } from "path";

// src/hooks/sanitize.ts
function sanitizeForStderr(input) {
  const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// src/hooks/detectors/convention-check.ts
var KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
var CAMEL_RE = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/;
var SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
var PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/;
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
  const dir = dirname(file);
  const fileName = basename(file);
  const stem = basename(fileName, extname(fileName));
  let siblings;
  try {
    siblings = readdirSync(dir).filter((f) => {
      try {
        return f !== fileName && statSync(join2(dir, f)).isFile();
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

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { extname as extname2 } from "path";

// src/state/plan-status.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync, renameSync, statSync as statSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { basename as basename2, dirname as dirname2, join as join3 } from "path";
var TASK_RE = /^###\s+Task\s+(\d+)[\s:\-\u2013\u2014]+(.+?)(?:\s*\[([^\]]+)\])?\s*$/i;
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
var CHECKBOX_RE = /^-\s+\[([ xX])\]\s*(.+)$/;
var FILE_LINE_RE = /^\s*-\s*\*\*File\*\*:\s*(.+)$/;
var VERIFY_LINE_RE = /^\s*-\s*\*\*Verify\*\*:\s*(.+)$/;
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
          file = fileMatch[1].trim().replace(/[`"']/g, "");
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
function scanPlanDir(dir) {
  try {
    if (!existsSync(dir))
      return [];
    return readdirSync2(dir).filter((f) => f.endsWith(".md")).map((f) => ({
      path: join3(dir, f),
      mtime: statSync2(join3(dir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
function getLatestPlanPath() {
  try {
    const candidates = [];
    const projectDir = join3(process.cwd(), ".claude", "plans");
    const projectPlans = scanPlanDir(projectDir);
    candidates.push(...projectPlans);
    const envDir = process.env.CLAUDE_PLANS_DIR;
    if (envDir) {
      candidates.push(...scanPlanDir(envDir));
    }
    if (!_disableHomeFallback && projectPlans.length === 0 && candidates.length === 0) {
      try {
        const homeDir = join3(homedir2(), ".claude", "plans");
        const homeFiles = scanPlanDir(homeDir);
        const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
        candidates.push(...homeFiles.filter((f) => f.mtime > recentCutoff));
      } catch {}
    }
    if (candidates.length === 0)
      return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].path;
  } catch {
    return null;
  }
}
var _planCache = null;
var _planCachePath = null;
var _planCacheMtime = null;
var _disableHomeFallback = false;
function getActivePlan() {
  const path = getLatestPlanPath();
  if (!path)
    return null;
  let mtime = null;
  try {
    mtime = statSync2(path).mtimeMs;
    if (_planCache && _planCachePath === path && _planCacheMtime === mtime)
      return _planCache;
  } catch {}
  try {
    const content = readFileSync(path, "utf-8");
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
function resetPlanCache() {
  _planCache = null;
  _planCachePath = null;
  _planCacheMtime = null;
}
function archivePlanFile(planPath) {
  try {
    if (!planPath.endsWith(".md"))
      return;
    if (!existsSync(planPath))
      return;
    const dir = dirname2(planPath);
    const archiveDir = join3(dir, "archive");
    mkdirSync2(archiveDir, { recursive: true });
    renameSync(planPath, join3(archiveDir, basename2(planPath)));
    resetPlanCache();
  } catch {}
}

// src/state/session-state.ts
var _cache3 = null;
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
    semantic_warning_count: 0,
    human_review_approved_at: null
  };
}
function readSessionState() {
  if (_cache3)
    return _cache3;
  try {
    const db = getDb();
    const sid = getSessionId();
    ensureSession();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
    if (!row) {
      _cache3 = defaultState();
      return _cache3;
    }
    const state = defaultState();
    state.last_commit_at = row.last_commit_at ?? state.last_commit_at;
    state.test_passed_at = row.test_passed_at ?? null;
    state.test_command = row.test_command ?? null;
    state.review_completed_at = row.review_completed_at ?? null;
    state.review_iteration = row.review_iteration ?? 0;
    state.plan_eval_iteration = row.plan_eval_iteration ?? 0;
    state.plan_selfcheck_blocked_at = row.plan_selfcheck_blocked_at ?? null;
    state.human_review_approved_at = row.human_review_approved_at ?? null;
    state.security_warning_count = row.security_warning_count ?? 0;
    state.test_quality_warning_count = row.test_quality_warning_count ?? 0;
    state.drift_warning_count = row.drift_warning_count ?? 0;
    state.dead_import_warning_count = row.dead_import_warning_count ?? 0;
    state.duplication_warning_count = row.duplication_warning_count ?? 0;
    state.semantic_warning_count = row.semantic_warning_count ?? 0;
    const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE session_id = ?").all(sid);
    state.changed_file_paths = changedFiles.map((r) => r.file_path);
    const disabledGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?").all(sid);
    state.disabled_gates = disabledGates.map((r) => r.gate_name);
    const ranGates = db.prepare("SELECT gate_name, ran_at FROM ran_gates WHERE session_id = ?").all(sid);
    for (const g of ranGates) {
      state.ran_gates[g.gate_name] = { session_id: sid, ran_at: g.ran_at };
    }
    const taskResults = db.prepare("SELECT task_key, passed, ran_at FROM task_verify_results WHERE session_id = ?").all(sid);
    for (const t of taskResults) {
      state.task_verify_results[t.task_key] = { passed: !!t.passed, ran_at: t.ran_at };
    }
    const gateFailures = db.prepare("SELECT file, gate, count FROM gate_failure_counts WHERE session_id = ?").all(sid);
    for (const f of gateFailures) {
      state.gate_failure_counts[`${f.file}:${f.gate}`] = f.count;
    }
    const reviewScores = db.prepare("SELECT aggregate_score FROM review_scores WHERE session_id = ? ORDER BY iteration").all(sid);
    state.review_score_history = reviewScores.map((r) => r.aggregate_score);
    const stageScores = db.prepare("SELECT stage, dimension, score FROM review_stage_scores WHERE session_id = ?").all(sid);
    for (const s of stageScores) {
      if (!state.review_stage_scores[s.stage])
        state.review_stage_scores[s.stage] = {};
      state.review_stage_scores[s.stage][s.dimension] = s.score;
    }
    const planScores = db.prepare("SELECT aggregate_score FROM plan_eval_scores WHERE session_id = ? ORDER BY iteration").all(sid);
    state.plan_eval_score_history = planScores.map((r) => r.aggregate_score);
    _cache3 = state;
    return state;
  } catch {
    _cache3 = defaultState();
    return _cache3;
  }
}
function isGateDisabled(gateName) {
  const state = readSessionState();
  return (state.disabled_gates ?? []).includes(gateName);
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
  const ext = extname2(file).toLowerCase();
  if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext))
    return [];
  if (!existsSync2(file))
    return [];
  let content;
  try {
    content = readFileSync2(file, "utf-8");
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

// src/hooks/detectors/duplication-check.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { basename as basename3, dirname as dirname3, extname as extname3, resolve } from "path";
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
  ".kt"
]);
var MAX_CHECK_SIZE2 = 500000;
var MIN_BLOCK_LINES = 4;
function isTestFile(filePath) {
  const name = basename3(filePath);
  if (/\.(test|spec)\.[^.]+$/.test(name))
    return true;
  const parent = basename3(dirname3(filePath));
  return parent === "__tests__";
}
function normalizeLine(line) {
  const trimmed = line.trim();
  if (trimmed === "")
    return null;
  if (trimmed.startsWith("//") || trimmed.startsWith("#"))
    return null;
  if (trimmed.startsWith("* ") || trimmed.startsWith("*/") || trimmed === "*")
    return null;
  if (trimmed.startsWith("/*"))
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
  if (isTestFile(file))
    return [];
  if (isGateDisabled("duplication-check"))
    return [];
  const ext = extname3(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync3(file))
    return [];
  let content;
  try {
    content = readFileSync3(file, "utf-8");
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

// src/hooks/detectors/export-check.ts
import { execSync } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { extname as extname4 } from "path";
var TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
function detectExportBreakingChanges(file) {
  if (isGateDisabled("export-check"))
    return [];
  const ext = extname4(file).toLowerCase();
  if (!TS_JS_EXTS2.has(ext))
    return [];
  if (!existsSync4(file))
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

// src/hooks/detectors/import-check.ts
import { existsSync as existsSync5, readdirSync as readdirSync3, readFileSync as readFileSync5 } from "fs";
import { extname as extname5, join as join4, resolve as resolve2 } from "path";
var TS_JS_EXTS3 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var PY_EXTS2 = new Set([".py", ".pyi"]);
var GO_EXTS = new Set([".go"]);
var IMPORT_LINE_RE = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"'./][^"']*)["']/;
var PY_IMPORT_RE2 = /^\s*(?:import\s+(\w+)|from\s+(\w+)\s+import)\b/;
var MAX_IMPORT_CHECK_SIZE = 500000;
function detectHallucinatedImports(file) {
  if (isGateDisabled("import-check"))
    return [];
  const ext = extname5(file).toLowerCase();
  if (!TS_JS_EXTS3.has(ext) && !PY_EXTS2.has(ext) && !GO_EXTS.has(ext))
    return [];
  if (!existsSync5(file))
    return [];
  const content = readFileSync5(file, "utf-8");
  if (content.length > MAX_IMPORT_CHECK_SIZE)
    return [];
  if (PY_EXTS2.has(ext))
    return detectPythonImports(file, content);
  if (GO_EXTS.has(ext))
    return detectGoImports(file, content);
  return detectTsJsImports(file, content);
}
function loadTsConfigPaths(cwd) {
  const aliases = new Set;
  try {
    const tsconfigPath = join4(cwd, "tsconfig.json");
    if (!existsSync5(tsconfigPath))
      return aliases;
    const raw = readFileSync5(tsconfigPath, "utf-8");
    const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const tsconfig = JSON.parse(cleaned);
    const paths = tsconfig?.compilerOptions?.paths;
    if (paths && typeof paths === "object") {
      for (const alias of Object.keys(paths)) {
        aliases.add(alias.replace(/\/\*$/, ""));
      }
    }
  } catch {}
  return aliases;
}
function detectTsJsImports(file, content) {
  const cwd = process.cwd();
  const missingPkgs = [];
  let builtins;
  try {
    builtins = new Set(__require("module").builtinModules);
  } catch {
    builtins = FALLBACK_BUILTINS;
  }
  const tsPaths = loadTsConfigPaths(cwd);
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
    if (tsPaths.has(pkgName) || tsPaths.has(specifier.replace(/\/.*$/, "")))
      continue;
    if (!existsSync5(join4(cwd, "node_modules", pkgName))) {
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
    if (existsSync5(join4(cwd, `${moduleName}.py`)) || existsSync5(join4(cwd, moduleName)))
      continue;
    if (sitePackagesDirs.some((dir) => existsSync5(join4(dir, moduleName)) || existsSync5(join4(dir, `${moduleName}.py`))))
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
var GO_IMPORT_RE = /^\s*"([^"]+)"/;
function detectGoImports(file, content) {
  const cwd = process.cwd();
  const missingPkgs = [];
  let goSum = null;
  try {
    goSum = readFileSync5(join4(cwd, "go.sum"), "utf-8");
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
    if (vendorPath.startsWith(`${vendorDir}/`) && existsSync5(vendorPath))
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
var GO_STDLIB_PREFIXES = new Set([
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
var FALLBACK_BUILTINS = new Set([
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
var PY_STDLIB = new Set([
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
function findPythonSitePackages(cwd) {
  const dirs = [];
  const venvRoots = [join4(cwd, ".venv"), join4(cwd, "venv")];
  for (const root of venvRoots) {
    try {
      if (!existsSync5(root))
        continue;
      const libDir = join4(root, "lib");
      if (!existsSync5(libDir))
        continue;
      const entries = readdirSync3(libDir).filter((e) => e.startsWith("python"));
      for (const entry of entries) {
        const sp = join4(libDir, entry, "site-packages");
        if (existsSync5(sp))
          dirs.push(sp);
      }
    } catch {}
  }
  return dirs;
}

// src/hooks/detectors/security-check.ts
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "fs";
import { basename as basename4, extname as extname6 } from "path";
var CHECKABLE_EXTS2 = new Set([
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
var MAX_CHECK_SIZE3 = 500000;
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
var PY_EXTS3 = new Set([".py", ".pyi"]);
var GO_EXTS2 = new Set([".go"]);
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
    exts: PY_EXTS3
  },
  {
    re: /\b(?:eval|exec)\s*\(\s*(?!["'])[a-zA-Z_]/,
    desc: "eval/exec with dynamic input \u2014 code injection risk",
    exts: PY_EXTS3
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
    exts: PY_EXTS3
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
    exts: PY_EXTS3
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
    exts: GO_EXTS2
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
  const ext = extname6(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (!existsSync6(file))
    return [];
  let content;
  try {
    content = readFileSync6(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE3)
    return [];
  const errors = [];
  const lines = content.split(`
`);
  const fileName = file.split("/").pop() ?? "";
  const isTestFile2 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_") || fileName.includes("_test.");
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
    if (!isTestFile2) {
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
        if (suppressFile?.test(basename4(file)))
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
  const ext = extname6(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (content.length > MAX_CHECK_SIZE3)
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

// src/hooks/detectors/semantic-check.ts
import { existsSync as existsSync7, readFileSync as readFileSync7 } from "fs";
import { extname as extname7 } from "path";
var JS_TS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var PY_EXTS4 = new Set([".py", ".pyi"]);
var CHECKABLE_EXTS3 = new Set([...JS_TS_EXTS2, ...PY_EXTS4, ".go", ".rs", ".rb", ".java", ".kt"]);
var MAX_CHECK_SIZE4 = 500000;
var INTENTIONAL_RE = /(?:\/\/|\/\*|#)\s*(?:fail-open|intentional|deliberate|nolint|noqa|NOLINT)/i;
function detectEmptyCatch(lines) {
  const errors = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*"))
      continue;
    if (!/\bcatch\b/.test(trimmed))
      continue;
    if (!trimmed.includes("{"))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    if (i > 0 && INTENTIONAL_RE.test(lines[i - 1]))
      continue;
    const afterBrace = trimmed.slice(trimmed.indexOf("{") + 1);
    if (/^\s*\}/.test(afterBrace)) {
      errors.push(`L${i + 1}: Empty catch block \u2014 errors silently swallowed`);
      continue;
    }
    if (afterBrace.trim() === "") {
      const next = lines[i + 1]?.trimStart() ?? "";
      if (INTENTIONAL_RE.test(lines[i + 1] ?? ""))
        continue;
      if (/^\}/.test(next)) {
        errors.push(`L${i + 1}: Empty catch block \u2014 errors silently swallowed`);
      }
    }
  }
  return errors;
}
var PURE_METHODS_RE = /^\s*(?:[a-zA-Z_$][\w$.]*\s*\.\s*)?(?:map|filter|reduce|flatMap|flat|slice|concat|toSorted|toReversed|toSpliced|replace|replaceAll|trim|trimStart|trimEnd|padStart|padEnd|substring|toLowerCase|toUpperCase)\s*\(/;
var CHAIN_CONTINUATION_RE = /\)\s*\./;
function detectIgnoredReturn(lines) {
  const errors = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*"))
      continue;
    if (!PURE_METHODS_RE.test(trimmed))
      continue;
    if (/(?:^|[\s(,=])\b(?:return|const|let|var|yield|await)\s/.test(trimmed))
      continue;
    if (/=\s*(?:[a-zA-Z_$][\w$.]*\s*\.\s*)?(?:map|filter|reduce)/.test(trimmed))
      continue;
    if (CHAIN_CONTINUATION_RE.test(line))
      continue;
    const nextLine = lines[i + 1]?.trimStart() ?? "";
    if (nextLine.startsWith("."))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    errors.push(`L${i + 1}: Return value of pure method discarded \u2014 probable no-op (assign or remove)`);
  }
  return errors;
}
var CONDITION_ASSIGNMENT_RE = /\b(?:if|while)\s*\(.*[^!=<>]=(?!=)[^=]/;
var DESTRUCTURE_RE = /\b(?:const|let|var)\s/;
function detectConditionAssignment(lines) {
  const errors = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*"))
      continue;
    if (!CONDITION_ASSIGNMENT_RE.test(trimmed))
      continue;
    if (DESTRUCTURE_RE.test(trimmed))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    if (i > 0 && INTENTIONAL_RE.test(lines[i - 1]))
      continue;
    const condMatch = trimmed.match(/\b(?:if|while)\s*\((.+)\)/);
    if (!condMatch)
      continue;
    const cond = condMatch[1];
    const stripped = cond.replace(/(?:[!=<>]=|=>|===|!==)/g, "");
    if (!stripped.includes("="))
      continue;
    errors.push(`L${i + 1}: Assignment (=) inside condition \u2014 use === for comparison`);
  }
  return errors;
}
function detectUnreachableCode(lines) {
  const errors = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*"))
      continue;
    if (!/^\s*(?:return\b|throw\b)/.test(line))
      continue;
    const openBraces = (trimmed.match(/\{/g) ?? []).length;
    const closeBraces = (trimmed.match(/\}/g) ?? []).length;
    if (openBraces > closeBraces)
      continue;
    for (let j = i + 1;j < lines.length; j++) {
      const nextTrimmed = lines[j].trimStart();
      if (nextTrimmed === "")
        continue;
      if (nextTrimmed.startsWith("//") || nextTrimmed.startsWith("*"))
        continue;
      if (nextTrimmed.startsWith("}"))
        break;
      if (INTENTIONAL_RE.test(lines[j]))
        break;
      if (INTENTIONAL_RE.test(line))
        break;
      errors.push(`L${j + 1}: Unreachable code after return/throw at L${i + 1}`);
      break;
    }
  }
  return errors;
}
var LOOSE_EQ_RE = /(?<![!=])(?:==|!=)(?!=)/;
var NULL_COALESCE_RE = /(?:==|!=)\s*null\b/;
var STRING_LITERAL_RE = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/g;
function detectLooseEquality(lines) {
  const errors = [];
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*"))
      continue;
    const stripped = trimmed.replace(STRING_LITERAL_RE, '""');
    if (!LOOSE_EQ_RE.test(stripped))
      continue;
    if (NULL_COALESCE_RE.test(stripped))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    errors.push(`L${i + 1}: Loose equality (== or !=) \u2014 use === or !== for strict comparison`);
  }
  return errors;
}
var CASE_OR_DEFAULT_RE = /^\s*(?:case\b|default\s*:)/;
var BREAK_RE = /^\s*(?:break|return|throw|continue)\b/;
var FALLTHROUGH_COMMENT_RE = /(?:\/\/|\/\*)\s*fall\s*-?\s*through/i;
function detectSwitchFallthrough(lines) {
  const errors = [];
  let inCase = false;
  let caseStartLine = 0;
  let hasBreak = false;
  let hasFallthroughComment = false;
  let hasIntentional = false;
  let hasCode = false;
  let braceDepth = 0;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (CASE_OR_DEFAULT_RE.test(trimmed)) {
      if (inCase && hasCode && !hasBreak && !hasFallthroughComment && !hasIntentional) {
        errors.push(`L${i + 1}: Switch case fallthrough from case at L${caseStartLine} \u2014 add break, return, or // fallthrough comment`);
      }
      inCase = true;
      caseStartLine = i + 1;
      hasBreak = false;
      hasFallthroughComment = false;
      hasIntentional = false;
      hasCode = false;
      braceDepth = 0;
      continue;
    }
    if (!inCase)
      continue;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;
    if (braceDepth <= 0 && BREAK_RE.test(trimmed)) {
      hasBreak = true;
    }
    if (FALLTHROUGH_COMMENT_RE.test(line)) {
      hasFallthroughComment = true;
    }
    if (INTENTIONAL_RE.test(line)) {
      hasIntentional = true;
    }
    if (trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
      hasCode = true;
    }
    if (braceDepth < 0) {
      inCase = false;
    }
  }
  return errors;
}
var TEST_CASE_RE = /\b(?:it|test)\s*\(/g;
var PBT_IMPORT_RE = /(?:fast-check|@fast-check|fc\.|property\s*\(|forAll\s*\(|arbitrary)/;
function emitPbtAdvisory(file, content) {
  try {
    const fileName = file.split("/").pop() ?? "";
    const isTestFile2 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_");
    if (!isTestFile2)
      return;
    const testCases = content.match(TEST_CASE_RE);
    if (!testCases || testCases.length < 5)
      return;
    if (PBT_IMPORT_RE.test(content))
      return;
    const relative = file.split("/").slice(-3).join("/");
    process.stderr.write(`[qult] Advisory: ${relative} has ${testCases.length} test cases \u2014 consider property-based testing for broader coverage
`);
  } catch {}
}
function detectSemanticPatterns(file) {
  if (isGateDisabled("semantic-check"))
    return [];
  const ext = extname7(file).toLowerCase();
  if (!CHECKABLE_EXTS3.has(ext))
    return [];
  if (!existsSync7(file))
    return [];
  let content;
  try {
    content = readFileSync7(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE4)
    return [];
  const lines = content.split(`
`);
  const errors = [];
  if (JS_TS_EXTS2.has(ext)) {
    errors.push(...detectEmptyCatch(lines));
    errors.push(...detectIgnoredReturn(lines));
    errors.push(...detectConditionAssignment(lines));
    errors.push(...detectUnreachableCode(lines));
    errors.push(...detectLooseEquality(lines));
    errors.push(...detectSwitchFallthrough(lines));
  }
  if (PY_EXTS4.has(ext)) {
    errors.push(...detectEmptyCatch(lines));
  }
  emitPbtAdvisory(file, content);
  if (errors.length === 0)
    return [];
  return [
    {
      file,
      errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
      gate: "semantic-check"
    }
  ];
}

// src/hooks/detectors/test-quality-check.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "fs";
import { basename as basename5, dirname as dirname4, extname as extname8, resolve as resolve3 } from "path";
var MAX_CHECK_SIZE5 = 500000;
var BLOCKING_SMELL_TYPES = new Set([
  "empty-test",
  "always-true",
  "trivial-assertion",
  "constant-self"
]);
var ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
var TEST_CASE_RE2 = /\b(it|test)\s*\(/g;
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
  if (!existsSync8(absPath))
    return null;
  let content;
  try {
    content = readFileSync8(absPath, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_CHECK_SIZE5)
    return null;
  const codeOnly = content.split(`
`).filter((line) => !line.trimStart().startsWith("//")).join(`
`);
  const lines = content.split(`
`);
  const testCount = (codeOnly.match(TEST_CASE_RE2) ?? []).length;
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
    const snapDir = `${dirname4(absPath)}/__snapshots__/`;
    const snapFile = `${snapDir}${basename5(absPath)}.snap`;
    if (existsSync8(snapFile)) {
      const snapContent = readFileSync8(snapFile, "utf-8");
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
          const implContent = readFileSync8(implFile, "utf-8");
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
    const dir = dirname4(testPath);
    const base = basename5(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve3(dir, implName);
    if (existsSync8(sameDirPath))
      return sameDirPath;
    const parentDir = dirname4(dir);
    const parentPath = resolve3(parentDir, implName);
    if (existsSync8(parentPath))
      return parentPath;
    const srcPath = resolve3(parentDir, "src", implName);
    if (existsSync8(srcPath))
      return srcPath;
    return null;
  } catch {
    return null;
  }
}

// src/hooks/detectors/health-score.ts
var WEIGHTS = {
  security: -2,
  hallucinated_imports: -2,
  export_breaking: -2,
  duplication: -1.5,
  semantic: -1,
  dead_imports: -1,
  convention: -0.5,
  test_quality: -1.5
};
var DEFAULT_WEIGHT = -1;
function countFindings(fixes) {
  return fixes.reduce((sum, f) => sum + f.errors.length, 0);
}
function computeFileHealthScore(file) {
  if (!existsSync9(file)) {
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
    const semanticFixes = detectSemanticPatterns(file);
    const count = countFindings(semanticFixes);
    if (count > 0)
      breakdown.semantic = (WEIGHTS.semantic ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const dupFixes = detectDuplication(file);
    const count = countFindings(dupFixes);
    if (count > 0)
      breakdown.duplication = (WEIGHTS.duplication ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const deadImports = detectDeadImports(file);
    if (deadImports.length > 0)
      breakdown.dead_imports = (WEIGHTS.dead_imports ?? DEFAULT_WEIGHT) * deadImports.length;
  } catch {}
  try {
    const hallucinatedFixes = detectHallucinatedImports(file);
    const count = countFindings(hallucinatedFixes);
    if (count > 0)
      breakdown.hallucinated_imports = (WEIGHTS.hallucinated_imports ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const exportFixes = detectExportBreakingChanges(file);
    const count = countFindings(exportFixes);
    if (count > 0)
      breakdown.export_breaking = (WEIGHTS.export_breaking ?? DEFAULT_WEIGHT) * count;
  } catch {}
  try {
    const conventions = detectConventionDrift(file);
    if (conventions.length > 0)
      breakdown.convention = (WEIGHTS.convention ?? DEFAULT_WEIGHT) * conventions.length;
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

// src/metrics-dashboard.ts
function generateMetricsDashboard(metrics) {
  if (metrics.length === 0) {
    return "No metrics data available yet. Metrics are recorded after each session.";
  }
  const lines = [];
  lines.push(`## Metrics Dashboard (${metrics.length} sessions)
`);
  const totalGateFailures = metrics.reduce((sum, m) => sum + m.gate_failures, 0);
  const totalSecurityWarnings = metrics.reduce((sum, m) => sum + m.security_warnings, 0);
  const reviewScores = metrics.filter((m) => m.review_score !== null).map((m) => m.review_score);
  const avgGateFailures = totalGateFailures / metrics.length;
  const avgReviewScore = reviewScores.length > 0 ? reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length : null;
  lines.push("### Summary");
  lines.push(`- Gate failures: ${totalGateFailures} total, avg ${avgGateFailures.toFixed(1)} gate failures/session`);
  lines.push(`- Security warnings: ${totalSecurityWarnings} total`);
  if (avgReviewScore !== null) {
    lines.push(`- Review scores: avg ${avgReviewScore.toFixed(1)}/40 across ${reviewScores.length} reviews`);
  }
  lines.push("");
  lines.push("### Recent Sessions");
  const recent = metrics.slice(-10).reverse();
  for (const m of recent) {
    const date = m.timestamp.slice(0, 10);
    const parts = [];
    if (m.gate_failures > 0)
      parts.push(`${m.gate_failures} gate failure(s)`);
    if (m.security_warnings > 0)
      parts.push(`${m.security_warnings} security warning(s)`);
    if (m.review_score !== null)
      parts.push(`${m.review_score}/40`);
    parts.push(`${m.files_changed} files`);
    lines.push(`- ${date}: ${parts.join(", ")}`);
  }
  return lines.join(`
`);
}

// src/state/audit-log.ts
var MAX_ENTRIES2 = 200;
function appendAuditLog(entry) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const sid = getSessionId();
    db.prepare("INSERT INTO audit_log (project_id, session_id, action, gate_name, reason) VALUES (?, ?, ?, ?, ?)").run(projectId, sid, entry.action, entry.gate_name ?? null, entry.reason);
    db.prepare(`DELETE FROM audit_log WHERE project_id = ? AND id NOT IN (
				SELECT id FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`).run(projectId, projectId, MAX_ENTRIES2);
  } catch {}
}
function readAuditLog() {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare("SELECT action, reason, gate_name, created_at FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, MAX_ENTRIES2);
    return rows.map((r) => ({
      action: r.action,
      reason: r.reason ?? "",
      gate_name: r.gate_name ?? undefined,
      timestamp: r.created_at
    }));
  } catch {
    return [];
  }
}

// src/mcp-server.ts
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_NAME = "qult";
var SERVER_VERSION = "1.0.0";
function resolveSession(cwd) {
  setProjectPath(cwd);
  const latest = findLatestSessionId();
  if (latest)
    setSessionScope(latest);
  return latest;
}
function getValidGateNames() {
  const gates = loadGates();
  const names = new Set([
    "review",
    "security-check",
    "dead-import-check",
    "duplication-check",
    "semantic-check",
    "semgrep-required",
    "test-quality-check",
    "security-check-advisory",
    "coverage"
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
function isValidGateName(name) {
  return getValidGateNames().includes(name);
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
    description: "Set a qult config value. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, plan_eval.score_threshold, plan_eval.max_iterations.",
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
    description: "Returns a consolidated summary of all computational detector findings from the current session. Includes escalation counters and pending fixes grouped by gate. Call before /qult:review to collect ground truth for reviewers.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_file_health_score",
    description: "Compute a 0-10 health score for a file by aggregating findings from all computational detectors (security, semantic, duplication, dead-imports, hallucinated-imports, export-breaking, convention). 10 = no issues, 0 = critical. Returns score and per-detector breakdown.",
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
    name: "reset_escalation_counters",
    description: "Reset all escalation counters (security, dead-import, drift, test-quality, duplication) to zero. Use during large refactors when accumulated warnings are no longer relevant.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why counters should be reset (min 10 chars). Required for audit trail."
        }
      },
      required: ["reason"]
    }
  },
  {
    name: "get_harness_report",
    description: "Returns a harness effectiveness report analyzing which gates catch issues and review score trends.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_handoff_document",
    description: "Returns a structured handoff document for starting a fresh session. Call before ending a long session.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_metrics_dashboard",
    description: "Returns a formatted metrics dashboard showing gate failure trends and review score history.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_flywheel_recommendations",
    description: "Returns threshold adjustment recommendations based on cross-session pattern analysis.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "record_finish_started",
    description: "Record that /qult:finish has been started. Call at the beginning of /qult:finish skill. Required for the commit gate to allow commits when a plan is active.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "archive_plan",
    description: "Archive a completed plan file to prevent detection in future sessions. Moves the plan to an archive/ subdirectory. Call after /qult:finish completes successfully.",
    inputSchema: {
      type: "object",
      properties: {
        plan_path: {
          type: "string",
          description: "Absolute path to the plan file to archive"
        }
      },
      required: ["plan_path"]
    }
  },
  {
    name: "save_gates",
    description: "Save gate configuration for the current project. Use during /qult:init to register detected gates. Replaces all existing gates atomically.",
    inputSchema: {
      type: "object",
      properties: {
        gates: {
          type: "object",
          description: "GatesConfig: { on_write?: { lint: { command, timeout?, run_once_per_batch? }, ... }, on_commit?: { ... }, on_review?: { ... } }"
        }
      },
      required: ["gates"]
    }
  }
];
var WRITE_TOOLS = new Set([
  "disable_gate",
  "enable_gate",
  "set_config",
  "clear_pending_fixes",
  "record_review",
  "record_test_pass",
  "record_human_approval",
  "record_stage_scores",
  "reset_escalation_counters",
  "record_finish_started",
  "archive_plan"
]);
function handleTool(name, cwd, args) {
  const session = resolveSession(cwd);
  const db = getDb();
  const sid = getSessionId();
  if (session === null && WRITE_TOOLS.has(name)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "No active session found for this project. Trigger a hook (e.g. edit a file) to initialize the session, then retry."
        }
      ]
    };
  }
  switch (name) {
    case "get_pending_fixes": {
      const rows = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?").all(sid);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No pending fixes." }] };
      }
      const fixes = rows.map((r) => ({
        file: r.file,
        gate: r.gate,
        errors: JSON.parse(r.errors)
      }));
      const lines = [`${fixes.length} pending fix(es):
`];
      for (const fix of fixes) {
        lines.push(`[${fix.gate}] ${fix.file}`);
        for (const err of fix.errors)
          lines.push(`  ${err}`);
      }
      return { content: [{ type: "text", text: lines.join(`
`) }] };
    }
    case "get_session_status": {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
      if (!row) {
        return {
          isError: true,
          content: [{ type: "text", text: "No session state. Run /qult:init to set up." }]
        };
      }
      const config = loadConfig();
      const enriched = {
        ...row,
        review_models: config.review.models
      };
      return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
    }
    case "get_gate_config": {
      const gates = loadGates();
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
              text: `Unknown gate '${gateName}'. Valid: ${getValidGateNames().join(", ")}`
            }
          ]
        };
      }
      const disabled = db.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?").all(sid);
      if (!disabled.some((d) => d.gate_name === gateName) && disabled.length >= 2) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Maximum 2 gates disabled. Currently: ${disabled.map((d) => d.gate_name).join(", ")}`
            }
          ]
        };
      }
      db.prepare("INSERT OR REPLACE INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(sid, gateName, reason);
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
      db.prepare("DELETE FROM disabled_gates WHERE session_id = ? AND gate_name = ?").run(sid, gateName);
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
        "plan_eval.max_iterations",
        "flywheel.min_sessions",
        "escalation.security_threshold",
        "escalation.drift_threshold",
        "escalation.test_quality_threshold",
        "escalation.duplication_threshold",
        "escalation.semantic_threshold"
      ];
      const ALLOWED_MODEL_KEYS = [
        "review.models.spec",
        "review.models.quality",
        "review.models.security",
        "review.models.adversarial",
        "plan_eval.models.generator",
        "plan_eval.models.evaluator"
      ];
      const ALLOWED_BOOLEAN_KEYS = ["flywheel.enabled", "review.require_human_approval"];
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
      const projectId = getProjectId();
      db.prepare("INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)").run(projectId, key, JSON.stringify(value));
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
      db.prepare("DELETE FROM pending_fixes WHERE session_id = ?").run(sid);
      appendAuditLog({
        action: "clear_pending_fixes",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
    }
    case "get_detector_summary": {
      const session2 = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
      const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?").all(sid);
      const lines = [];
      if (session2) {
        const counters = [
          "security_warning_count",
          "dead_import_warning_count",
          "drift_warning_count",
          "test_quality_warning_count",
          "duplication_warning_count",
          "semantic_warning_count"
        ];
        for (const key of counters) {
          const val = typeof session2[key] === "number" ? session2[key] : 0;
          if (val > 0)
            lines.push(`${key}: ${val}`);
        }
      }
      if (fixes.length > 0) {
        const byGate = {};
        for (const fix of fixes) {
          const g = fix.gate ?? "unknown";
          if (!byGate[g])
            byGate[g] = [];
          byGate[g].push({ file: fix.file, errors: JSON.parse(fix.errors) });
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
      const resolvedHealth = resolve4(filePath);
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
      db.prepare("UPDATE sessions SET review_completed_at = ? WHERE id = ?").run(new Date().toISOString(), sid);
      const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
      const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
      return { content: [{ type: "text", text: msg }] };
    }
    case "record_test_pass": {
      const cmd = typeof args?.command === "string" ? args.command : null;
      if (!cmd) {
        return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
      }
      db.prepare("UPDATE sessions SET test_passed_at = ?, test_command = ? WHERE id = ?").run(new Date().toISOString(), cmd, sid);
      return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
    }
    case "record_human_approval": {
      const session2 = db.prepare("SELECT review_completed_at FROM sessions WHERE id = ?").get(sid);
      if (!session2?.review_completed_at) {
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
      db.prepare("UPDATE sessions SET human_review_approved_at = ? WHERE id = ?").run(new Date().toISOString(), sid);
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
      const insertScore = db.prepare("INSERT OR REPLACE INTO review_stage_scores (session_id, stage, dimension, score) VALUES (?, ?, ?, ?)");
      for (const [dim, score] of Object.entries(scores)) {
        insertScore.run(sid, stage, dim, score);
      }
      return {
        content: [
          { type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` }
        ]
      };
    }
    case "get_harness_report": {
      try {
        const metrics = readMetricsHistory();
        const auditLog = readAuditLog();
        const cfg = loadConfig();
        const report = generateHarnessReport(metrics, auditLog, cfg);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "No harness data available yet." }] };
      }
    }
    case "get_handoff_document": {
      try {
        const session2 = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
        const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?").all(sid);
        const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE session_id = ?").all(sid);
        const disabledGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?").all(sid);
        const plan = getActivePlan();
        return {
          content: [
            {
              type: "text",
              text: generateHandoffDocument({
                changedFiles: changedFiles.map((r) => r.file_path),
                pendingFixes: fixes.map((r) => ({
                  file: r.file,
                  gate: r.gate,
                  errors: JSON.parse(r.errors)
                })),
                planTasks: plan?.tasks ?? null,
                testPassed: !!session2?.test_passed_at,
                reviewDone: !!session2?.review_completed_at,
                disabledGates: disabledGates.map((r) => r.gate_name)
              })
            }
          ]
        };
      } catch {
        return { content: [{ type: "text", text: "No active session data to hand off." }] };
      }
    }
    case "get_metrics_dashboard": {
      try {
        const metrics = readMetricsHistory();
        return { content: [{ type: "text", text: generateMetricsDashboard(metrics) }] };
      } catch {
        return { content: [{ type: "text", text: "No metrics data available yet." }] };
      }
    }
    case "get_flywheel_recommendations": {
      try {
        const config = loadConfig();
        const metrics = readMetricsHistory();
        const recs = getFlywheelRecommendations(metrics, config);
        if (recs.length === 0) {
          return {
            content: [
              { type: "text", text: "No recommendations. Insufficient data or flywheel disabled." }
            ]
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(recs, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "No flywheel data available yet." }] };
      }
    }
    case "record_finish_started": {
      db.prepare("INSERT OR REPLACE INTO ran_gates (session_id, gate_name, ran_at) VALUES (?, ?, ?)").run(sid, "__finish_started__", new Date().toISOString());
      return { content: [{ type: "text", text: "Finish started recorded." }] };
    }
    case "archive_plan": {
      const planPath = typeof args?.plan_path === "string" ? args.plan_path : null;
      if (!planPath) {
        return { content: [{ type: "text", text: "Error: plan_path is required." }] };
      }
      const resolvedPath = resolve4(cwd, planPath);
      const allowedBases = [
        resolve4(join5(cwd, ".claude", "plans")),
        resolve4(join5(homedir3(), ".claude", "plans"))
      ];
      const envPlansDir = process.env.CLAUDE_PLANS_DIR;
      if (envPlansDir)
        allowedBases.push(resolve4(envPlansDir));
      const isAllowed = allowedBases.some((base) => resolvedPath.startsWith(`${base}/`)) && resolvedPath.endsWith(".md");
      if (!isAllowed) {
        return {
          content: [
            { type: "text", text: "Error: plan_path must be a .md file under .claude/plans/" }
          ]
        };
      }
      if (!existsSync10(resolvedPath)) {
        return {
          content: [{ type: "text", text: "Plan not found (already archived or path incorrect)." }]
        };
      }
      archivePlanFile(resolvedPath);
      resetPlanCache();
      return { content: [{ type: "text", text: "Plan archived." }] };
    }
    case "save_gates": {
      const gates = args?.gates;
      if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing or invalid gates parameter." }]
        };
      }
      const validPhases = ["on_write", "on_commit", "on_review"];
      let totalGates = 0;
      for (const [phase, gateMap] of Object.entries(gates)) {
        if (!validPhases.includes(phase)) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Invalid phase '${phase}'. Valid: ${validPhases.join(", ")}` }
            ]
          };
        }
        if (typeof gateMap !== "object" || gateMap === null || Array.isArray(gateMap)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Phase '${phase}' must be an object of gates.` }]
          };
        }
        for (const [gateName, gateDef] of Object.entries(gateMap)) {
          if (typeof gateDef !== "object" || gateDef === null || typeof gateDef.command !== "string" || gateDef.command.trim() === "") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Gate '${phase}.${gateName}' must have a non-empty command string.`
                }
              ]
            };
          }
          totalGates++;
        }
      }
      if (totalGates === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "No gates provided." }]
        };
      }
      saveGates(gates);
      appendAuditLog({
        action: "save_gates",
        reason: "Gates configured via /qult:init",
        timestamp: new Date().toISOString()
      });
      const counts = validPhases.map((p) => {
        const m = gates[p];
        return `${m && typeof m === "object" ? Object.keys(m).length : 0} ${p}`;
      }).filter((s) => !s.startsWith("0 "));
      return { content: [{ type: "text", text: `Gates saved: ${counts.join(", ")}.` }] };
    }
    case "reset_escalation_counters": {
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!reason || reason.length < 10 || new Set(reason).size < 5) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." }
          ]
        };
      }
      db.prepare(`UPDATE sessions SET
				security_warning_count = 0,
				test_quality_warning_count = 0,
				drift_warning_count = 0,
				dead_import_warning_count = 0,
				duplication_warning_count = 0,
				semantic_warning_count = 0
				WHERE id = ?`).run(sid);
      appendAuditLog({
        action: "reset_escalation_counters",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All escalation counters reset to zero." }] };
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
            "## Plan Workflow (IMPORTANT)",
            "IF a plan is needed: use /qult:plan-generator \u2014 do NOT write plans manually or use EnterPlanMode directly.",
            "Reason: manual plans bypass plan-evaluator scoring. /qult:plan-generator runs evaluation automatically.",
            "IF a plan is active and all tasks + review are done: use /qult:finish \u2014 do NOT commit directly.",
            "Reason: /qult:finish runs the structured completion checklist. Direct commits skip it.",
            "Update task status to [done] as you complete each task.",
            "",
            "## Workflow",
            "- When requirements are unclear, use /qult:explore to interview the architect.",
            "- When debugging, use /qult:debug for structured root-cause analysis.",
            "- Independent 4-stage review (/qult:review) is required for large changes or when a plan is active.",
            "",
            "## Hook/MCP Roles",
            "- Hooks detect test pass best-effort via output parsing. If tests passed but hook didn't detect it, call record_test_pass explicitly.",
            "- After committing, session state resets (test/review cleared). This is expected \u2014 gates only apply to uncommitted changes.",
            "- MCP tools (record_test_pass, record_review) are the authoritative state management mechanism.",
            "",
            "## Ground Truth for Reviews",
            "- Before running /qult:review, call get_detector_summary to collect computational detector findings (security, imports, duplications, test quality).",
            "- Pass detector findings as context to each reviewer stage \u2014 reviewers must not contradict detector results.",
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
