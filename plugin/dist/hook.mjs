// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name2, newValue) {
  this[name2] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, {
      get: all[name2],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name2)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// src/state/db.ts
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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
    createTablesV6(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (version < 2)
    db.exec("DROP TABLE IF EXISTS calibration");
  if (version < 3) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN semantic_warning_count INTEGER NOT NULL DEFAULT 0");
    } catch {}
  }
  if (version < 4) {
    for (const col of [
      "test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
      "duplication_warning_count INTEGER NOT NULL DEFAULT 0",
      "semantic_warning_count INTEGER NOT NULL DEFAULT 0",
      "drift_warning_count INTEGER NOT NULL DEFAULT 0",
      "escalation_hit INTEGER NOT NULL DEFAULT 0"
    ]) {
      try {
        db.exec(`ALTER TABLE session_metrics ADD COLUMN ${col}`);
      } catch {}
    }
  }
  if (version < 5) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT NOT NULL, file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		)`);
  }
  if (version < 6)
    migrateToProjectState(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
function migrateToProjectState(db) {
  for (const col of [
    "last_commit_at TEXT",
    "test_passed_at TEXT",
    "test_command TEXT",
    "review_completed_at TEXT",
    "review_iteration INTEGER NOT NULL DEFAULT 0",
    "plan_eval_iteration INTEGER NOT NULL DEFAULT 0",
    "plan_selfcheck_blocked_at TEXT",
    "human_review_approved_at TEXT",
    "security_warning_count INTEGER NOT NULL DEFAULT 0",
    "test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
    "drift_warning_count INTEGER NOT NULL DEFAULT 0",
    "dead_import_warning_count INTEGER NOT NULL DEFAULT 0",
    "duplication_warning_count INTEGER NOT NULL DEFAULT 0",
    "semantic_warning_count INTEGER NOT NULL DEFAULT 0"
  ]) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col}`);
    } catch {}
  }
  try {
    db.exec(`UPDATE projects SET
			test_passed_at = (SELECT s.test_passed_at FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1),
			review_completed_at = (SELECT s.review_completed_at FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1),
			review_iteration = COALESCE((SELECT s.review_iteration FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1), 0)
		`);
  } catch {}
  const migrations = [
    {
      name: "pending_fixes",
      ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, gate TEXT NOT NULL, errors TEXT NOT NULL, UNIQUE(project_id, file, gate))`,
      copy: `INSERT OR IGNORE INTO pending_fixes_v6 (project_id, file, gate, errors) SELECT s.project_id, t.file, t.gate, t.errors FROM pending_fixes t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "changed_files",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file_path TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, file_path))`,
      copy: `INSERT OR IGNORE INTO changed_files_v6 (project_id, file_path) SELECT s.project_id, t.file_path FROM changed_files t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "disabled_gates",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, gate_name TEXT NOT NULL, reason TEXT NOT NULL, disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, gate_name))`,
      copy: `INSERT OR IGNORE INTO disabled_gates_v6 (project_id, gate_name, reason) SELECT s.project_id, t.gate_name, t.reason FROM disabled_gates t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "ran_gates",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, gate_name TEXT NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, gate_name))`,
      copy: `INSERT OR IGNORE INTO ran_gates_v6 (project_id, gate_name, ran_at) SELECT s.project_id, t.gate_name, t.ran_at FROM ran_gates t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "task_verify_results",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_key TEXT NOT NULL, passed INTEGER NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, task_key))`,
      copy: `INSERT OR IGNORE INTO task_verify_results_v6 (project_id, task_key, passed, ran_at) SELECT s.project_id, t.task_key, t.passed, t.ran_at FROM task_verify_results t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "gate_failure_counts",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, gate TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id, file, gate))`,
      copy: `INSERT OR IGNORE INTO gate_failure_counts_v6 (project_id, file, gate, count) SELECT s.project_id, t.file, t.gate, t.count FROM gate_failure_counts t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "file_edit_counts",
      ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id, file))`,
      copy: `INSERT OR IGNORE INTO file_edit_counts_v6 (project_id, file, count) SELECT s.project_id, t.file, t.count FROM file_edit_counts t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "review_scores",
      ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, iteration))`,
      copy: `INSERT OR IGNORE INTO review_scores_v6 (project_id, iteration, aggregate_score, recorded_at) SELECT s.project_id, t.iteration, t.aggregate_score, t.recorded_at FROM review_scores t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "review_stage_scores",
      ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, stage TEXT NOT NULL, dimension TEXT NOT NULL, score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, stage, dimension))`,
      copy: `INSERT OR IGNORE INTO review_stage_scores_v6 (project_id, stage, dimension, score, recorded_at) SELECT s.project_id, t.stage, t.dimension, t.score, t.recorded_at FROM review_stage_scores t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "plan_eval_scores",
      ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, iteration))`,
      copy: `INSERT OR IGNORE INTO plan_eval_scores_v6 (project_id, iteration, aggregate_score, recorded_at) SELECT s.project_id, t.iteration, t.aggregate_score, t.recorded_at FROM plan_eval_scores t JOIN sessions s ON t.session_id = s.id`
    },
    {
      name: "review_findings",
      ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), file TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL, stage TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
      copy: `INSERT INTO review_findings_v6 (project_id, file, severity, description, stage, recorded_at) SELECT t.project_id, t.file, t.severity, t.description, t.stage, t.recorded_at FROM review_findings t`
    }
  ];
  db.exec("PRAGMA foreign_keys = OFF");
  for (const m of migrations) {
    try {
      db.exec(`CREATE TABLE ${m.name}_v6 ${m.ddl}`);
      db.exec(m.copy);
      db.exec(`DROP TABLE IF EXISTS ${m.name}`);
      db.exec(`ALTER TABLE ${m.name}_v6 RENAME TO ${m.name}`);
    } catch {}
  }
  try {
    db.exec(`CREATE TABLE session_metrics_v6 (
			id INTEGER PRIMARY KEY, session_id TEXT, project_id INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count INTEGER NOT NULL DEFAULT 0, security_warning_count INTEGER NOT NULL DEFAULT 0,
			review_aggregate REAL, files_changed INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0, duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0, drift_warning_count INTEGER NOT NULL DEFAULT 0,
			escalation_hit INTEGER NOT NULL DEFAULT 0,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		)`);
    db.exec(`INSERT INTO session_metrics_v6 SELECT * FROM session_metrics`);
    db.exec("DROP TABLE session_metrics");
    db.exec("ALTER TABLE session_metrics_v6 RENAME TO session_metrics");
  } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}
function createTablesV6(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			last_commit_at TEXT, test_passed_at TEXT, test_command TEXT,
			review_completed_at TEXT, review_iteration INTEGER NOT NULL DEFAULT 0,
			plan_eval_iteration INTEGER NOT NULL DEFAULT 0, plan_selfcheck_blocked_at TEXT,
			human_review_approved_at TEXT,
			security_warning_count INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0,
			drift_warning_count INTEGER NOT NULL DEFAULT 0,
			dead_import_warning_count INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS pending_fixes (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, gate TEXT NOT NULL, errors TEXT NOT NULL,
			UNIQUE(project_id, file, gate)
		);
		CREATE TABLE IF NOT EXISTS changed_files (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file_path TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, file_path)
		);
		CREATE TABLE IF NOT EXISTS disabled_gates (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			gate_name TEXT NOT NULL, reason TEXT NOT NULL,
			disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, gate_name)
		);
		CREATE TABLE IF NOT EXISTS ran_gates (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			gate_name TEXT NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, gate_name)
		);
		CREATE TABLE IF NOT EXISTS task_verify_results (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			task_key TEXT NOT NULL, passed INTEGER NOT NULL,
			ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, task_key)
		);
		CREATE TABLE IF NOT EXISTS gate_failure_counts (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, gate TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (project_id, file, gate)
		);
		CREATE TABLE IF NOT EXISTS file_edit_counts (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (project_id, file)
		);
		CREATE TABLE IF NOT EXISTS review_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, iteration)
		);
		CREATE TABLE IF NOT EXISTS review_stage_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			stage TEXT NOT NULL, dimension TEXT NOT NULL, score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, stage, dimension)
		);
		CREATE TABLE IF NOT EXISTS plan_eval_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, iteration)
		);
		CREATE TABLE IF NOT EXISTS gate_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			phase TEXT NOT NULL, gate_name TEXT NOT NULL, command TEXT NOT NULL,
			timeout INTEGER, run_once_per_batch INTEGER NOT NULL DEFAULT 0, extensions TEXT,
			PRIMARY KEY (project_id, phase, gate_name)
		);
		CREATE TABLE IF NOT EXISTS project_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key)
		);
		CREATE TABLE IF NOT EXISTS global_configs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			session_id TEXT, action TEXT NOT NULL, gate_name TEXT, reason TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS session_metrics (
			id INTEGER PRIMARY KEY, session_id TEXT,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count INTEGER NOT NULL DEFAULT 0, security_warning_count INTEGER NOT NULL DEFAULT 0,
			review_aggregate REAL, files_changed INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0, duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0, drift_warning_count INTEGER NOT NULL DEFAULT 0,
			escalation_hit INTEGER NOT NULL DEFAULT 0,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS review_findings (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			file TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL,
			stage TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
	`);
}
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
var SCHEMA_VERSION = 6, DB_DIR, DB_PATH, _db = null, _projectIdCache = null, _projectPathCache = null;
var init_db = __esm(() => {
  DB_DIR = join(homedir(), ".qult");
  DB_PATH = join(DB_DIR, "qult.db");
});

// src/config.ts
var exports_config = {};
__export(exports_config, {
  resetConfigCache: () => resetConfigCache,
  loadConfig: () => loadConfig,
  DEFAULTS: () => DEFAULTS
});
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
    if (typeof g.coverage_threshold === "number")
      config.gates.coverage_threshold = Math.max(0, Math.min(100, g.coverage_threshold));
    if (typeof g.consumer_typecheck === "boolean")
      config.gates.consumer_typecheck = g.consumer_typecheck;
    if (typeof g.import_graph_depth === "number")
      config.gates.import_graph_depth = Math.max(1, Math.min(3, g.import_graph_depth));
    if (typeof g.complexity_threshold === "number")
      config.gates.complexity_threshold = Math.max(1, g.complexity_threshold);
    if (typeof g.function_size_limit === "number")
      config.gates.function_size_limit = Math.max(1, g.function_size_limit);
    if (typeof g.mutation_score_threshold === "number")
      config.gates.mutation_score_threshold = Math.max(0, Math.min(100, g.mutation_score_threshold));
  }
  if (raw.security && typeof raw.security === "object") {
    const s = raw.security;
    if (typeof s.require_semgrep === "boolean")
      config.security.require_semgrep = s.require_semgrep;
    if (typeof s.require_osv_scanner === "boolean")
      config.security.require_osv_scanner = s.require_osv_scanner;
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
    if (typeof f.auto_apply === "boolean")
      config.flywheel.auto_apply = f.auto_apply;
  }
}
function kvRowsToRaw(rows) {
  const raw = {};
  for (const row of rows) {
    const parts2 = row.key.split(".");
    if (parts2.length < 2)
      continue;
    const section = parts2[0];
    if (!raw[section])
      raw[section] = {};
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    if (parts2.length === 2) {
      raw[section][parts2[1]] = parsed;
    } else if (parts2.length === 3) {
      const sub = parts2[1];
      if (!raw[section][sub] || typeof raw[section][sub] !== "object") {
        raw[section][sub] = {};
      }
      raw[section][sub][parts2[2]] = parsed;
    }
  }
  return raw;
}
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
  const covThreshold = envInt("QULT_COVERAGE_THRESHOLD");
  if (covThreshold !== undefined)
    config.gates.coverage_threshold = Math.max(0, Math.min(100, covThreshold));
  const consumerTcEnv = process.env.QULT_CONSUMER_TYPECHECK;
  if (consumerTcEnv === "1" || consumerTcEnv === "true")
    config.gates.consumer_typecheck = true;
  else if (consumerTcEnv === "0" || consumerTcEnv === "false")
    config.gates.consumer_typecheck = false;
  const igDepth = envInt("QULT_IMPORT_GRAPH_DEPTH");
  if (igDepth !== undefined)
    config.gates.import_graph_depth = Math.max(1, Math.min(3, igDepth));
  const complexityThreshold = envInt("QULT_COMPLEXITY_THRESHOLD");
  if (complexityThreshold !== undefined)
    config.gates.complexity_threshold = Math.max(1, complexityThreshold);
  const funcSizeLimit = envInt("QULT_FUNCTION_SIZE_LIMIT");
  if (funcSizeLimit !== undefined)
    config.gates.function_size_limit = Math.max(1, funcSizeLimit);
  const mutationScore = envInt("QULT_MUTATION_SCORE_THRESHOLD");
  if (mutationScore !== undefined)
    config.gates.mutation_score_threshold = Math.max(0, Math.min(100, mutationScore));
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
  const requireOsvScannerEnv = process.env.QULT_REQUIRE_OSV_SCANNER;
  if (requireOsvScannerEnv === "1" || requireOsvScannerEnv === "true")
    config.security.require_osv_scanner = true;
  else if (requireOsvScannerEnv === "0" || requireOsvScannerEnv === "false")
    config.security.require_osv_scanner = false;
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
  const flywheelAutoApplyEnv = process.env.QULT_FLYWHEEL_AUTO_APPLY;
  if (flywheelAutoApplyEnv === "1" || flywheelAutoApplyEnv === "true")
    config.flywheel.auto_apply = true;
  else if (flywheelAutoApplyEnv === "0" || flywheelAutoApplyEnv === "false")
    config.flywheel.auto_apply = false;
  _cache = config;
  return config;
}
function resetConfigCache() {
  _cache = null;
}
var DEFAULTS, _cache = null;
var init_config = __esm(() => {
  init_db();
  DEFAULTS = {
    review: {
      score_threshold: 30,
      max_iterations: 3,
      required_changed_files: 5,
      dimension_floor: 4,
      require_human_approval: false,
      models: {
        spec: "opus",
        quality: "opus",
        security: "opus",
        adversarial: "opus"
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
      extra_path: [],
      coverage_threshold: 0,
      consumer_typecheck: false,
      import_graph_depth: 1,
      complexity_threshold: 15,
      function_size_limit: 50,
      mutation_score_threshold: 0
    },
    security: {
      require_semgrep: true,
      require_osv_scanner: false
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
      min_sessions: 10,
      auto_apply: false
    }
  };
});

// src/gates/load.ts
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
var _cache2;
var init_load = __esm(() => {
  init_db();
});

// src/state/pending-fixes.ts
function readPendingFixes() {
  if (_cache3)
    return _cache3;
  try {
    const db = getDb();
    const pid = getProjectId();
    const rows = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?").all(pid);
    _cache3 = rows.map((r) => ({
      file: r.file,
      gate: r.gate,
      errors: JSON.parse(r.errors)
    }));
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
    const db = getDb();
    const pid = getProjectId();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM pending_fixes WHERE project_id = ?").run(pid);
      const insert = db.prepare("INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)");
      for (const fix of _cache3) {
        insert.run(pid, fix.file, fix.gate, JSON.stringify(fix.errors));
      }
      db.exec("COMMIT");
    } catch (err2) {
      db.exec("ROLLBACK");
      throw err2;
    }
  } catch (e) {
    if (e instanceof Error)
      process.stderr.write(`[qult] write error: ${e.message}
`);
  }
  _dirty = false;
}
var _cache3 = null, _dirty = false;
var init_pending_fixes = __esm(() => {
  init_db();
});

// src/state/plan-status.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, renameSync, statSync } from "fs";
import { homedir as homedir2 } from "os";
import { basename, dirname, join as join2 } from "path";
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
  for (let i2 = 0;i2 < lines.length; i2++) {
    const trimmed = lines[i2].trim();
    const taskMatch = trimmed.match(TASK_RE);
    if (taskMatch) {
      const taskNumber = Number(taskMatch[1]);
      const name2 = taskMatch[2].trim();
      const status = normalizeStatus(taskMatch[3]);
      let file;
      let verify;
      for (let j = i2 + 1;j < lines.length; j++) {
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
      tasks.push({ name: name2, status, taskNumber, file, verify });
      continue;
    }
    const checkMatch = trimmed.match(CHECKBOX_RE);
    if (checkMatch) {
      const checked = checkMatch[1] !== " ";
      const name2 = checkMatch[2].trim();
      tasks.push({ name: name2, status: checked ? "done" : "pending" });
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
    if (!existsSync(dir))
      return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({
      path: join2(dir, f),
      mtime: statSync(join2(dir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
function getLatestPlanPath() {
  try {
    const candidates = [];
    const projectDir = join2(process.cwd(), ".claude", "plans");
    const projectPlans = scanPlanDir(projectDir);
    candidates.push(...projectPlans);
    const envDir = process.env.CLAUDE_PLANS_DIR;
    if (envDir) {
      candidates.push(...scanPlanDir(envDir));
    }
    if (!_disableHomeFallback && projectPlans.length === 0 && candidates.length === 0) {
      try {
        const homeDir = join2(homedir2(), ".claude", "plans");
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
function hasPlanFile() {
  try {
    const projectPlanDir = join2(process.cwd(), ".claude", "plans");
    if (existsSync(projectPlanDir) && readdirSync(projectPlanDir).some((f) => f.endsWith(".md"))) {
      return true;
    }
    if (!_disableHomeFallback) {
      const homePlanDir = join2(homedir2(), ".claude", "plans");
      if (existsSync(homePlanDir) && readdirSync(homePlanDir).some((f) => f.endsWith(".md"))) {
        return true;
      }
    }
    return false;
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

// src/review-tier.ts
function computeReviewTier(changedFiles, hasPlan, config, changedFilePaths) {
  const threshold = config.review.required_changed_files;
  if (changedFiles >= DEEP_THRESHOLD)
    return "deep";
  if (changedFilePaths && changedFilePaths.length > 0) {
    if (changedFilePaths.some((p) => HIGH_RISK_RE.test(p)))
      return "deep";
    const hasCodeChanges = changedFilePaths.some((p) => SOURCE_EXT_RE.test(p) && !p.includes(".test.") && !p.includes(".spec.") && !p.includes("__tests__"));
    const hasTestChanges = changedFilePaths.some((p) => p.includes(".test.") || p.includes(".spec.") || p.includes("__tests__") || /_test\.go$/.test(p) || /_spec\.rb$/.test(p) || /\/test_[^/]+\.py$/.test(p) || /\/tests\//.test(p));
    if (hasCodeChanges && !hasTestChanges && changedFiles >= 3) {
      if (hasPlan || changedFiles >= threshold)
        return "deep";
      return "standard";
    }
  }
  if (hasPlan || changedFiles >= threshold)
    return "standard";
  if (changedFiles >= 3)
    return "light";
  return "skip";
}
var DEEP_THRESHOLD = 8, HIGH_RISK_RE, SOURCE_EXT_RE;
var init_review_tier = __esm(() => {
  HIGH_RISK_RE = /(?:^|\/)(?:auth|security|crypto|secret|permission|credential|session|token|password|oauth|saml|jwt)(?:\/|[^/]*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|pyi|go|rs|rb|java|kt|php|cs)$)/i;
  SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|pyi|go|rs|rb|java|kt|php|cs|vue|svelte)$/;
});

// src/state/session-state.ts
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
  if (_cache4)
    return _cache4;
  try {
    const db = getDb();
    const pid = getProjectId();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
    if (!row) {
      _cache4 = defaultState();
      return _cache4;
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
    const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE project_id = ?").all(pid);
    state.changed_file_paths = changedFiles.map((r) => r.file_path);
    const disabledGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?").all(pid);
    state.disabled_gates = disabledGates.map((r) => r.gate_name);
    const ranGates = db.prepare("SELECT gate_name, ran_at FROM ran_gates WHERE project_id = ?").all(pid);
    for (const g of ranGates) {
      state.ran_gates[g.gate_name] = { ran_at: g.ran_at };
    }
    const taskResults = db.prepare("SELECT task_key, passed, ran_at FROM task_verify_results WHERE project_id = ?").all(pid);
    for (const t of taskResults) {
      state.task_verify_results[t.task_key] = { passed: !!t.passed, ran_at: t.ran_at };
    }
    const gateFailures = db.prepare("SELECT file, gate, count FROM gate_failure_counts WHERE project_id = ?").all(pid);
    for (const f of gateFailures) {
      state.gate_failure_counts[`${f.file}:${f.gate}`] = f.count;
    }
    const reviewScores = db.prepare("SELECT aggregate_score FROM review_scores WHERE project_id = ? ORDER BY iteration").all(pid);
    state.review_score_history = reviewScores.map((r) => r.aggregate_score);
    const stageScores = db.prepare("SELECT stage, dimension, score FROM review_stage_scores WHERE project_id = ?").all(pid);
    for (const s of stageScores) {
      if (!state.review_stage_scores[s.stage])
        state.review_stage_scores[s.stage] = {};
      state.review_stage_scores[s.stage][s.dimension] = s.score;
    }
    const planScores = db.prepare("SELECT aggregate_score FROM plan_eval_scores WHERE project_id = ? ORDER BY iteration").all(pid);
    state.plan_eval_score_history = planScores.map((r) => r.aggregate_score);
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
    const db = getDb();
    const pid = getProjectId();
    const state = _cache4;
    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE projects SET
				last_commit_at = ?,
				test_passed_at = ?,
				test_command = ?,
				review_completed_at = ?,
				review_iteration = ?,
				plan_eval_iteration = ?,
				plan_selfcheck_blocked_at = ?,
				human_review_approved_at = ?,
				security_warning_count = ?,
				test_quality_warning_count = ?,
				drift_warning_count = ?,
				dead_import_warning_count = ?,
				duplication_warning_count = ?,
				semantic_warning_count = ?
				WHERE id = ?`).run(state.last_commit_at, state.test_passed_at, state.test_command, state.review_completed_at, state.review_iteration, state.plan_eval_iteration, state.plan_selfcheck_blocked_at, state.human_review_approved_at, state.security_warning_count, state.test_quality_warning_count, state.drift_warning_count, state.dead_import_warning_count, state.duplication_warning_count, state.semantic_warning_count, pid);
      db.prepare("DELETE FROM changed_files WHERE project_id = ?").run(pid);
      const insertFile = db.prepare("INSERT INTO changed_files (project_id, file_path) VALUES (?, ?)");
      for (const fp of state.changed_file_paths) {
        insertFile.run(pid, fp);
      }
      const inMemoryGates = new Set(state.disabled_gates);
      const dbGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?").all(pid);
      for (const { gate_name } of dbGates) {
        if (!inMemoryGates.has(gate_name)) {
          db.prepare("DELETE FROM disabled_gates WHERE project_id = ? AND gate_name = ?").run(pid, gate_name);
        }
      }
      const insertGate = db.prepare("INSERT OR IGNORE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)");
      for (const g of state.disabled_gates) {
        insertGate.run(pid, g, "");
      }
      db.prepare("DELETE FROM ran_gates WHERE project_id = ?").run(pid);
      const insertRan = db.prepare("INSERT INTO ran_gates (project_id, gate_name, ran_at) VALUES (?, ?, ?)");
      for (const [name2, entry] of Object.entries(state.ran_gates)) {
        insertRan.run(pid, name2, entry.ran_at);
      }
      db.prepare("DELETE FROM task_verify_results WHERE project_id = ?").run(pid);
      const insertTask = db.prepare("INSERT INTO task_verify_results (project_id, task_key, passed, ran_at) VALUES (?, ?, ?, ?)");
      for (const [key, result] of Object.entries(state.task_verify_results)) {
        insertTask.run(pid, key, result.passed ? 1 : 0, result.ran_at);
      }
      db.prepare("DELETE FROM gate_failure_counts WHERE project_id = ?").run(pid);
      const insertFailure = db.prepare("INSERT INTO gate_failure_counts (project_id, file, gate, count) VALUES (?, ?, ?, ?)");
      for (const [key, count] of Object.entries(state.gate_failure_counts)) {
        const lastColon = key.lastIndexOf(":");
        if (lastColon === -1)
          continue;
        const file = key.slice(0, lastColon);
        const gate = key.slice(lastColon + 1);
        insertFailure.run(pid, file, gate, count);
      }
      db.prepare("DELETE FROM review_scores WHERE project_id = ?").run(pid);
      const insertReview = db.prepare("INSERT INTO review_scores (project_id, iteration, aggregate_score) VALUES (?, ?, ?)");
      for (let i2 = 0;i2 < state.review_score_history.length; i2++) {
        insertReview.run(pid, i2 + 1, state.review_score_history[i2]);
      }
      db.prepare("DELETE FROM review_stage_scores WHERE project_id = ?").run(pid);
      const insertStage = db.prepare("INSERT INTO review_stage_scores (project_id, stage, dimension, score) VALUES (?, ?, ?, ?)");
      for (const [stage, dims] of Object.entries(state.review_stage_scores)) {
        for (const [dim, score] of Object.entries(dims)) {
          insertStage.run(pid, stage, dim, score);
        }
      }
      db.prepare("DELETE FROM plan_eval_scores WHERE project_id = ?").run(pid);
      const insertPlan = db.prepare("INSERT INTO plan_eval_scores (project_id, iteration, aggregate_score) VALUES (?, ?, ?)");
      for (let i2 = 0;i2 < state.plan_eval_score_history.length; i2++) {
        insertPlan.run(pid, i2 + 1, state.plan_eval_score_history[i2]);
      }
      db.exec("COMMIT");
    } catch (err2) {
      db.exec("ROLLBACK");
      throw err2;
    }
    _dirty2 = false;
  } catch (e) {
    if (e instanceof Error)
      process.stderr.write(`[qult] state write error: ${e.message}
`);
  }
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
function recordChangedFile(filePath) {
  const state = readSessionState();
  if (!state.changed_file_paths)
    state.changed_file_paths = [];
  if (!state.changed_file_paths.includes(filePath)) {
    state.changed_file_paths.push(filePath);
  }
  writeState(state);
}
function isReviewRequired() {
  const state = readSessionState();
  const changedCount = state.changed_file_paths?.length ?? 0;
  const hasPlan = getActivePlan() !== null;
  const tier = computeReviewTier(changedCount, hasPlan, loadConfig(), state.changed_file_paths);
  return tier === "standard" || tier === "deep";
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
function shouldSkipGate(gateName, currentFile) {
  const state = readSessionState();
  const entry = state.ran_gates[gateName];
  if (!entry)
    return false;
  if (currentFile && !(state.changed_file_paths ?? []).includes(currentFile)) {
    return false;
  }
  return true;
}
function markGateRan(gateName) {
  const state = readSessionState();
  state.ran_gates[gateName] = {
    ran_at: new Date().toISOString()
  };
  writeState(state);
}
function incrementFileEditCount(file) {
  try {
    const db = getDb();
    const pid = getProjectId();
    db.prepare("INSERT INTO file_edit_counts (project_id, file, count) VALUES (?, ?, 1) ON CONFLICT(project_id, file) DO UPDATE SET count = count + 1").run(pid, file);
    const row = db.prepare("SELECT count FROM file_edit_counts WHERE project_id = ? AND file = ?").get(pid, file);
    return row?.count ?? 1;
  } catch (err2) {
    process.stderr.write(`[qult] file_edit_counts error: ${err2 instanceof Error ? err2.message : "unknown"} \u2014 iterative escalation may be degraded
`);
    return 1;
  }
}
function resetFileEditCounts() {
  try {
    const db = getDb();
    const pid = getProjectId();
    db.prepare("DELETE FROM file_edit_counts WHERE project_id = ?").run(pid);
  } catch {}
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
  state.semantic_warning_count = 0;
  state.human_review_approved_at = null;
  resetFileEditCounts();
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
function wasFinishStarted() {
  try {
    return FINISH_MARKER in readSessionState().ran_gates;
  } catch {
    return false;
  }
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
var _cache4 = null, _dirty2 = false, TOOL_EXTS, MAX_GATE_FAILURE_COUNT = 100, MAX_GATE_FAILURE_KEYS = 200, FINISH_MARKER = "__finish_started__";
var init_session_state = __esm(() => {
  init_config();
  init_load();
  init_review_tier();
  init_db();
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

// src/hooks/lazy-init.ts
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
    writePendingFixes([]);
  } catch {}
}
var _initialized = false, _sessionStartCompleted = false;
var init_lazy_init = __esm(() => {
  init_pending_fixes();
});

// src/hooks/detectors/diagnostic-classifier.ts
function parseTscOutput(raw) {
  if (!raw)
    return [];
  const results = [];
  for (const line of raw.split(`
`)) {
    const m = line.match(TSC_LINE_RE);
    if (!m)
      continue;
    const [, file, lineStr, code, message] = m;
    results.push({
      code,
      category: DIAGNOSTIC_MAP[code] ?? "unknown",
      message,
      file,
      line: Number(lineStr)
    });
  }
  return results;
}
function parsePyrightOutput(raw) {
  try {
    const parsed = JSON.parse(raw);
    const diagnostics = parsed?.generalDiagnostics;
    if (!Array.isArray(diagnostics))
      return [];
    return diagnostics.filter((d) => d.rule).map((d) => ({
      code: d.rule,
      category: DIAGNOSTIC_MAP[d.rule] ?? "type-error",
      message: d.message,
      file: d.file,
      line: d.range.start.line
    }));
  } catch {
    return [];
  }
}
function parseCargoOutput(raw) {
  if (!raw)
    return [];
  const results = [];
  for (const line of raw.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.reason !== "compiler-message")
        continue;
      const msg = parsed.message;
      if (!msg?.code?.code || !msg.spans.length)
        continue;
      const span = msg.spans[0];
      results.push({
        code: msg.code.code,
        category: DIAGNOSTIC_MAP[msg.code.code] ?? "unknown",
        message: msg.message,
        file: span.file_name,
        line: span.line_start
      });
    } catch {}
  }
  return results;
}
function parseMypyOutput(raw) {
  if (!raw)
    return [];
  const results = [];
  for (const line of raw.split(`
`)) {
    const m = line.match(MYPY_LINE_RE);
    if (!m)
      continue;
    const [, file, lineStr, message, code] = m;
    results.push({
      code,
      category: DIAGNOSTIC_MAP[code] ?? "type-error",
      message,
      file,
      line: Number(lineStr)
    });
  }
  return results;
}
function parseGoVetOutput(raw) {
  if (!raw)
    return [];
  const results = [];
  for (const line of raw.split(`
`)) {
    const m = line.match(GO_VET_LINE_RE);
    if (!m)
      continue;
    const [, file, lineStr, message] = m;
    let category = "type-error";
    if (/undefined:|undeclared name:/.test(message)) {
      category = "hallucinated-symbol";
    } else if (/could not import|cannot find package/.test(message)) {
      category = "hallucinated-import";
    } else if (/has no field or method/.test(message)) {
      category = "hallucinated-api";
    }
    results.push({
      code: "go-vet",
      category,
      message,
      file,
      line: Number(lineStr)
    });
  }
  return results;
}
function classifiedToPendingFixes(diagnostics) {
  const actionable = diagnostics.filter((d) => d.category !== "unknown");
  if (!actionable.length)
    return [];
  const byFile = new Map;
  for (const d of actionable) {
    const errors = byFile.get(d.file) ?? [];
    errors.push(`[${d.category}] ${d.message}`);
    byFile.set(d.file, errors);
  }
  return [...byFile.entries()].map(([file, errors]) => ({
    file,
    errors,
    gate: "typecheck"
  }));
}
var DIAGNOSTIC_MAP, TSC_LINE_RE, MYPY_LINE_RE, GO_VET_LINE_RE;
var init_diagnostic_classifier = __esm(() => {
  DIAGNOSTIC_MAP = {
    TS2339: "hallucinated-api",
    TS2551: "hallucinated-api",
    TS2459: "hallucinated-api",
    TS2694: "hallucinated-api",
    TS2304: "hallucinated-symbol",
    TS2552: "hallucinated-symbol",
    TS2580: "hallucinated-symbol",
    TS2307: "hallucinated-import",
    TS2792: "hallucinated-import",
    TS2322: "type-error",
    TS2345: "type-error",
    TS2741: "type-error",
    TS2769: "type-error",
    reportAttributeAccessIssue: "hallucinated-api",
    reportFunctionMemberAccess: "hallucinated-api",
    reportUndefinedVariable: "hallucinated-symbol",
    reportMissingTypeStubs: "hallucinated-symbol",
    reportMissingImports: "hallucinated-import",
    reportMissingModuleSource: "hallucinated-import",
    reportArgumentType: "type-error",
    reportReturnType: "type-error",
    reportAssignmentType: "type-error",
    reportIndexIssue: "type-error",
    E0599: "hallucinated-api",
    E0425: "hallucinated-symbol",
    E0412: "hallucinated-symbol",
    E0432: "hallucinated-import",
    E0433: "hallucinated-import",
    E0308: "type-error",
    E0277: "type-error",
    "name-defined": "hallucinated-symbol",
    import: "hallucinated-import",
    "import-untyped": "hallucinated-import",
    "attr-defined": "hallucinated-api",
    "arg-type": "type-error",
    assignment: "type-error",
    "return-value": "type-error",
    override: "type-error"
  };
  TSC_LINE_RE = /^(.+)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/;
  MYPY_LINE_RE = /^(.+):(\d+):\s*error:\s*(.+?)\s*\[([^\]]+)\]$/;
  GO_VET_LINE_RE = /^\.?\/?([\w/.]+\.go):(\d+):\d+:\s*(.+)$/;
});

// src/gates/coverage-parser.ts
function parseCoveragePercent(output) {
  if (!output)
    return null;
  let match;
  match = output.match(ISTANBUL_RE);
  if (match)
    return parseFloat(match[1]);
  match = output.match(PYTEST_RE);
  if (match)
    return parseFloat(match[1]);
  match = output.match(GO_RE);
  if (match)
    return parseFloat(match[1]);
  match = output.match(TARPAULIN_RE);
  if (match)
    return parseFloat(match[1]);
  if (/^TOTAL\s/m.test(output)) {
    const totalLine = output.split(`
`).find((l) => /^TOTAL\s/.test(l));
    if (totalLine) {
      const percentages = [...totalLine.matchAll(/([\d.]+)%/g)].map((m) => parseFloat(m[1]));
      if (percentages.length >= 3)
        return percentages[2];
      if (percentages.length > 0)
        return percentages[percentages.length - 1];
    }
  }
  return null;
}
var ISTANBUL_RE, PYTEST_RE, GO_RE, TARPAULIN_RE;
var init_coverage_parser = __esm(() => {
  ISTANBUL_RE = /All\s+files\s*\|[\s\d.]+\|[\s\d.]+\|[\s\d.]+\|\s*([\d.]+)\s*\|/;
  PYTEST_RE = /^TOTAL\s+\d+\s+\d+\s+(\d+)%/m;
  GO_RE = /coverage:\s*([\d.]+)%\s+of\s+statements/;
  TARPAULIN_RE = /([\d.]+)%\s+coverage,\s+\d+\/\d+\s+lines\s+covered/;
});

// src/gates/runner.ts
import { exec, execSync } from "child_process";
function shellEscape(s) {
  const escaped = s.replace(/'/g, "'\\''").replace(/`/g, "'\\`'");
  return `'${escaped}'`;
}
function deduplicateErrors(text) {
  const lines = text.split(`
`);
  const codeGroups = new Map;
  const lineCodes = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const match = lines[i2].match(ERROR_CODE_RE);
    const code = match ? match[1] : null;
    lineCodes.push(code);
    if (code) {
      const existing = codeGroups.get(code);
      if (existing) {
        existing.count++;
      } else {
        codeGroups.set(code, { first: i2, count: 1 });
      }
    }
  }
  const hasRepeats = [...codeGroups.values()].some((g) => g.count > 1);
  if (!hasRepeats)
    return text;
  const result = [];
  const emittedSummary = new Set;
  for (let i2 = 0;i2 < lines.length; i2++) {
    const code = lineCodes[i2];
    if (!code) {
      result.push(lines[i2]);
      continue;
    }
    const group = codeGroups.get(code);
    if (group.count === 1) {
      result.push(lines[i2]);
    } else if (i2 === group.first) {
      result.push(lines[i2]);
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
function runGateAsync(name2, gate, file) {
  const config = loadConfig();
  const baseCmd = gate.structured_command ?? gate.command;
  const command = file ? baseCmd.replace("{file}", shellEscape(file)) : baseCmd;
  const timeout = gate.timeout ?? config.gates.default_timeout;
  const maxChars = config.gates.output_max_chars;
  const start2 = Date.now();
  return new Promise((resolve) => {
    exec(command, {
      cwd: process.cwd(),
      timeout,
      env: {
        ...process.env,
        PATH: buildPath(config.gates.extra_path)
      },
      encoding: "utf-8"
    }, (err2, stdout, stderr) => {
      const duration_ms = Date.now() - start2;
      if (err2) {
        const raw = (stdout ?? "") + (stderr ?? "");
        const isTimeout = "killed" in err2 && err2.killed && duration_ms >= timeout - 100;
        const prefix = isTimeout ? `TIMEOUT after ${timeout}ms
` : "";
        const output = prefix + (smartTruncate(deduplicateErrors(raw), maxChars) || `Exit code ${err2.code ?? 1}`);
        const classified = classifyTypecheckOutput(name2, command, raw);
        resolve({ name: name2, passed: false, output, duration_ms, ...classified });
      } else {
        const output = smartTruncate(stdout ?? "", maxChars);
        resolve({ name: name2, passed: true, output, duration_ms });
      }
    });
  });
}
function runGate(name2, gate, file) {
  const config = loadConfig();
  const command = file ? gate.command.replace("{file}", shellEscape(file)) : gate.command;
  const timeout = gate.timeout ?? config.gates.default_timeout;
  const maxChars = config.gates.output_max_chars;
  const start2 = Date.now();
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
    return { name: name2, passed: true, output, duration_ms: Date.now() - start2 };
  } catch (err2) {
    const duration_ms = Date.now() - start2;
    const e = err2 != null && typeof err2 === "object" ? err2 : {};
    const stdout = "stdout" in e && typeof e.stdout === "string" ? e.stdout : "";
    const stderr = "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
    const status = "status" in e && typeof e.status === "number" ? e.status : 1;
    const isTimeout = "signal" in e && e.signal === "SIGTERM" && duration_ms >= timeout - 100;
    const prefix = isTimeout ? `TIMEOUT after ${timeout}ms
` : "";
    const output = prefix + (smartTruncate(deduplicateErrors(stdout + stderr), maxChars) || `Exit code ${status}`);
    return {
      name: name2,
      passed: false,
      output,
      duration_ms
    };
  }
}
function classifyTypecheckOutput(gateName, _command, raw) {
  if (gateName !== "typecheck" || !raw)
    return {};
  try {
    let diagnostics = [];
    if (raw.includes('"generalDiagnostics"')) {
      diagnostics = parsePyrightOutput(raw);
    } else if (raw.includes('"compiler-message"')) {
      diagnostics = parseCargoOutput(raw);
    }
    if (diagnostics.length === 0 && raw.includes(": error: ") && raw.includes("[")) {
      diagnostics = parseMypyOutput(raw);
    }
    if (diagnostics.length === 0 && /\.go:\d+:\d+:/.test(raw)) {
      diagnostics = parseGoVetOutput(raw);
    }
    if (diagnostics.length === 0) {
      diagnostics = parseTscOutput(raw);
    }
    return diagnostics.length > 0 ? { classifiedDiagnostics: diagnostics } : {};
  } catch {
    return {};
  }
}
function runCoverageGate(name2, gate, threshold) {
  if (threshold <= 0) {
    return { name: name2, passed: true, output: "coverage check skipped (threshold=0)", duration_ms: 0 };
  }
  const result = runGate(name2, gate);
  if (!result.passed)
    return result;
  const coverage = parseCoveragePercent(result.output);
  if (coverage === null)
    return result;
  if (coverage < threshold) {
    return {
      name: name2,
      passed: false,
      output: `Coverage ${coverage}% is below threshold ${threshold}%`,
      duration_ms: result.duration_ms
    };
  }
  return result;
}
var ERROR_CODE_RE;
var init_runner = __esm(() => {
  init_config();
  init_diagnostic_classifier();
  init_coverage_parser();
  ERROR_CODE_RE = /\b([A-Z]{1,4}\d{1,5}|ERR_[A-Z_]+|E\d{3,5})\b/;
});

// node_modules/web-tree-sitter/web-tree-sitter.js
var exports_web_tree_sitter = {};
__export(exports_web_tree_sitter, {
  TreeCursor: () => TreeCursor,
  Tree: () => Tree,
  Query: () => Query,
  Parser: () => Parser,
  Node: () => Node,
  MIN_COMPATIBLE_VERSION: () => MIN_COMPATIBLE_VERSION,
  LookaheadIterator: () => LookaheadIterator,
  Language: () => Language,
  LANGUAGE_VERSION: () => LANGUAGE_VERSION,
  Edit: () => Edit,
  CaptureQuantifier: () => CaptureQuantifier
});
function assertInternal(x) {
  if (x !== INTERNAL)
    throw new Error("Illegal constructor");
}
function isPoint(point) {
  return !!point && typeof point.row === "number" && typeof point.column === "number";
}
function setModule(module2) {
  C = module2;
}
function getText(tree, startIndex, endIndex, startPosition) {
  const length = endIndex - startIndex;
  let result = tree.textCallback(startIndex, startPosition);
  if (result) {
    startIndex += result.length;
    while (startIndex < endIndex) {
      const string = tree.textCallback(startIndex, startPosition);
      if (string && string.length > 0) {
        startIndex += string.length;
        result += string;
      } else {
        break;
      }
    }
    if (startIndex > endIndex) {
      result = result.slice(0, length);
    }
  }
  return result ?? "";
}
function unmarshalCaptures(query, tree, address, patternIndex, result) {
  for (let i2 = 0, n = result.length;i2 < n; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
function marshalNode(node, index = 0) {
  let address = TRANSFER_BUFFER + index * SIZE_OF_NODE;
  C.setValue(address, node.id, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.row, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.column, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node[0], "i32");
}
function unmarshalNode(tree, address = TRANSFER_BUFFER) {
  const id = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  if (id === 0)
    return null;
  const index = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index,
    startPosition: { row, column },
    other
  });
  return result;
}
function marshalTreeCursor(cursor, address = TRANSFER_BUFFER) {
  C.setValue(address + 0 * SIZE_OF_INT, cursor[0], "i32");
  C.setValue(address + 1 * SIZE_OF_INT, cursor[1], "i32");
  C.setValue(address + 2 * SIZE_OF_INT, cursor[2], "i32");
  C.setValue(address + 3 * SIZE_OF_INT, cursor[3], "i32");
}
function unmarshalTreeCursor(cursor) {
  cursor[0] = C.getValue(TRANSFER_BUFFER + 0 * SIZE_OF_INT, "i32");
  cursor[1] = C.getValue(TRANSFER_BUFFER + 1 * SIZE_OF_INT, "i32");
  cursor[2] = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
  cursor[3] = C.getValue(TRANSFER_BUFFER + 3 * SIZE_OF_INT, "i32");
}
function marshalPoint(address, point) {
  C.setValue(address, point.row, "i32");
  C.setValue(address + SIZE_OF_INT, point.column, "i32");
}
function unmarshalPoint(address) {
  const result = {
    row: C.getValue(address, "i32") >>> 0,
    column: C.getValue(address + SIZE_OF_INT, "i32") >>> 0
  };
  return result;
}
function marshalRange(address, range) {
  marshalPoint(address, range.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, range.endPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, range.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, range.endIndex, "i32");
  address += SIZE_OF_INT;
}
function unmarshalRange(address) {
  const result = {};
  result.startPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.endPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.startIndex = C.getValue(address, "i32") >>> 0;
  address += SIZE_OF_INT;
  result.endIndex = C.getValue(address, "i32") >>> 0;
  return result;
}
function marshalEdit(edit, address = TRANSFER_BUFFER) {
  marshalPoint(address, edit.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.oldEndPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.newEndPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, edit.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.oldEndIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.newEndIndex, "i32");
  address += SIZE_OF_INT;
}
function unmarshalLanguageMetadata(address) {
  const major_version = C.getValue(address, "i32");
  const minor_version = C.getValue(address += SIZE_OF_INT, "i32");
  const patch_version = C.getValue(address += SIZE_OF_INT, "i32");
  return { major_version, minor_version, patch_version };
}
async function Module2(moduleArg = {}) {
  var moduleRtn;
  var Module = moduleArg;
  var ENVIRONMENT_IS_WEB = typeof window == "object";
  var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
  var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";
  if (ENVIRONMENT_IS_NODE) {
    const { createRequire } = await import("module");
    var require = createRequire(import.meta.url);
  }
  Module.currentQueryProgressCallback = null;
  Module.currentProgressCallback = null;
  Module.currentLogCallback = null;
  Module.currentParseCallback = null;
  var arguments_ = [];
  var thisProgram = "./this.program";
  var quit_ = /* @__PURE__ */ __name((status, toThrow) => {
    throw toThrow;
  }, "quit_");
  var _scriptName = import.meta.url;
  var scriptDirectory = "";
  function locateFile(path) {
    if (Module["locateFile"]) {
      return Module["locateFile"](path, scriptDirectory);
    }
    return scriptDirectory + path;
  }
  __name(locateFile, "locateFile");
  var readAsync, readBinary;
  if (ENVIRONMENT_IS_NODE) {
    var fs = require("fs");
    if (_scriptName.startsWith("file:")) {
      scriptDirectory = require("path").dirname(require("url").fileURLToPath(_scriptName)) + "/";
    }
    readBinary = /* @__PURE__ */ __name((filename) => {
      filename = isFileURI(filename) ? new URL(filename) : filename;
      var ret = fs.readFileSync(filename);
      return ret;
    }, "readBinary");
    readAsync = /* @__PURE__ */ __name(async (filename, binary2 = true) => {
      filename = isFileURI(filename) ? new URL(filename) : filename;
      var ret = fs.readFileSync(filename, binary2 ? undefined : "utf8");
      return ret;
    }, "readAsync");
    if (process.argv.length > 1) {
      thisProgram = process.argv[1].replace(/\\/g, "/");
    }
    arguments_ = process.argv.slice(2);
    quit_ = /* @__PURE__ */ __name((status, toThrow) => {
      process.exitCode = status;
      throw toThrow;
    }, "quit_");
  } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    try {
      scriptDirectory = new URL(".", _scriptName).href;
    } catch {}
    {
      if (ENVIRONMENT_IS_WORKER) {
        readBinary = /* @__PURE__ */ __name((url) => {
          var xhr = new XMLHttpRequest;
          xhr.open("GET", url, false);
          xhr.responseType = "arraybuffer";
          xhr.send(null);
          return new Uint8Array(xhr.response);
        }, "readBinary");
      }
      readAsync = /* @__PURE__ */ __name(async (url) => {
        if (isFileURI(url)) {
          return new Promise((resolve, reject) => {
            var xhr = new XMLHttpRequest;
            xhr.open("GET", url, true);
            xhr.responseType = "arraybuffer";
            xhr.onload = () => {
              if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                resolve(xhr.response);
                return;
              }
              reject(xhr.status);
            };
            xhr.onerror = reject;
            xhr.send(null);
          });
        }
        var response = await fetch(url, {
          credentials: "same-origin"
        });
        if (response.ok) {
          return response.arrayBuffer();
        }
        throw new Error(response.status + " : " + response.url);
      }, "readAsync");
    }
  } else {}
  var out = console.log.bind(console);
  var err = console.error.bind(console);
  var dynamicLibraries = [];
  var wasmBinary;
  var ABORT = false;
  var EXITSTATUS;
  var isFileURI = /* @__PURE__ */ __name((filename) => filename.startsWith("file://"), "isFileURI");
  var readyPromiseResolve, readyPromiseReject;
  var wasmMemory;
  var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
  var HEAP64, HEAPU64;
  var HEAP_DATA_VIEW;
  var runtimeInitialized = false;
  function updateMemoryViews() {
    var b = wasmMemory.buffer;
    Module["HEAP8"] = HEAP8 = new Int8Array(b);
    Module["HEAP16"] = HEAP16 = new Int16Array(b);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
    Module["HEAP32"] = HEAP32 = new Int32Array(b);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
    Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
    Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
    Module["HEAP_DATA_VIEW"] = HEAP_DATA_VIEW = new DataView(b);
    LE_HEAP_UPDATE();
  }
  __name(updateMemoryViews, "updateMemoryViews");
  function initMemory() {
    if (Module["wasmMemory"]) {
      wasmMemory = Module["wasmMemory"];
    } else {
      var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
      wasmMemory = new WebAssembly.Memory({
        initial: INITIAL_MEMORY / 65536,
        maximum: 32768
      });
    }
    updateMemoryViews();
  }
  __name(initMemory, "initMemory");
  var __RELOC_FUNCS__ = [];
  function preRun() {
    if (Module["preRun"]) {
      if (typeof Module["preRun"] == "function")
        Module["preRun"] = [Module["preRun"]];
      while (Module["preRun"].length) {
        addOnPreRun(Module["preRun"].shift());
      }
    }
    callRuntimeCallbacks(onPreRuns);
  }
  __name(preRun, "preRun");
  function initRuntime() {
    runtimeInitialized = true;
    callRuntimeCallbacks(__RELOC_FUNCS__);
    wasmExports["__wasm_call_ctors"]();
    callRuntimeCallbacks(onPostCtors);
  }
  __name(initRuntime, "initRuntime");
  function preMain() {}
  __name(preMain, "preMain");
  function postRun() {
    if (Module["postRun"]) {
      if (typeof Module["postRun"] == "function")
        Module["postRun"] = [Module["postRun"]];
      while (Module["postRun"].length) {
        addOnPostRun(Module["postRun"].shift());
      }
    }
    callRuntimeCallbacks(onPostRuns);
  }
  __name(postRun, "postRun");
  function abort(what) {
    Module["onAbort"]?.(what);
    what = "Aborted(" + what + ")";
    err(what);
    ABORT = true;
    what += ". Build with -sASSERTIONS for more info.";
    var e = new WebAssembly.RuntimeError(what);
    readyPromiseReject?.(e);
    throw e;
  }
  __name(abort, "abort");
  var wasmBinaryFile;
  function findWasmBinary() {
    if (Module["locateFile"]) {
      return locateFile("web-tree-sitter.wasm");
    }
    return new URL("web-tree-sitter.wasm", import.meta.url).href;
  }
  __name(findWasmBinary, "findWasmBinary");
  function getBinarySync(file) {
    if (file == wasmBinaryFile && wasmBinary) {
      return new Uint8Array(wasmBinary);
    }
    if (readBinary) {
      return readBinary(file);
    }
    throw "both async and sync fetching of the wasm failed";
  }
  __name(getBinarySync, "getBinarySync");
  async function getWasmBinary(binaryFile) {
    if (!wasmBinary) {
      try {
        var response = await readAsync(binaryFile);
        return new Uint8Array(response);
      } catch {}
    }
    return getBinarySync(binaryFile);
  }
  __name(getWasmBinary, "getWasmBinary");
  async function instantiateArrayBuffer(binaryFile, imports) {
    try {
      var binary2 = await getWasmBinary(binaryFile);
      var instance2 = await WebAssembly.instantiate(binary2, imports);
      return instance2;
    } catch (reason) {
      err(`failed to asynchronously prepare wasm: ${reason}`);
      abort(reason);
    }
  }
  __name(instantiateArrayBuffer, "instantiateArrayBuffer");
  async function instantiateAsync(binary2, binaryFile, imports) {
    if (!binary2 && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
      try {
        var response = fetch(binaryFile, {
          credentials: "same-origin"
        });
        var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
        return instantiationResult;
      } catch (reason) {
        err(`wasm streaming compile failed: ${reason}`);
        err("falling back to ArrayBuffer instantiation");
      }
    }
    return instantiateArrayBuffer(binaryFile, imports);
  }
  __name(instantiateAsync, "instantiateAsync");
  function getWasmImports() {
    return {
      env: wasmImports,
      wasi_snapshot_preview1: wasmImports,
      "GOT.mem": new Proxy(wasmImports, GOTHandler),
      "GOT.func": new Proxy(wasmImports, GOTHandler)
    };
  }
  __name(getWasmImports, "getWasmImports");
  async function createWasm() {
    function receiveInstance(instance2, module2) {
      wasmExports = instance2.exports;
      wasmExports = relocateExports(wasmExports, 1024);
      var metadata2 = getDylinkMetadata(module2);
      if (metadata2.neededDynlibs) {
        dynamicLibraries = metadata2.neededDynlibs.concat(dynamicLibraries);
      }
      mergeLibSymbols(wasmExports, "main");
      LDSO.init();
      loadDylibs();
      __RELOC_FUNCS__.push(wasmExports["__wasm_apply_data_relocs"]);
      assignWasmExports(wasmExports);
      return wasmExports;
    }
    __name(receiveInstance, "receiveInstance");
    function receiveInstantiationResult(result2) {
      return receiveInstance(result2["instance"], result2["module"]);
    }
    __name(receiveInstantiationResult, "receiveInstantiationResult");
    var info2 = getWasmImports();
    if (Module["instantiateWasm"]) {
      return new Promise((resolve, reject) => {
        Module["instantiateWasm"](info2, (mod, inst) => {
          resolve(receiveInstance(mod, inst));
        });
      });
    }
    wasmBinaryFile ??= findWasmBinary();
    var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info2);
    var exports = receiveInstantiationResult(result);
    return exports;
  }
  __name(createWasm, "createWasm");

  class ExitStatus {
    static {
      __name(this, "ExitStatus");
    }
    name = "ExitStatus";
    constructor(status) {
      this.message = `Program terminated with exit(${status})`;
      this.status = status;
    }
  }
  var GOT = {};
  var currentModuleWeakSymbols = /* @__PURE__ */ new Set([]);
  var GOTHandler = {
    get(obj, symName) {
      var rtn = GOT[symName];
      if (!rtn) {
        rtn = GOT[symName] = new WebAssembly.Global({
          value: "i32",
          mutable: true
        });
      }
      if (!currentModuleWeakSymbols.has(symName)) {
        rtn.required = true;
      }
      return rtn;
    }
  };
  var LE_ATOMICS_NATIVE_BYTE_ORDER = [];
  var LE_HEAP_LOAD_F32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat32(byteOffset, true), "LE_HEAP_LOAD_F32");
  var LE_HEAP_LOAD_F64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat64(byteOffset, true), "LE_HEAP_LOAD_F64");
  var LE_HEAP_LOAD_I16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt16(byteOffset, true), "LE_HEAP_LOAD_I16");
  var LE_HEAP_LOAD_I32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt32(byteOffset, true), "LE_HEAP_LOAD_I32");
  var LE_HEAP_LOAD_I64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getBigInt64(byteOffset, true), "LE_HEAP_LOAD_I64");
  var LE_HEAP_LOAD_U32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint32(byteOffset, true), "LE_HEAP_LOAD_U32");
  var LE_HEAP_STORE_F32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat32(byteOffset, value, true), "LE_HEAP_STORE_F32");
  var LE_HEAP_STORE_F64 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat64(byteOffset, value, true), "LE_HEAP_STORE_F64");
  var LE_HEAP_STORE_I16 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt16(byteOffset, value, true), "LE_HEAP_STORE_I16");
  var LE_HEAP_STORE_I32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt32(byteOffset, value, true), "LE_HEAP_STORE_I32");
  var LE_HEAP_STORE_I64 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setBigInt64(byteOffset, value, true), "LE_HEAP_STORE_I64");
  var LE_HEAP_STORE_U32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setUint32(byteOffset, value, true), "LE_HEAP_STORE_U32");
  var callRuntimeCallbacks = /* @__PURE__ */ __name((callbacks) => {
    while (callbacks.length > 0) {
      callbacks.shift()(Module);
    }
  }, "callRuntimeCallbacks");
  var onPostRuns = [];
  var addOnPostRun = /* @__PURE__ */ __name((cb) => onPostRuns.push(cb), "addOnPostRun");
  var onPreRuns = [];
  var addOnPreRun = /* @__PURE__ */ __name((cb) => onPreRuns.push(cb), "addOnPreRun");
  var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder : undefined;
  var findStringEnd = /* @__PURE__ */ __name((heapOrArray, idx, maxBytesToRead, ignoreNul) => {
    var maxIdx = idx + maxBytesToRead;
    if (ignoreNul)
      return maxIdx;
    while (heapOrArray[idx] && !(idx >= maxIdx))
      ++idx;
    return idx;
  }, "findStringEnd");
  var UTF8ArrayToString = /* @__PURE__ */ __name((heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
    var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
    if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
      return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
    }
    var str = "";
    while (idx < endPtr) {
      var u0 = heapOrArray[idx++];
      if (!(u0 & 128)) {
        str += String.fromCharCode(u0);
        continue;
      }
      var u1 = heapOrArray[idx++] & 63;
      if ((u0 & 224) == 192) {
        str += String.fromCharCode((u0 & 31) << 6 | u1);
        continue;
      }
      var u2 = heapOrArray[idx++] & 63;
      if ((u0 & 240) == 224) {
        u0 = (u0 & 15) << 12 | u1 << 6 | u2;
      } else {
        u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
      }
      if (u0 < 65536) {
        str += String.fromCharCode(u0);
      } else {
        var ch = u0 - 65536;
        str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
      }
    }
    return str;
  }, "UTF8ArrayToString");
  var getDylinkMetadata = /* @__PURE__ */ __name((binary2) => {
    var offset = 0;
    var end = 0;
    function getU8() {
      return binary2[offset++];
    }
    __name(getU8, "getU8");
    function getLEB() {
      var ret = 0;
      var mul = 1;
      while (true) {
        var byte = binary2[offset++];
        ret += (byte & 127) * mul;
        mul *= 128;
        if (!(byte & 128))
          break;
      }
      return ret;
    }
    __name(getLEB, "getLEB");
    function getString() {
      var len = getLEB();
      offset += len;
      return UTF8ArrayToString(binary2, offset - len, len);
    }
    __name(getString, "getString");
    function getStringList() {
      var count2 = getLEB();
      var rtn = [];
      while (count2--)
        rtn.push(getString());
      return rtn;
    }
    __name(getStringList, "getStringList");
    function failIf(condition, message) {
      if (condition)
        throw new Error(message);
    }
    __name(failIf, "failIf");
    if (binary2 instanceof WebAssembly.Module) {
      var dylinkSection = WebAssembly.Module.customSections(binary2, "dylink.0");
      failIf(dylinkSection.length === 0, "need dylink section");
      binary2 = new Uint8Array(dylinkSection[0]);
      end = binary2.length;
    } else {
      var int32View = new Uint32Array(new Uint8Array(binary2.subarray(0, 24)).buffer);
      var magicNumberFound = int32View[0] == 1836278016 || int32View[0] == 6386541;
      failIf(!magicNumberFound, "need to see wasm magic number");
      failIf(binary2[8] !== 0, "need the dylink section to be first");
      offset = 9;
      var section_size = getLEB();
      end = offset + section_size;
      var name2 = getString();
      failIf(name2 !== "dylink.0");
    }
    var customSection = {
      neededDynlibs: [],
      tlsExports: /* @__PURE__ */ new Set,
      weakImports: /* @__PURE__ */ new Set,
      runtimePaths: []
    };
    var WASM_DYLINK_MEM_INFO = 1;
    var WASM_DYLINK_NEEDED = 2;
    var WASM_DYLINK_EXPORT_INFO = 3;
    var WASM_DYLINK_IMPORT_INFO = 4;
    var WASM_DYLINK_RUNTIME_PATH = 5;
    var WASM_SYMBOL_TLS = 256;
    var WASM_SYMBOL_BINDING_MASK = 3;
    var WASM_SYMBOL_BINDING_WEAK = 1;
    while (offset < end) {
      var subsectionType = getU8();
      var subsectionSize = getLEB();
      if (subsectionType === WASM_DYLINK_MEM_INFO) {
        customSection.memorySize = getLEB();
        customSection.memoryAlign = getLEB();
        customSection.tableSize = getLEB();
        customSection.tableAlign = getLEB();
      } else if (subsectionType === WASM_DYLINK_NEEDED) {
        customSection.neededDynlibs = getStringList();
      } else if (subsectionType === WASM_DYLINK_EXPORT_INFO) {
        var count = getLEB();
        while (count--) {
          var symname = getString();
          var flags2 = getLEB();
          if (flags2 & WASM_SYMBOL_TLS) {
            customSection.tlsExports.add(symname);
          }
        }
      } else if (subsectionType === WASM_DYLINK_IMPORT_INFO) {
        var count = getLEB();
        while (count--) {
          var modname = getString();
          var symname = getString();
          var flags2 = getLEB();
          if ((flags2 & WASM_SYMBOL_BINDING_MASK) == WASM_SYMBOL_BINDING_WEAK) {
            customSection.weakImports.add(symname);
          }
        }
      } else if (subsectionType === WASM_DYLINK_RUNTIME_PATH) {
        customSection.runtimePaths = getStringList();
      } else {
        offset += subsectionSize;
      }
    }
    return customSection;
  }, "getDylinkMetadata");
  function getValue(ptr, type = "i8") {
    if (type.endsWith("*"))
      type = "*";
    switch (type) {
      case "i1":
        return HEAP8[ptr];
      case "i8":
        return HEAP8[ptr];
      case "i16":
        return LE_HEAP_LOAD_I16((ptr >> 1) * 2);
      case "i32":
        return LE_HEAP_LOAD_I32((ptr >> 2) * 4);
      case "i64":
        return LE_HEAP_LOAD_I64((ptr >> 3) * 8);
      case "float":
        return LE_HEAP_LOAD_F32((ptr >> 2) * 4);
      case "double":
        return LE_HEAP_LOAD_F64((ptr >> 3) * 8);
      case "*":
        return LE_HEAP_LOAD_U32((ptr >> 2) * 4);
      default:
        abort(`invalid type for getValue: ${type}`);
    }
  }
  __name(getValue, "getValue");
  var newDSO = /* @__PURE__ */ __name((name2, handle2, syms) => {
    var dso = {
      refcount: Infinity,
      name: name2,
      exports: syms,
      global: true
    };
    LDSO.loadedLibsByName[name2] = dso;
    if (handle2 != null) {
      LDSO.loadedLibsByHandle[handle2] = dso;
    }
    return dso;
  }, "newDSO");
  var LDSO = {
    loadedLibsByName: {},
    loadedLibsByHandle: {},
    init() {
      newDSO("__main__", 0, wasmImports);
    }
  };
  var ___heap_base = 78240;
  var alignMemory = /* @__PURE__ */ __name((size, alignment) => Math.ceil(size / alignment) * alignment, "alignMemory");
  var getMemory = /* @__PURE__ */ __name((size) => {
    if (runtimeInitialized) {
      return _calloc(size, 1);
    }
    var ret = ___heap_base;
    var end = ret + alignMemory(size, 16);
    ___heap_base = end;
    GOT["__heap_base"].value = end;
    return ret;
  }, "getMemory");
  var isInternalSym = /* @__PURE__ */ __name((symName) => ["__cpp_exception", "__c_longjmp", "__wasm_apply_data_relocs", "__dso_handle", "__tls_size", "__tls_align", "__set_stack_limits", "_emscripten_tls_init", "__wasm_init_tls", "__wasm_call_ctors", "__start_em_asm", "__stop_em_asm", "__start_em_js", "__stop_em_js"].includes(symName) || symName.startsWith("__em_js__"), "isInternalSym");
  var uleb128EncodeWithLen = /* @__PURE__ */ __name((arr) => {
    const n = arr.length;
    return [n % 128 | 128, n >> 7, ...arr];
  }, "uleb128EncodeWithLen");
  var wasmTypeCodes = {
    i: 127,
    p: 127,
    j: 126,
    f: 125,
    d: 124,
    e: 111
  };
  var generateTypePack = /* @__PURE__ */ __name((types) => uleb128EncodeWithLen(Array.from(types, (type) => {
    var code = wasmTypeCodes[type];
    return code;
  })), "generateTypePack");
  var convertJsFunctionToWasm = /* @__PURE__ */ __name((func2, sig) => {
    var bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...uleb128EncodeWithLen([
      1,
      96,
      ...generateTypePack(sig.slice(1)),
      ...generateTypePack(sig[0] === "v" ? "" : sig[0])
    ]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
    var module2 = new WebAssembly.Module(bytes);
    var instance2 = new WebAssembly.Instance(module2, {
      e: {
        f: func2
      }
    });
    var wrappedFunc = instance2.exports["f"];
    return wrappedFunc;
  }, "convertJsFunctionToWasm");
  var wasmTableMirror = [];
  var wasmTable = new WebAssembly.Table({
    initial: 31,
    element: "anyfunc"
  });
  var getWasmTableEntry = /* @__PURE__ */ __name((funcPtr) => {
    var func2 = wasmTableMirror[funcPtr];
    if (!func2) {
      wasmTableMirror[funcPtr] = func2 = wasmTable.get(funcPtr);
    }
    return func2;
  }, "getWasmTableEntry");
  var updateTableMap = /* @__PURE__ */ __name((offset, count) => {
    if (functionsInTableMap) {
      for (var i2 = offset;i2 < offset + count; i2++) {
        var item = getWasmTableEntry(i2);
        if (item) {
          functionsInTableMap.set(item, i2);
        }
      }
    }
  }, "updateTableMap");
  var functionsInTableMap;
  var getFunctionAddress = /* @__PURE__ */ __name((func2) => {
    if (!functionsInTableMap) {
      functionsInTableMap = /* @__PURE__ */ new WeakMap;
      updateTableMap(0, wasmTable.length);
    }
    return functionsInTableMap.get(func2) || 0;
  }, "getFunctionAddress");
  var freeTableIndexes = [];
  var getEmptyTableSlot = /* @__PURE__ */ __name(() => {
    if (freeTableIndexes.length) {
      return freeTableIndexes.pop();
    }
    return wasmTable["grow"](1);
  }, "getEmptyTableSlot");
  var setWasmTableEntry = /* @__PURE__ */ __name((idx, func2) => {
    wasmTable.set(idx, func2);
    wasmTableMirror[idx] = wasmTable.get(idx);
  }, "setWasmTableEntry");
  var addFunction = /* @__PURE__ */ __name((func2, sig) => {
    var rtn = getFunctionAddress(func2);
    if (rtn) {
      return rtn;
    }
    var ret = getEmptyTableSlot();
    try {
      setWasmTableEntry(ret, func2);
    } catch (err2) {
      if (!(err2 instanceof TypeError)) {
        throw err2;
      }
      var wrapped = convertJsFunctionToWasm(func2, sig);
      setWasmTableEntry(ret, wrapped);
    }
    functionsInTableMap.set(func2, ret);
    return ret;
  }, "addFunction");
  var updateGOT = /* @__PURE__ */ __name((exports, replace) => {
    for (var symName in exports) {
      if (isInternalSym(symName)) {
        continue;
      }
      var value = exports[symName];
      GOT[symName] ||= new WebAssembly.Global({
        value: "i32",
        mutable: true
      });
      if (replace || GOT[symName].value == 0) {
        if (typeof value == "function") {
          GOT[symName].value = addFunction(value);
        } else if (typeof value == "number") {
          GOT[symName].value = value;
        } else {
          err(`unhandled export type for '${symName}': ${typeof value}`);
        }
      }
    }
  }, "updateGOT");
  var relocateExports = /* @__PURE__ */ __name((exports, memoryBase2, replace) => {
    var relocated = {};
    for (var e in exports) {
      var value = exports[e];
      if (typeof value == "object") {
        value = value.value;
      }
      if (typeof value == "number") {
        value += memoryBase2;
      }
      relocated[e] = value;
    }
    updateGOT(relocated, replace);
    return relocated;
  }, "relocateExports");
  var isSymbolDefined = /* @__PURE__ */ __name((symName) => {
    var existing = wasmImports[symName];
    if (!existing || existing.stub) {
      return false;
    }
    return true;
  }, "isSymbolDefined");
  var dynCall = /* @__PURE__ */ __name((sig, ptr, args2 = [], promising = false) => {
    var func2 = getWasmTableEntry(ptr);
    var rtn = func2(...args2);
    function convert(rtn2) {
      return rtn2;
    }
    __name(convert, "convert");
    return convert(rtn);
  }, "dynCall");
  var stackSave = /* @__PURE__ */ __name(() => _emscripten_stack_get_current(), "stackSave");
  var stackRestore = /* @__PURE__ */ __name((val) => __emscripten_stack_restore(val), "stackRestore");
  var createInvokeFunction = /* @__PURE__ */ __name((sig) => (ptr, ...args2) => {
    var sp = stackSave();
    try {
      return dynCall(sig, ptr, args2);
    } catch (e) {
      stackRestore(sp);
      if (e !== e + 0)
        throw e;
      _setThrew(1, 0);
      if (sig[0] == "j")
        return 0n;
    }
  }, "createInvokeFunction");
  var resolveGlobalSymbol = /* @__PURE__ */ __name((symName, direct = false) => {
    var sym;
    if (isSymbolDefined(symName)) {
      sym = wasmImports[symName];
    } else if (symName.startsWith("invoke_")) {
      sym = wasmImports[symName] = createInvokeFunction(symName.split("_")[1]);
    }
    return {
      sym,
      name: symName
    };
  }, "resolveGlobalSymbol");
  var onPostCtors = [];
  var addOnPostCtor = /* @__PURE__ */ __name((cb) => onPostCtors.push(cb), "addOnPostCtor");
  var UTF8ToString = /* @__PURE__ */ __name((ptr, maxBytesToRead, ignoreNul) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "", "UTF8ToString");
  var loadWebAssemblyModule = /* @__PURE__ */ __name((binary, flags, libName, localScope, handle) => {
    var metadata = getDylinkMetadata(binary);
    function loadModule() {
      var memAlign = Math.pow(2, metadata.memoryAlign);
      var memoryBase = metadata.memorySize ? alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
      var tableBase = metadata.tableSize ? wasmTable.length : 0;
      if (handle) {
        HEAP8[handle + 8] = 1;
        LE_HEAP_STORE_U32((handle + 12 >> 2) * 4, memoryBase);
        LE_HEAP_STORE_I32((handle + 16 >> 2) * 4, metadata.memorySize);
        LE_HEAP_STORE_U32((handle + 20 >> 2) * 4, tableBase);
        LE_HEAP_STORE_I32((handle + 24 >> 2) * 4, metadata.tableSize);
      }
      if (metadata.tableSize) {
        wasmTable.grow(metadata.tableSize);
      }
      var moduleExports;
      function resolveSymbol(sym) {
        var resolved = resolveGlobalSymbol(sym).sym;
        if (!resolved && localScope) {
          resolved = localScope[sym];
        }
        if (!resolved) {
          resolved = moduleExports[sym];
        }
        return resolved;
      }
      __name(resolveSymbol, "resolveSymbol");
      var proxyHandler = {
        get(stubs, prop) {
          switch (prop) {
            case "__memory_base":
              return memoryBase;
            case "__table_base":
              return tableBase;
          }
          if (prop in wasmImports && !wasmImports[prop].stub) {
            var res = wasmImports[prop];
            return res;
          }
          if (!(prop in stubs)) {
            var resolved;
            stubs[prop] = (...args2) => {
              resolved ||= resolveSymbol(prop);
              return resolved(...args2);
            };
          }
          return stubs[prop];
        }
      };
      var proxy = new Proxy({}, proxyHandler);
      currentModuleWeakSymbols = metadata.weakImports;
      var info = {
        "GOT.mem": new Proxy({}, GOTHandler),
        "GOT.func": new Proxy({}, GOTHandler),
        env: proxy,
        wasi_snapshot_preview1: proxy
      };
      function postInstantiation(module, instance) {
        updateTableMap(tableBase, metadata.tableSize);
        moduleExports = relocateExports(instance.exports, memoryBase);
        if (!flags.allowUndefined) {
          reportUndefinedSymbols();
        }
        function addEmAsm(addr, body) {
          var args = [];
          var arity = 0;
          for (;arity < 16; arity++) {
            if (body.indexOf("$" + arity) != -1) {
              args.push("$" + arity);
            } else {
              break;
            }
          }
          args = args.join(",");
          var func = `(${args}) => { ${body} };`;
          ASM_CONSTS[start] = eval(func);
        }
        __name(addEmAsm, "addEmAsm");
        if ("__start_em_asm" in moduleExports) {
          var start = moduleExports["__start_em_asm"];
          var stop = moduleExports["__stop_em_asm"];
          while (start < stop) {
            var jsString = UTF8ToString(start);
            addEmAsm(start, jsString);
            start = HEAPU8.indexOf(0, start) + 1;
          }
        }
        function addEmJs(name, cSig, body) {
          var jsArgs = [];
          cSig = cSig.slice(1, -1);
          if (cSig != "void") {
            cSig = cSig.split(",");
            for (var i in cSig) {
              var jsArg = cSig[i].split(" ").pop();
              jsArgs.push(jsArg.replace("*", ""));
            }
          }
          var func = `(${jsArgs}) => ${body};`;
          moduleExports[name] = eval(func);
        }
        __name(addEmJs, "addEmJs");
        for (var name in moduleExports) {
          if (name.startsWith("__em_js__")) {
            var start = moduleExports[name];
            var jsString = UTF8ToString(start);
            var parts = jsString.split("<::>");
            addEmJs(name.replace("__em_js__", ""), parts[0], parts[1]);
            delete moduleExports[name];
          }
        }
        var applyRelocs = moduleExports["__wasm_apply_data_relocs"];
        if (applyRelocs) {
          if (runtimeInitialized) {
            applyRelocs();
          } else {
            __RELOC_FUNCS__.push(applyRelocs);
          }
        }
        var init = moduleExports["__wasm_call_ctors"];
        if (init) {
          if (runtimeInitialized) {
            init();
          } else {
            addOnPostCtor(init);
          }
        }
        return moduleExports;
      }
      __name(postInstantiation, "postInstantiation");
      if (flags.loadAsync) {
        return (async () => {
          var instance2;
          if (binary instanceof WebAssembly.Module) {
            instance2 = new WebAssembly.Instance(binary, info);
          } else {
            ({ module: binary, instance: instance2 } = await WebAssembly.instantiate(binary, info));
          }
          return postInstantiation(binary, instance2);
        })();
      }
      var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
      var instance = new WebAssembly.Instance(module, info);
      return postInstantiation(module, instance);
    }
    __name(loadModule, "loadModule");
    flags = {
      ...flags,
      rpath: {
        parentLibPath: libName,
        paths: metadata.runtimePaths
      }
    };
    if (flags.loadAsync) {
      return metadata.neededDynlibs.reduce((chain, dynNeeded) => chain.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
    }
    metadata.neededDynlibs.forEach((needed) => loadDynamicLibrary(needed, flags, localScope));
    return loadModule();
  }, "loadWebAssemblyModule");
  var mergeLibSymbols = /* @__PURE__ */ __name((exports, libName2) => {
    for (var [sym, exp] of Object.entries(exports)) {
      const setImport = /* @__PURE__ */ __name((target) => {
        if (!isSymbolDefined(target)) {
          wasmImports[target] = exp;
        }
      }, "setImport");
      setImport(sym);
      const main_alias = "__main_argc_argv";
      if (sym == "main") {
        setImport(main_alias);
      }
      if (sym == main_alias) {
        setImport("main");
      }
    }
  }, "mergeLibSymbols");
  var asyncLoad = /* @__PURE__ */ __name(async (url) => {
    var arrayBuffer = await readAsync(url);
    return new Uint8Array(arrayBuffer);
  }, "asyncLoad");
  function loadDynamicLibrary(libName2, flags2 = {
    global: true,
    nodelete: true
  }, localScope2, handle2) {
    var dso = LDSO.loadedLibsByName[libName2];
    if (dso) {
      if (!flags2.global) {
        if (localScope2) {
          Object.assign(localScope2, dso.exports);
        }
      } else if (!dso.global) {
        dso.global = true;
        mergeLibSymbols(dso.exports, libName2);
      }
      if (flags2.nodelete && dso.refcount !== Infinity) {
        dso.refcount = Infinity;
      }
      dso.refcount++;
      if (handle2) {
        LDSO.loadedLibsByHandle[handle2] = dso;
      }
      return flags2.loadAsync ? Promise.resolve(true) : true;
    }
    dso = newDSO(libName2, handle2, "loading");
    dso.refcount = flags2.nodelete ? Infinity : 1;
    dso.global = flags2.global;
    function loadLibData() {
      if (handle2) {
        var data = LE_HEAP_LOAD_U32((handle2 + 28 >> 2) * 4);
        var dataSize = LE_HEAP_LOAD_U32((handle2 + 32 >> 2) * 4);
        if (data && dataSize) {
          var libData = HEAP8.slice(data, data + dataSize);
          return flags2.loadAsync ? Promise.resolve(libData) : libData;
        }
      }
      var libFile = locateFile(libName2);
      if (flags2.loadAsync) {
        return asyncLoad(libFile);
      }
      if (!readBinary) {
        throw new Error(`${libFile}: file not found, and synchronous loading of external files is not available`);
      }
      return readBinary(libFile);
    }
    __name(loadLibData, "loadLibData");
    function getExports() {
      if (flags2.loadAsync) {
        return loadLibData().then((libData) => loadWebAssemblyModule(libData, flags2, libName2, localScope2, handle2));
      }
      return loadWebAssemblyModule(loadLibData(), flags2, libName2, localScope2, handle2);
    }
    __name(getExports, "getExports");
    function moduleLoaded(exports) {
      if (dso.global) {
        mergeLibSymbols(exports, libName2);
      } else if (localScope2) {
        Object.assign(localScope2, exports);
      }
      dso.exports = exports;
    }
    __name(moduleLoaded, "moduleLoaded");
    if (flags2.loadAsync) {
      return getExports().then((exports) => {
        moduleLoaded(exports);
        return true;
      });
    }
    moduleLoaded(getExports());
    return true;
  }
  __name(loadDynamicLibrary, "loadDynamicLibrary");
  var reportUndefinedSymbols = /* @__PURE__ */ __name(() => {
    for (var [symName, entry] of Object.entries(GOT)) {
      if (entry.value == 0) {
        var value = resolveGlobalSymbol(symName, true).sym;
        if (!value && !entry.required) {
          continue;
        }
        if (typeof value == "function") {
          entry.value = addFunction(value, value.sig);
        } else if (typeof value == "number") {
          entry.value = value;
        } else {
          throw new Error(`bad export type for '${symName}': ${typeof value}`);
        }
      }
    }
  }, "reportUndefinedSymbols");
  var runDependencies = 0;
  var dependenciesFulfilled = null;
  var removeRunDependency = /* @__PURE__ */ __name((id) => {
    runDependencies--;
    Module["monitorRunDependencies"]?.(runDependencies);
    if (runDependencies == 0) {
      if (dependenciesFulfilled) {
        var callback = dependenciesFulfilled;
        dependenciesFulfilled = null;
        callback();
      }
    }
  }, "removeRunDependency");
  var addRunDependency = /* @__PURE__ */ __name((id) => {
    runDependencies++;
    Module["monitorRunDependencies"]?.(runDependencies);
  }, "addRunDependency");
  var loadDylibs = /* @__PURE__ */ __name(async () => {
    if (!dynamicLibraries.length) {
      reportUndefinedSymbols();
      return;
    }
    addRunDependency("loadDylibs");
    for (var lib of dynamicLibraries) {
      await loadDynamicLibrary(lib, {
        loadAsync: true,
        global: true,
        nodelete: true,
        allowUndefined: true
      });
    }
    reportUndefinedSymbols();
    removeRunDependency("loadDylibs");
  }, "loadDylibs");
  var noExitRuntime = true;
  function setValue(ptr, value, type = "i8") {
    if (type.endsWith("*"))
      type = "*";
    switch (type) {
      case "i1":
        HEAP8[ptr] = value;
        break;
      case "i8":
        HEAP8[ptr] = value;
        break;
      case "i16":
        LE_HEAP_STORE_I16((ptr >> 1) * 2, value);
        break;
      case "i32":
        LE_HEAP_STORE_I32((ptr >> 2) * 4, value);
        break;
      case "i64":
        LE_HEAP_STORE_I64((ptr >> 3) * 8, BigInt(value));
        break;
      case "float":
        LE_HEAP_STORE_F32((ptr >> 2) * 4, value);
        break;
      case "double":
        LE_HEAP_STORE_F64((ptr >> 3) * 8, value);
        break;
      case "*":
        LE_HEAP_STORE_U32((ptr >> 2) * 4, value);
        break;
      default:
        abort(`invalid type for setValue: ${type}`);
    }
  }
  __name(setValue, "setValue");
  var ___memory_base = new WebAssembly.Global({
    value: "i32",
    mutable: false
  }, 1024);
  var ___stack_high = 78240;
  var ___stack_low = 12704;
  var ___stack_pointer = new WebAssembly.Global({
    value: "i32",
    mutable: true
  }, 78240);
  var ___table_base = new WebAssembly.Global({
    value: "i32",
    mutable: false
  }, 1);
  var __abort_js = /* @__PURE__ */ __name(() => abort(""), "__abort_js");
  __abort_js.sig = "v";
  var getHeapMax = /* @__PURE__ */ __name(() => 2147483648, "getHeapMax");
  var growMemory = /* @__PURE__ */ __name((size) => {
    var oldHeapSize = wasmMemory.buffer.byteLength;
    var pages = (size - oldHeapSize + 65535) / 65536 | 0;
    try {
      wasmMemory.grow(pages);
      updateMemoryViews();
      return 1;
    } catch (e) {}
  }, "growMemory");
  var _emscripten_resize_heap = /* @__PURE__ */ __name((requestedSize) => {
    var oldSize = HEAPU8.length;
    requestedSize >>>= 0;
    var maxHeapSize = getHeapMax();
    if (requestedSize > maxHeapSize) {
      return false;
    }
    for (var cutDown = 1;cutDown <= 4; cutDown *= 2) {
      var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
      overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
      var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
      var replacement = growMemory(newSize);
      if (replacement) {
        return true;
      }
    }
    return false;
  }, "_emscripten_resize_heap");
  _emscripten_resize_heap.sig = "ip";
  var _fd_close = /* @__PURE__ */ __name((fd) => 52, "_fd_close");
  _fd_close.sig = "ii";
  var INT53_MAX = 9007199254740992;
  var INT53_MIN = -9007199254740992;
  var bigintToI53Checked = /* @__PURE__ */ __name((num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num), "bigintToI53Checked");
  function _fd_seek(fd, offset, whence, newOffset) {
    offset = bigintToI53Checked(offset);
    return 70;
  }
  __name(_fd_seek, "_fd_seek");
  _fd_seek.sig = "iijip";
  var printCharBuffers = [null, [], []];
  var printChar = /* @__PURE__ */ __name((stream, curr) => {
    var buffer = printCharBuffers[stream];
    if (curr === 0 || curr === 10) {
      (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
      buffer.length = 0;
    } else {
      buffer.push(curr);
    }
  }, "printChar");
  var _fd_write = /* @__PURE__ */ __name((fd, iov, iovcnt, pnum) => {
    var num = 0;
    for (var i2 = 0;i2 < iovcnt; i2++) {
      var ptr = LE_HEAP_LOAD_U32((iov >> 2) * 4);
      var len = LE_HEAP_LOAD_U32((iov + 4 >> 2) * 4);
      iov += 8;
      for (var j = 0;j < len; j++) {
        printChar(fd, HEAPU8[ptr + j]);
      }
      num += len;
    }
    LE_HEAP_STORE_U32((pnum >> 2) * 4, num);
    return 0;
  }, "_fd_write");
  _fd_write.sig = "iippp";
  function _tree_sitter_log_callback(isLexMessage, messageAddress) {
    if (Module.currentLogCallback) {
      const message = UTF8ToString(messageAddress);
      Module.currentLogCallback(message, isLexMessage !== 0);
    }
  }
  __name(_tree_sitter_log_callback, "_tree_sitter_log_callback");
  function _tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress) {
    const INPUT_BUFFER_SIZE = 10240;
    const string = Module.currentParseCallback(index, {
      row,
      column
    });
    if (typeof string === "string") {
      setValue(lengthAddress, string.length, "i32");
      stringToUTF16(string, inputBufferAddress, INPUT_BUFFER_SIZE);
    } else {
      setValue(lengthAddress, 0, "i32");
    }
  }
  __name(_tree_sitter_parse_callback, "_tree_sitter_parse_callback");
  function _tree_sitter_progress_callback(currentOffset, hasError) {
    if (Module.currentProgressCallback) {
      return Module.currentProgressCallback({
        currentOffset,
        hasError
      });
    }
    return false;
  }
  __name(_tree_sitter_progress_callback, "_tree_sitter_progress_callback");
  function _tree_sitter_query_progress_callback(currentOffset) {
    if (Module.currentQueryProgressCallback) {
      return Module.currentQueryProgressCallback({
        currentOffset
      });
    }
    return false;
  }
  __name(_tree_sitter_query_progress_callback, "_tree_sitter_query_progress_callback");
  var runtimeKeepaliveCounter = 0;
  var keepRuntimeAlive = /* @__PURE__ */ __name(() => noExitRuntime || runtimeKeepaliveCounter > 0, "keepRuntimeAlive");
  var _proc_exit = /* @__PURE__ */ __name((code) => {
    EXITSTATUS = code;
    if (!keepRuntimeAlive()) {
      Module["onExit"]?.(code);
      ABORT = true;
    }
    quit_(code, new ExitStatus(code));
  }, "_proc_exit");
  _proc_exit.sig = "vi";
  var exitJS = /* @__PURE__ */ __name((status, implicit) => {
    EXITSTATUS = status;
    _proc_exit(status);
  }, "exitJS");
  var handleException = /* @__PURE__ */ __name((e) => {
    if (e instanceof ExitStatus || e == "unwind") {
      return EXITSTATUS;
    }
    quit_(1, e);
  }, "handleException");
  var lengthBytesUTF8 = /* @__PURE__ */ __name((str) => {
    var len = 0;
    for (var i2 = 0;i2 < str.length; ++i2) {
      var c = str.charCodeAt(i2);
      if (c <= 127) {
        len++;
      } else if (c <= 2047) {
        len += 2;
      } else if (c >= 55296 && c <= 57343) {
        len += 4;
        ++i2;
      } else {
        len += 3;
      }
    }
    return len;
  }, "lengthBytesUTF8");
  var stringToUTF8Array = /* @__PURE__ */ __name((str, heap, outIdx, maxBytesToWrite) => {
    if (!(maxBytesToWrite > 0))
      return 0;
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite - 1;
    for (var i2 = 0;i2 < str.length; ++i2) {
      var u = str.codePointAt(i2);
      if (u <= 127) {
        if (outIdx >= endIdx)
          break;
        heap[outIdx++] = u;
      } else if (u <= 2047) {
        if (outIdx + 1 >= endIdx)
          break;
        heap[outIdx++] = 192 | u >> 6;
        heap[outIdx++] = 128 | u & 63;
      } else if (u <= 65535) {
        if (outIdx + 2 >= endIdx)
          break;
        heap[outIdx++] = 224 | u >> 12;
        heap[outIdx++] = 128 | u >> 6 & 63;
        heap[outIdx++] = 128 | u & 63;
      } else {
        if (outIdx + 3 >= endIdx)
          break;
        heap[outIdx++] = 240 | u >> 18;
        heap[outIdx++] = 128 | u >> 12 & 63;
        heap[outIdx++] = 128 | u >> 6 & 63;
        heap[outIdx++] = 128 | u & 63;
        i2++;
      }
    }
    heap[outIdx] = 0;
    return outIdx - startIdx;
  }, "stringToUTF8Array");
  var stringToUTF8 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite), "stringToUTF8");
  var stackAlloc = /* @__PURE__ */ __name((sz) => __emscripten_stack_alloc(sz), "stackAlloc");
  var stringToUTF8OnStack = /* @__PURE__ */ __name((str) => {
    var size = lengthBytesUTF8(str) + 1;
    var ret = stackAlloc(size);
    stringToUTF8(str, ret, size);
    return ret;
  }, "stringToUTF8OnStack");
  var AsciiToString = /* @__PURE__ */ __name((ptr) => {
    var str = "";
    while (true) {
      var ch = HEAPU8[ptr++];
      if (!ch)
        return str;
      str += String.fromCharCode(ch);
    }
  }, "AsciiToString");
  var stringToUTF16 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => {
    maxBytesToWrite ??= 2147483647;
    if (maxBytesToWrite < 2)
      return 0;
    maxBytesToWrite -= 2;
    var startPtr = outPtr;
    var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
    for (var i2 = 0;i2 < numCharsToWrite; ++i2) {
      var codeUnit = str.charCodeAt(i2);
      LE_HEAP_STORE_I16((outPtr >> 1) * 2, codeUnit);
      outPtr += 2;
    }
    LE_HEAP_STORE_I16((outPtr >> 1) * 2, 0);
    return outPtr - startPtr;
  }, "stringToUTF16");
  LE_ATOMICS_NATIVE_BYTE_ORDER = new Int8Array(new Int16Array([1]).buffer)[0] === 1 ? [
    (x) => x,
    (x) => x,
    undefined,
    (x) => x
  ] : [
    (x) => x,
    (x) => ((x & 65280) << 8 | (x & 255) << 24) >> 16,
    undefined,
    (x) => x >> 24 & 255 | x >> 8 & 65280 | (x & 65280) << 8 | (x & 255) << 24
  ];
  function LE_HEAP_UPDATE() {
    HEAPU16.unsigned = (x) => x & 65535;
    HEAPU32.unsigned = (x) => x >>> 0;
  }
  __name(LE_HEAP_UPDATE, "LE_HEAP_UPDATE");
  {
    initMemory();
    if (Module["noExitRuntime"])
      noExitRuntime = Module["noExitRuntime"];
    if (Module["print"])
      out = Module["print"];
    if (Module["printErr"])
      err = Module["printErr"];
    if (Module["dynamicLibraries"])
      dynamicLibraries = Module["dynamicLibraries"];
    if (Module["wasmBinary"])
      wasmBinary = Module["wasmBinary"];
    if (Module["arguments"])
      arguments_ = Module["arguments"];
    if (Module["thisProgram"])
      thisProgram = Module["thisProgram"];
    if (Module["preInit"]) {
      if (typeof Module["preInit"] == "function")
        Module["preInit"] = [Module["preInit"]];
      while (Module["preInit"].length > 0) {
        Module["preInit"].shift()();
      }
    }
  }
  Module["setValue"] = setValue;
  Module["getValue"] = getValue;
  Module["UTF8ToString"] = UTF8ToString;
  Module["stringToUTF8"] = stringToUTF8;
  Module["lengthBytesUTF8"] = lengthBytesUTF8;
  Module["AsciiToString"] = AsciiToString;
  Module["stringToUTF16"] = stringToUTF16;
  Module["loadWebAssemblyModule"] = loadWebAssemblyModule;
  Module["LE_HEAP_STORE_I64"] = LE_HEAP_STORE_I64;
  var ASM_CONSTS = {};
  var _malloc, _calloc, _realloc, _free, _ts_range_edit, _memcmp, _ts_language_symbol_count, _ts_language_state_count, _ts_language_abi_version, _ts_language_name, _ts_language_field_count, _ts_language_next_state, _ts_language_symbol_name, _ts_language_symbol_for_name, _strncmp, _ts_language_symbol_type, _ts_language_field_name_for_id, _ts_lookahead_iterator_new, _ts_lookahead_iterator_delete, _ts_lookahead_iterator_reset_state, _ts_lookahead_iterator_reset, _ts_lookahead_iterator_next, _ts_lookahead_iterator_current_symbol, _ts_point_edit, _ts_parser_delete, _ts_parser_reset, _ts_parser_set_language, _ts_parser_set_included_ranges, _ts_query_new, _ts_query_delete, _iswspace, _iswalnum, _ts_query_pattern_count, _ts_query_capture_count, _ts_query_string_count, _ts_query_capture_name_for_id, _ts_query_capture_quantifier_for_id, _ts_query_string_value_for_id, _ts_query_predicates_for_pattern, _ts_query_start_byte_for_pattern, _ts_query_end_byte_for_pattern, _ts_query_is_pattern_rooted, _ts_query_is_pattern_non_local, _ts_query_is_pattern_guaranteed_at_step, _ts_query_disable_capture, _ts_query_disable_pattern, _ts_tree_copy, _ts_tree_delete, _ts_init, _ts_parser_new_wasm, _ts_parser_enable_logger_wasm, _ts_parser_parse_wasm, _ts_parser_included_ranges_wasm, _ts_language_type_is_named_wasm, _ts_language_type_is_visible_wasm, _ts_language_metadata_wasm, _ts_language_supertypes_wasm, _ts_language_subtypes_wasm, _ts_tree_root_node_wasm, _ts_tree_root_node_with_offset_wasm, _ts_tree_edit_wasm, _ts_tree_included_ranges_wasm, _ts_tree_get_changed_ranges_wasm, _ts_tree_cursor_new_wasm, _ts_tree_cursor_copy_wasm, _ts_tree_cursor_delete_wasm, _ts_tree_cursor_reset_wasm, _ts_tree_cursor_reset_to_wasm, _ts_tree_cursor_goto_first_child_wasm, _ts_tree_cursor_goto_last_child_wasm, _ts_tree_cursor_goto_first_child_for_index_wasm, _ts_tree_cursor_goto_first_child_for_position_wasm, _ts_tree_cursor_goto_next_sibling_wasm, _ts_tree_cursor_goto_previous_sibling_wasm, _ts_tree_cursor_goto_descendant_wasm, _ts_tree_cursor_goto_parent_wasm, _ts_tree_cursor_current_node_type_id_wasm, _ts_tree_cursor_current_node_state_id_wasm, _ts_tree_cursor_current_node_is_named_wasm, _ts_tree_cursor_current_node_is_missing_wasm, _ts_tree_cursor_current_node_id_wasm, _ts_tree_cursor_start_position_wasm, _ts_tree_cursor_end_position_wasm, _ts_tree_cursor_start_index_wasm, _ts_tree_cursor_end_index_wasm, _ts_tree_cursor_current_field_id_wasm, _ts_tree_cursor_current_depth_wasm, _ts_tree_cursor_current_descendant_index_wasm, _ts_tree_cursor_current_node_wasm, _ts_node_symbol_wasm, _ts_node_field_name_for_child_wasm, _ts_node_field_name_for_named_child_wasm, _ts_node_children_by_field_id_wasm, _ts_node_first_child_for_byte_wasm, _ts_node_first_named_child_for_byte_wasm, _ts_node_grammar_symbol_wasm, _ts_node_child_count_wasm, _ts_node_named_child_count_wasm, _ts_node_child_wasm, _ts_node_named_child_wasm, _ts_node_child_by_field_id_wasm, _ts_node_next_sibling_wasm, _ts_node_prev_sibling_wasm, _ts_node_next_named_sibling_wasm, _ts_node_prev_named_sibling_wasm, _ts_node_descendant_count_wasm, _ts_node_parent_wasm, _ts_node_child_with_descendant_wasm, _ts_node_descendant_for_index_wasm, _ts_node_named_descendant_for_index_wasm, _ts_node_descendant_for_position_wasm, _ts_node_named_descendant_for_position_wasm, _ts_node_start_point_wasm, _ts_node_end_point_wasm, _ts_node_start_index_wasm, _ts_node_end_index_wasm, _ts_node_to_string_wasm, _ts_node_children_wasm, _ts_node_named_children_wasm, _ts_node_descendants_of_type_wasm, _ts_node_is_named_wasm, _ts_node_has_changes_wasm, _ts_node_has_error_wasm, _ts_node_is_error_wasm, _ts_node_is_missing_wasm, _ts_node_is_extra_wasm, _ts_node_parse_state_wasm, _ts_node_next_parse_state_wasm, _ts_query_matches_wasm, _ts_query_captures_wasm, _memset, _memcpy, _memmove, _iswalpha, _iswblank, _iswdigit, _iswlower, _iswupper, _iswxdigit, _memchr, _strlen, _strcmp, _strncat, _strncpy, _towlower, _towupper, _setThrew, __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current, ___wasm_apply_data_relocs;
  function assignWasmExports(wasmExports2) {
    Module["_malloc"] = _malloc = wasmExports2["malloc"];
    Module["_calloc"] = _calloc = wasmExports2["calloc"];
    Module["_realloc"] = _realloc = wasmExports2["realloc"];
    Module["_free"] = _free = wasmExports2["free"];
    Module["_ts_range_edit"] = _ts_range_edit = wasmExports2["ts_range_edit"];
    Module["_memcmp"] = _memcmp = wasmExports2["memcmp"];
    Module["_ts_language_symbol_count"] = _ts_language_symbol_count = wasmExports2["ts_language_symbol_count"];
    Module["_ts_language_state_count"] = _ts_language_state_count = wasmExports2["ts_language_state_count"];
    Module["_ts_language_abi_version"] = _ts_language_abi_version = wasmExports2["ts_language_abi_version"];
    Module["_ts_language_name"] = _ts_language_name = wasmExports2["ts_language_name"];
    Module["_ts_language_field_count"] = _ts_language_field_count = wasmExports2["ts_language_field_count"];
    Module["_ts_language_next_state"] = _ts_language_next_state = wasmExports2["ts_language_next_state"];
    Module["_ts_language_symbol_name"] = _ts_language_symbol_name = wasmExports2["ts_language_symbol_name"];
    Module["_ts_language_symbol_for_name"] = _ts_language_symbol_for_name = wasmExports2["ts_language_symbol_for_name"];
    Module["_strncmp"] = _strncmp = wasmExports2["strncmp"];
    Module["_ts_language_symbol_type"] = _ts_language_symbol_type = wasmExports2["ts_language_symbol_type"];
    Module["_ts_language_field_name_for_id"] = _ts_language_field_name_for_id = wasmExports2["ts_language_field_name_for_id"];
    Module["_ts_lookahead_iterator_new"] = _ts_lookahead_iterator_new = wasmExports2["ts_lookahead_iterator_new"];
    Module["_ts_lookahead_iterator_delete"] = _ts_lookahead_iterator_delete = wasmExports2["ts_lookahead_iterator_delete"];
    Module["_ts_lookahead_iterator_reset_state"] = _ts_lookahead_iterator_reset_state = wasmExports2["ts_lookahead_iterator_reset_state"];
    Module["_ts_lookahead_iterator_reset"] = _ts_lookahead_iterator_reset = wasmExports2["ts_lookahead_iterator_reset"];
    Module["_ts_lookahead_iterator_next"] = _ts_lookahead_iterator_next = wasmExports2["ts_lookahead_iterator_next"];
    Module["_ts_lookahead_iterator_current_symbol"] = _ts_lookahead_iterator_current_symbol = wasmExports2["ts_lookahead_iterator_current_symbol"];
    Module["_ts_point_edit"] = _ts_point_edit = wasmExports2["ts_point_edit"];
    Module["_ts_parser_delete"] = _ts_parser_delete = wasmExports2["ts_parser_delete"];
    Module["_ts_parser_reset"] = _ts_parser_reset = wasmExports2["ts_parser_reset"];
    Module["_ts_parser_set_language"] = _ts_parser_set_language = wasmExports2["ts_parser_set_language"];
    Module["_ts_parser_set_included_ranges"] = _ts_parser_set_included_ranges = wasmExports2["ts_parser_set_included_ranges"];
    Module["_ts_query_new"] = _ts_query_new = wasmExports2["ts_query_new"];
    Module["_ts_query_delete"] = _ts_query_delete = wasmExports2["ts_query_delete"];
    Module["_iswspace"] = _iswspace = wasmExports2["iswspace"];
    Module["_iswalnum"] = _iswalnum = wasmExports2["iswalnum"];
    Module["_ts_query_pattern_count"] = _ts_query_pattern_count = wasmExports2["ts_query_pattern_count"];
    Module["_ts_query_capture_count"] = _ts_query_capture_count = wasmExports2["ts_query_capture_count"];
    Module["_ts_query_string_count"] = _ts_query_string_count = wasmExports2["ts_query_string_count"];
    Module["_ts_query_capture_name_for_id"] = _ts_query_capture_name_for_id = wasmExports2["ts_query_capture_name_for_id"];
    Module["_ts_query_capture_quantifier_for_id"] = _ts_query_capture_quantifier_for_id = wasmExports2["ts_query_capture_quantifier_for_id"];
    Module["_ts_query_string_value_for_id"] = _ts_query_string_value_for_id = wasmExports2["ts_query_string_value_for_id"];
    Module["_ts_query_predicates_for_pattern"] = _ts_query_predicates_for_pattern = wasmExports2["ts_query_predicates_for_pattern"];
    Module["_ts_query_start_byte_for_pattern"] = _ts_query_start_byte_for_pattern = wasmExports2["ts_query_start_byte_for_pattern"];
    Module["_ts_query_end_byte_for_pattern"] = _ts_query_end_byte_for_pattern = wasmExports2["ts_query_end_byte_for_pattern"];
    Module["_ts_query_is_pattern_rooted"] = _ts_query_is_pattern_rooted = wasmExports2["ts_query_is_pattern_rooted"];
    Module["_ts_query_is_pattern_non_local"] = _ts_query_is_pattern_non_local = wasmExports2["ts_query_is_pattern_non_local"];
    Module["_ts_query_is_pattern_guaranteed_at_step"] = _ts_query_is_pattern_guaranteed_at_step = wasmExports2["ts_query_is_pattern_guaranteed_at_step"];
    Module["_ts_query_disable_capture"] = _ts_query_disable_capture = wasmExports2["ts_query_disable_capture"];
    Module["_ts_query_disable_pattern"] = _ts_query_disable_pattern = wasmExports2["ts_query_disable_pattern"];
    Module["_ts_tree_copy"] = _ts_tree_copy = wasmExports2["ts_tree_copy"];
    Module["_ts_tree_delete"] = _ts_tree_delete = wasmExports2["ts_tree_delete"];
    Module["_ts_init"] = _ts_init = wasmExports2["ts_init"];
    Module["_ts_parser_new_wasm"] = _ts_parser_new_wasm = wasmExports2["ts_parser_new_wasm"];
    Module["_ts_parser_enable_logger_wasm"] = _ts_parser_enable_logger_wasm = wasmExports2["ts_parser_enable_logger_wasm"];
    Module["_ts_parser_parse_wasm"] = _ts_parser_parse_wasm = wasmExports2["ts_parser_parse_wasm"];
    Module["_ts_parser_included_ranges_wasm"] = _ts_parser_included_ranges_wasm = wasmExports2["ts_parser_included_ranges_wasm"];
    Module["_ts_language_type_is_named_wasm"] = _ts_language_type_is_named_wasm = wasmExports2["ts_language_type_is_named_wasm"];
    Module["_ts_language_type_is_visible_wasm"] = _ts_language_type_is_visible_wasm = wasmExports2["ts_language_type_is_visible_wasm"];
    Module["_ts_language_metadata_wasm"] = _ts_language_metadata_wasm = wasmExports2["ts_language_metadata_wasm"];
    Module["_ts_language_supertypes_wasm"] = _ts_language_supertypes_wasm = wasmExports2["ts_language_supertypes_wasm"];
    Module["_ts_language_subtypes_wasm"] = _ts_language_subtypes_wasm = wasmExports2["ts_language_subtypes_wasm"];
    Module["_ts_tree_root_node_wasm"] = _ts_tree_root_node_wasm = wasmExports2["ts_tree_root_node_wasm"];
    Module["_ts_tree_root_node_with_offset_wasm"] = _ts_tree_root_node_with_offset_wasm = wasmExports2["ts_tree_root_node_with_offset_wasm"];
    Module["_ts_tree_edit_wasm"] = _ts_tree_edit_wasm = wasmExports2["ts_tree_edit_wasm"];
    Module["_ts_tree_included_ranges_wasm"] = _ts_tree_included_ranges_wasm = wasmExports2["ts_tree_included_ranges_wasm"];
    Module["_ts_tree_get_changed_ranges_wasm"] = _ts_tree_get_changed_ranges_wasm = wasmExports2["ts_tree_get_changed_ranges_wasm"];
    Module["_ts_tree_cursor_new_wasm"] = _ts_tree_cursor_new_wasm = wasmExports2["ts_tree_cursor_new_wasm"];
    Module["_ts_tree_cursor_copy_wasm"] = _ts_tree_cursor_copy_wasm = wasmExports2["ts_tree_cursor_copy_wasm"];
    Module["_ts_tree_cursor_delete_wasm"] = _ts_tree_cursor_delete_wasm = wasmExports2["ts_tree_cursor_delete_wasm"];
    Module["_ts_tree_cursor_reset_wasm"] = _ts_tree_cursor_reset_wasm = wasmExports2["ts_tree_cursor_reset_wasm"];
    Module["_ts_tree_cursor_reset_to_wasm"] = _ts_tree_cursor_reset_to_wasm = wasmExports2["ts_tree_cursor_reset_to_wasm"];
    Module["_ts_tree_cursor_goto_first_child_wasm"] = _ts_tree_cursor_goto_first_child_wasm = wasmExports2["ts_tree_cursor_goto_first_child_wasm"];
    Module["_ts_tree_cursor_goto_last_child_wasm"] = _ts_tree_cursor_goto_last_child_wasm = wasmExports2["ts_tree_cursor_goto_last_child_wasm"];
    Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = _ts_tree_cursor_goto_first_child_for_index_wasm = wasmExports2["ts_tree_cursor_goto_first_child_for_index_wasm"];
    Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = _ts_tree_cursor_goto_first_child_for_position_wasm = wasmExports2["ts_tree_cursor_goto_first_child_for_position_wasm"];
    Module["_ts_tree_cursor_goto_next_sibling_wasm"] = _ts_tree_cursor_goto_next_sibling_wasm = wasmExports2["ts_tree_cursor_goto_next_sibling_wasm"];
    Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = _ts_tree_cursor_goto_previous_sibling_wasm = wasmExports2["ts_tree_cursor_goto_previous_sibling_wasm"];
    Module["_ts_tree_cursor_goto_descendant_wasm"] = _ts_tree_cursor_goto_descendant_wasm = wasmExports2["ts_tree_cursor_goto_descendant_wasm"];
    Module["_ts_tree_cursor_goto_parent_wasm"] = _ts_tree_cursor_goto_parent_wasm = wasmExports2["ts_tree_cursor_goto_parent_wasm"];
    Module["_ts_tree_cursor_current_node_type_id_wasm"] = _ts_tree_cursor_current_node_type_id_wasm = wasmExports2["ts_tree_cursor_current_node_type_id_wasm"];
    Module["_ts_tree_cursor_current_node_state_id_wasm"] = _ts_tree_cursor_current_node_state_id_wasm = wasmExports2["ts_tree_cursor_current_node_state_id_wasm"];
    Module["_ts_tree_cursor_current_node_is_named_wasm"] = _ts_tree_cursor_current_node_is_named_wasm = wasmExports2["ts_tree_cursor_current_node_is_named_wasm"];
    Module["_ts_tree_cursor_current_node_is_missing_wasm"] = _ts_tree_cursor_current_node_is_missing_wasm = wasmExports2["ts_tree_cursor_current_node_is_missing_wasm"];
    Module["_ts_tree_cursor_current_node_id_wasm"] = _ts_tree_cursor_current_node_id_wasm = wasmExports2["ts_tree_cursor_current_node_id_wasm"];
    Module["_ts_tree_cursor_start_position_wasm"] = _ts_tree_cursor_start_position_wasm = wasmExports2["ts_tree_cursor_start_position_wasm"];
    Module["_ts_tree_cursor_end_position_wasm"] = _ts_tree_cursor_end_position_wasm = wasmExports2["ts_tree_cursor_end_position_wasm"];
    Module["_ts_tree_cursor_start_index_wasm"] = _ts_tree_cursor_start_index_wasm = wasmExports2["ts_tree_cursor_start_index_wasm"];
    Module["_ts_tree_cursor_end_index_wasm"] = _ts_tree_cursor_end_index_wasm = wasmExports2["ts_tree_cursor_end_index_wasm"];
    Module["_ts_tree_cursor_current_field_id_wasm"] = _ts_tree_cursor_current_field_id_wasm = wasmExports2["ts_tree_cursor_current_field_id_wasm"];
    Module["_ts_tree_cursor_current_depth_wasm"] = _ts_tree_cursor_current_depth_wasm = wasmExports2["ts_tree_cursor_current_depth_wasm"];
    Module["_ts_tree_cursor_current_descendant_index_wasm"] = _ts_tree_cursor_current_descendant_index_wasm = wasmExports2["ts_tree_cursor_current_descendant_index_wasm"];
    Module["_ts_tree_cursor_current_node_wasm"] = _ts_tree_cursor_current_node_wasm = wasmExports2["ts_tree_cursor_current_node_wasm"];
    Module["_ts_node_symbol_wasm"] = _ts_node_symbol_wasm = wasmExports2["ts_node_symbol_wasm"];
    Module["_ts_node_field_name_for_child_wasm"] = _ts_node_field_name_for_child_wasm = wasmExports2["ts_node_field_name_for_child_wasm"];
    Module["_ts_node_field_name_for_named_child_wasm"] = _ts_node_field_name_for_named_child_wasm = wasmExports2["ts_node_field_name_for_named_child_wasm"];
    Module["_ts_node_children_by_field_id_wasm"] = _ts_node_children_by_field_id_wasm = wasmExports2["ts_node_children_by_field_id_wasm"];
    Module["_ts_node_first_child_for_byte_wasm"] = _ts_node_first_child_for_byte_wasm = wasmExports2["ts_node_first_child_for_byte_wasm"];
    Module["_ts_node_first_named_child_for_byte_wasm"] = _ts_node_first_named_child_for_byte_wasm = wasmExports2["ts_node_first_named_child_for_byte_wasm"];
    Module["_ts_node_grammar_symbol_wasm"] = _ts_node_grammar_symbol_wasm = wasmExports2["ts_node_grammar_symbol_wasm"];
    Module["_ts_node_child_count_wasm"] = _ts_node_child_count_wasm = wasmExports2["ts_node_child_count_wasm"];
    Module["_ts_node_named_child_count_wasm"] = _ts_node_named_child_count_wasm = wasmExports2["ts_node_named_child_count_wasm"];
    Module["_ts_node_child_wasm"] = _ts_node_child_wasm = wasmExports2["ts_node_child_wasm"];
    Module["_ts_node_named_child_wasm"] = _ts_node_named_child_wasm = wasmExports2["ts_node_named_child_wasm"];
    Module["_ts_node_child_by_field_id_wasm"] = _ts_node_child_by_field_id_wasm = wasmExports2["ts_node_child_by_field_id_wasm"];
    Module["_ts_node_next_sibling_wasm"] = _ts_node_next_sibling_wasm = wasmExports2["ts_node_next_sibling_wasm"];
    Module["_ts_node_prev_sibling_wasm"] = _ts_node_prev_sibling_wasm = wasmExports2["ts_node_prev_sibling_wasm"];
    Module["_ts_node_next_named_sibling_wasm"] = _ts_node_next_named_sibling_wasm = wasmExports2["ts_node_next_named_sibling_wasm"];
    Module["_ts_node_prev_named_sibling_wasm"] = _ts_node_prev_named_sibling_wasm = wasmExports2["ts_node_prev_named_sibling_wasm"];
    Module["_ts_node_descendant_count_wasm"] = _ts_node_descendant_count_wasm = wasmExports2["ts_node_descendant_count_wasm"];
    Module["_ts_node_parent_wasm"] = _ts_node_parent_wasm = wasmExports2["ts_node_parent_wasm"];
    Module["_ts_node_child_with_descendant_wasm"] = _ts_node_child_with_descendant_wasm = wasmExports2["ts_node_child_with_descendant_wasm"];
    Module["_ts_node_descendant_for_index_wasm"] = _ts_node_descendant_for_index_wasm = wasmExports2["ts_node_descendant_for_index_wasm"];
    Module["_ts_node_named_descendant_for_index_wasm"] = _ts_node_named_descendant_for_index_wasm = wasmExports2["ts_node_named_descendant_for_index_wasm"];
    Module["_ts_node_descendant_for_position_wasm"] = _ts_node_descendant_for_position_wasm = wasmExports2["ts_node_descendant_for_position_wasm"];
    Module["_ts_node_named_descendant_for_position_wasm"] = _ts_node_named_descendant_for_position_wasm = wasmExports2["ts_node_named_descendant_for_position_wasm"];
    Module["_ts_node_start_point_wasm"] = _ts_node_start_point_wasm = wasmExports2["ts_node_start_point_wasm"];
    Module["_ts_node_end_point_wasm"] = _ts_node_end_point_wasm = wasmExports2["ts_node_end_point_wasm"];
    Module["_ts_node_start_index_wasm"] = _ts_node_start_index_wasm = wasmExports2["ts_node_start_index_wasm"];
    Module["_ts_node_end_index_wasm"] = _ts_node_end_index_wasm = wasmExports2["ts_node_end_index_wasm"];
    Module["_ts_node_to_string_wasm"] = _ts_node_to_string_wasm = wasmExports2["ts_node_to_string_wasm"];
    Module["_ts_node_children_wasm"] = _ts_node_children_wasm = wasmExports2["ts_node_children_wasm"];
    Module["_ts_node_named_children_wasm"] = _ts_node_named_children_wasm = wasmExports2["ts_node_named_children_wasm"];
    Module["_ts_node_descendants_of_type_wasm"] = _ts_node_descendants_of_type_wasm = wasmExports2["ts_node_descendants_of_type_wasm"];
    Module["_ts_node_is_named_wasm"] = _ts_node_is_named_wasm = wasmExports2["ts_node_is_named_wasm"];
    Module["_ts_node_has_changes_wasm"] = _ts_node_has_changes_wasm = wasmExports2["ts_node_has_changes_wasm"];
    Module["_ts_node_has_error_wasm"] = _ts_node_has_error_wasm = wasmExports2["ts_node_has_error_wasm"];
    Module["_ts_node_is_error_wasm"] = _ts_node_is_error_wasm = wasmExports2["ts_node_is_error_wasm"];
    Module["_ts_node_is_missing_wasm"] = _ts_node_is_missing_wasm = wasmExports2["ts_node_is_missing_wasm"];
    Module["_ts_node_is_extra_wasm"] = _ts_node_is_extra_wasm = wasmExports2["ts_node_is_extra_wasm"];
    Module["_ts_node_parse_state_wasm"] = _ts_node_parse_state_wasm = wasmExports2["ts_node_parse_state_wasm"];
    Module["_ts_node_next_parse_state_wasm"] = _ts_node_next_parse_state_wasm = wasmExports2["ts_node_next_parse_state_wasm"];
    Module["_ts_query_matches_wasm"] = _ts_query_matches_wasm = wasmExports2["ts_query_matches_wasm"];
    Module["_ts_query_captures_wasm"] = _ts_query_captures_wasm = wasmExports2["ts_query_captures_wasm"];
    Module["_memset"] = _memset = wasmExports2["memset"];
    Module["_memcpy"] = _memcpy = wasmExports2["memcpy"];
    Module["_memmove"] = _memmove = wasmExports2["memmove"];
    Module["_iswalpha"] = _iswalpha = wasmExports2["iswalpha"];
    Module["_iswblank"] = _iswblank = wasmExports2["iswblank"];
    Module["_iswdigit"] = _iswdigit = wasmExports2["iswdigit"];
    Module["_iswlower"] = _iswlower = wasmExports2["iswlower"];
    Module["_iswupper"] = _iswupper = wasmExports2["iswupper"];
    Module["_iswxdigit"] = _iswxdigit = wasmExports2["iswxdigit"];
    Module["_memchr"] = _memchr = wasmExports2["memchr"];
    Module["_strlen"] = _strlen = wasmExports2["strlen"];
    Module["_strcmp"] = _strcmp = wasmExports2["strcmp"];
    Module["_strncat"] = _strncat = wasmExports2["strncat"];
    Module["_strncpy"] = _strncpy = wasmExports2["strncpy"];
    Module["_towlower"] = _towlower = wasmExports2["towlower"];
    Module["_towupper"] = _towupper = wasmExports2["towupper"];
    _setThrew = wasmExports2["setThrew"];
    __emscripten_stack_restore = wasmExports2["_emscripten_stack_restore"];
    __emscripten_stack_alloc = wasmExports2["_emscripten_stack_alloc"];
    _emscripten_stack_get_current = wasmExports2["emscripten_stack_get_current"];
    ___wasm_apply_data_relocs = wasmExports2["__wasm_apply_data_relocs"];
  }
  __name(assignWasmExports, "assignWasmExports");
  var wasmImports = {
    __heap_base: ___heap_base,
    __indirect_function_table: wasmTable,
    __memory_base: ___memory_base,
    __stack_high: ___stack_high,
    __stack_low: ___stack_low,
    __stack_pointer: ___stack_pointer,
    __table_base: ___table_base,
    _abort_js: __abort_js,
    emscripten_resize_heap: _emscripten_resize_heap,
    fd_close: _fd_close,
    fd_seek: _fd_seek,
    fd_write: _fd_write,
    memory: wasmMemory,
    tree_sitter_log_callback: _tree_sitter_log_callback,
    tree_sitter_parse_callback: _tree_sitter_parse_callback,
    tree_sitter_progress_callback: _tree_sitter_progress_callback,
    tree_sitter_query_progress_callback: _tree_sitter_query_progress_callback
  };
  function callMain(args2 = []) {
    var entryFunction = resolveGlobalSymbol("main").sym;
    if (!entryFunction)
      return;
    args2.unshift(thisProgram);
    var argc = args2.length;
    var argv = stackAlloc((argc + 1) * 4);
    var argv_ptr = argv;
    args2.forEach((arg) => {
      LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, stringToUTF8OnStack(arg));
      argv_ptr += 4;
    });
    LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, 0);
    try {
      var ret = entryFunction(argc, argv);
      exitJS(ret, true);
      return ret;
    } catch (e) {
      return handleException(e);
    }
  }
  __name(callMain, "callMain");
  function run(args2 = arguments_) {
    if (runDependencies > 0) {
      dependenciesFulfilled = run;
      return;
    }
    preRun();
    if (runDependencies > 0) {
      dependenciesFulfilled = run;
      return;
    }
    function doRun() {
      Module["calledRun"] = true;
      if (ABORT)
        return;
      initRuntime();
      preMain();
      readyPromiseResolve?.(Module);
      Module["onRuntimeInitialized"]?.();
      var noInitialRun = Module["noInitialRun"] || false;
      if (!noInitialRun)
        callMain(args2);
      postRun();
    }
    __name(doRun, "doRun");
    if (Module["setStatus"]) {
      Module["setStatus"]("Running...");
      setTimeout(() => {
        setTimeout(() => Module["setStatus"](""), 1);
        doRun();
      }, 1);
    } else {
      doRun();
    }
  }
  __name(run, "run");
  var wasmExports;
  wasmExports = await createWasm();
  run();
  if (runtimeInitialized) {
    moduleRtn = Module;
  } else {
    moduleRtn = new Promise((resolve, reject) => {
      readyPromiseResolve = resolve;
      readyPromiseReject = reject;
    });
  }
  return moduleRtn;
}
async function initializeBinding(moduleOptions) {
  return Module3 ??= await web_tree_sitter_default(moduleOptions);
}
function checkModule() {
  return !!Module3;
}
function parseAnyPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}`);
  }
  if (!isCaptureStep(steps[1])) {
    throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}"`);
  }
  const isPositive = operator === "eq?" || operator === "any-eq?";
  const matchAll = !operator.startsWith("any-");
  if (isCaptureStep(steps[2])) {
    const captureName1 = steps[1].name;
    const captureName2 = steps[2].name;
    textPredicates[index].push((captures) => {
      const nodes1 = [];
      const nodes2 = [];
      for (const c of captures) {
        if (c.name === captureName1)
          nodes1.push(c.node);
        if (c.name === captureName2)
          nodes2.push(c.node);
      }
      const compare = /* @__PURE__ */ __name((n1, n2, positive) => {
        return positive ? n1.text === n2.text : n1.text !== n2.text;
      }, "compare");
      return matchAll ? nodes1.every((n1) => nodes2.some((n2) => compare(n1, n2, isPositive))) : nodes1.some((n1) => nodes2.some((n2) => compare(n1, n2, isPositive)));
    });
  } else {
    const captureName = steps[1].name;
    const stringValue = steps[2].value;
    const matches = /* @__PURE__ */ __name((n) => n.text === stringValue, "matches");
    const doesNotMatch = /* @__PURE__ */ __name((n) => n.text !== stringValue, "doesNotMatch");
    textPredicates[index].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName)
          nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
function parseMatchPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}.`);
  }
  if (steps[1].type !== "capture") {
    throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`);
  }
  if (steps[2].type !== "string") {
    throw new Error(`Second argument of \`#${operator}\` predicate must be a string. Got @${steps[2].name}.`);
  }
  const isPositive = operator === "match?" || operator === "any-match?";
  const matchAll = !operator.startsWith("any-");
  const captureName = steps[1].name;
  const regex = new RegExp(steps[2].value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName)
        nodes.push(c.node.text);
    }
    const test = /* @__PURE__ */ __name((text, positive) => {
      return positive ? regex.test(text) : !regex.test(text);
    }, "test");
    if (nodes.length === 0)
      return !isPositive;
    return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
  });
}
function parseAnyOfPredicate(steps, index, operator, textPredicates) {
  if (steps.length < 2) {
    throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected at least 1. Got ${steps.length - 1}.`);
  }
  if (steps[1].type !== "capture") {
    throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`);
  }
  const isPositive = operator === "any-of?";
  const captureName = steps[1].name;
  const stringSteps = steps.slice(2);
  if (!stringSteps.every(isStringStep)) {
    throw new Error(`Arguments to \`#${operator}\` predicate must be strings.".`);
  }
  const values = stringSteps.map((s) => s.value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName)
        nodes.push(c.node.text);
    }
    if (nodes.length === 0)
      return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
function parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#${operator}\` predicate must be strings.".`);
  }
  const properties = operator === "is?" ? assertedProperties : refutedProperties;
  if (!properties[index])
    properties[index] = {};
  properties[index][steps[1].value] = steps[2]?.value ?? null;
}
function parseSetDirective(steps, index, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index])
    setProperties[index] = {};
  setProperties[index][steps[1].value] = steps[2]?.value ?? null;
}
function parsePattern(index, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
  if (stepType === PREDICATE_STEP_TYPE_CAPTURE) {
    const name2 = captureNames[stepValueId];
    steps.push({ type: "capture", name: name2 });
  } else if (stepType === PREDICATE_STEP_TYPE_STRING) {
    steps.push({ type: "string", value: stringValues[stepValueId] });
  } else if (steps.length > 0) {
    if (steps[0].type !== "string") {
      throw new Error("Predicates must begin with a literal value");
    }
    const operator = steps[0].value;
    switch (operator) {
      case "any-not-eq?":
      case "not-eq?":
      case "any-eq?":
      case "eq?":
        parseAnyPredicate(steps, index, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index, setProperties);
        break;
      default:
        predicates[index].push({ operator, operands: steps.slice(1) });
    }
    steps.length = 0;
  }
}
var __defProp2, __name = (target, value) => __defProp2(target, "name", { value, configurable: true }), Edit, SIZE_OF_SHORT = 2, SIZE_OF_INT = 4, SIZE_OF_CURSOR, SIZE_OF_NODE, SIZE_OF_POINT, SIZE_OF_RANGE, ZERO_POINT, INTERNAL, C, LookaheadIterator, Tree, TreeCursor, Node, LANGUAGE_FUNCTION_REGEX, Language, web_tree_sitter_default, Module3 = null, TRANSFER_BUFFER, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser, PREDICATE_STEP_TYPE_CAPTURE = 1, PREDICATE_STEP_TYPE_STRING = 2, QUERY_WORD_REGEX, CaptureQuantifier, isCaptureStep, isStringStep, QueryErrorKind, QueryError, Query;
var init_web_tree_sitter = __esm(() => {
  __defProp2 = Object.defineProperty;
  Edit = class {
    static {
      __name(this, "Edit");
    }
    startPosition;
    oldEndPosition;
    newEndPosition;
    startIndex;
    oldEndIndex;
    newEndIndex;
    constructor({
      startIndex,
      oldEndIndex,
      newEndIndex,
      startPosition,
      oldEndPosition,
      newEndPosition
    }) {
      this.startIndex = startIndex >>> 0;
      this.oldEndIndex = oldEndIndex >>> 0;
      this.newEndIndex = newEndIndex >>> 0;
      this.startPosition = startPosition;
      this.oldEndPosition = oldEndPosition;
      this.newEndPosition = newEndPosition;
    }
    editPoint(point, index) {
      let newIndex = index;
      const newPoint = { ...point };
      if (index >= this.oldEndIndex) {
        newIndex = this.newEndIndex + (index - this.oldEndIndex);
        const originalRow = point.row;
        newPoint.row = this.newEndPosition.row + (point.row - this.oldEndPosition.row);
        newPoint.column = originalRow === this.oldEndPosition.row ? this.newEndPosition.column + (point.column - this.oldEndPosition.column) : point.column;
      } else if (index > this.startIndex) {
        newIndex = this.newEndIndex;
        newPoint.row = this.newEndPosition.row;
        newPoint.column = this.newEndPosition.column;
      }
      return { point: newPoint, index: newIndex };
    }
    editRange(range) {
      const newRange = {
        startIndex: range.startIndex,
        startPosition: { ...range.startPosition },
        endIndex: range.endIndex,
        endPosition: { ...range.endPosition }
      };
      if (range.endIndex >= this.oldEndIndex) {
        if (range.endIndex !== Number.MAX_SAFE_INTEGER) {
          newRange.endIndex = this.newEndIndex + (range.endIndex - this.oldEndIndex);
          newRange.endPosition = {
            row: this.newEndPosition.row + (range.endPosition.row - this.oldEndPosition.row),
            column: range.endPosition.row === this.oldEndPosition.row ? this.newEndPosition.column + (range.endPosition.column - this.oldEndPosition.column) : range.endPosition.column
          };
          if (newRange.endIndex < this.newEndIndex) {
            newRange.endIndex = Number.MAX_SAFE_INTEGER;
            newRange.endPosition = { row: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
          }
        }
      } else if (range.endIndex > this.startIndex) {
        newRange.endIndex = this.startIndex;
        newRange.endPosition = { ...this.startPosition };
      }
      if (range.startIndex >= this.oldEndIndex) {
        newRange.startIndex = this.newEndIndex + (range.startIndex - this.oldEndIndex);
        newRange.startPosition = {
          row: this.newEndPosition.row + (range.startPosition.row - this.oldEndPosition.row),
          column: range.startPosition.row === this.oldEndPosition.row ? this.newEndPosition.column + (range.startPosition.column - this.oldEndPosition.column) : range.startPosition.column
        };
        if (newRange.startIndex < this.newEndIndex) {
          newRange.startIndex = Number.MAX_SAFE_INTEGER;
          newRange.startPosition = { row: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
        }
      } else if (range.startIndex > this.startIndex) {
        newRange.startIndex = this.startIndex;
        newRange.startPosition = { ...this.startPosition };
      }
      return newRange;
    }
  };
  SIZE_OF_CURSOR = 4 * SIZE_OF_INT;
  SIZE_OF_NODE = 5 * SIZE_OF_INT;
  SIZE_OF_POINT = 2 * SIZE_OF_INT;
  SIZE_OF_RANGE = 2 * SIZE_OF_INT + 2 * SIZE_OF_POINT;
  ZERO_POINT = { row: 0, column: 0 };
  INTERNAL = /* @__PURE__ */ Symbol("INTERNAL");
  __name(assertInternal, "assertInternal");
  __name(isPoint, "isPoint");
  __name(setModule, "setModule");
  LookaheadIterator = class {
    static {
      __name(this, "LookaheadIterator");
    }
    [0] = 0;
    language;
    constructor(internal, address, language) {
      assertInternal(internal);
      this[0] = address;
      this.language = language;
    }
    get currentTypeId() {
      return C._ts_lookahead_iterator_current_symbol(this[0]);
    }
    get currentType() {
      return this.language.types[this.currentTypeId] || "ERROR";
    }
    delete() {
      C._ts_lookahead_iterator_delete(this[0]);
      this[0] = 0;
    }
    reset(language, stateId) {
      if (C._ts_lookahead_iterator_reset(this[0], language[0], stateId)) {
        this.language = language;
        return true;
      }
      return false;
    }
    resetState(stateId) {
      return Boolean(C._ts_lookahead_iterator_reset_state(this[0], stateId));
    }
    [Symbol.iterator]() {
      return {
        next: /* @__PURE__ */ __name(() => {
          if (C._ts_lookahead_iterator_next(this[0])) {
            return { done: false, value: this.currentType };
          }
          return { done: true, value: "" };
        }, "next")
      };
    }
  };
  __name(getText, "getText");
  Tree = class _Tree {
    static {
      __name(this, "Tree");
    }
    [0] = 0;
    textCallback;
    language;
    constructor(internal, address, language, textCallback) {
      assertInternal(internal);
      this[0] = address;
      this.language = language;
      this.textCallback = textCallback;
    }
    copy() {
      const address = C._ts_tree_copy(this[0]);
      return new _Tree(INTERNAL, address, this.language, this.textCallback);
    }
    delete() {
      C._ts_tree_delete(this[0]);
      this[0] = 0;
    }
    get rootNode() {
      C._ts_tree_root_node_wasm(this[0]);
      return unmarshalNode(this);
    }
    rootNodeWithOffset(offsetBytes, offsetExtent) {
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      C.setValue(address, offsetBytes, "i32");
      marshalPoint(address + SIZE_OF_INT, offsetExtent);
      C._ts_tree_root_node_with_offset_wasm(this[0]);
      return unmarshalNode(this);
    }
    edit(edit) {
      marshalEdit(edit);
      C._ts_tree_edit_wasm(this[0]);
    }
    walk() {
      return this.rootNode.walk();
    }
    getChangedRanges(other) {
      if (!(other instanceof _Tree)) {
        throw new TypeError("Argument must be a Tree");
      }
      C._ts_tree_get_changed_ranges_wasm(this[0], other[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = unmarshalRange(address);
          address += SIZE_OF_RANGE;
        }
        C._free(buffer);
      }
      return result;
    }
    getIncludedRanges() {
      C._ts_tree_included_ranges_wasm(this[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = unmarshalRange(address);
          address += SIZE_OF_RANGE;
        }
        C._free(buffer);
      }
      return result;
    }
  };
  TreeCursor = class _TreeCursor {
    static {
      __name(this, "TreeCursor");
    }
    [0] = 0;
    [1] = 0;
    [2] = 0;
    [3] = 0;
    tree;
    constructor(internal, tree) {
      assertInternal(internal);
      this.tree = tree;
      unmarshalTreeCursor(this);
    }
    copy() {
      const copy = new _TreeCursor(INTERNAL, this.tree);
      C._ts_tree_cursor_copy_wasm(this.tree[0]);
      unmarshalTreeCursor(copy);
      return copy;
    }
    delete() {
      marshalTreeCursor(this);
      C._ts_tree_cursor_delete_wasm(this.tree[0]);
      this[0] = this[1] = this[2] = 0;
    }
    get currentNode() {
      marshalTreeCursor(this);
      C._ts_tree_cursor_current_node_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get currentFieldId() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_field_id_wasm(this.tree[0]);
    }
    get currentFieldName() {
      return this.tree.language.fields[this.currentFieldId];
    }
    get currentDepth() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_depth_wasm(this.tree[0]);
    }
    get currentDescendantIndex() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_descendant_index_wasm(this.tree[0]);
    }
    get nodeType() {
      return this.tree.language.types[this.nodeTypeId] || "ERROR";
    }
    get nodeTypeId() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_node_type_id_wasm(this.tree[0]);
    }
    get nodeStateId() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_node_state_id_wasm(this.tree[0]);
    }
    get nodeId() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_node_id_wasm(this.tree[0]);
    }
    get nodeIsNamed() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_node_is_named_wasm(this.tree[0]) === 1;
    }
    get nodeIsMissing() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_current_node_is_missing_wasm(this.tree[0]) === 1;
    }
    get nodeText() {
      marshalTreeCursor(this);
      const startIndex = C._ts_tree_cursor_start_index_wasm(this.tree[0]);
      const endIndex = C._ts_tree_cursor_end_index_wasm(this.tree[0]);
      C._ts_tree_cursor_start_position_wasm(this.tree[0]);
      const startPosition = unmarshalPoint(TRANSFER_BUFFER);
      return getText(this.tree, startIndex, endIndex, startPosition);
    }
    get startPosition() {
      marshalTreeCursor(this);
      C._ts_tree_cursor_start_position_wasm(this.tree[0]);
      return unmarshalPoint(TRANSFER_BUFFER);
    }
    get endPosition() {
      marshalTreeCursor(this);
      C._ts_tree_cursor_end_position_wasm(this.tree[0]);
      return unmarshalPoint(TRANSFER_BUFFER);
    }
    get startIndex() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_start_index_wasm(this.tree[0]);
    }
    get endIndex() {
      marshalTreeCursor(this);
      return C._ts_tree_cursor_end_index_wasm(this.tree[0]);
    }
    gotoFirstChild() {
      marshalTreeCursor(this);
      const result = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoLastChild() {
      marshalTreeCursor(this);
      const result = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoParent() {
      marshalTreeCursor(this);
      const result = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoNextSibling() {
      marshalTreeCursor(this);
      const result = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoPreviousSibling() {
      marshalTreeCursor(this);
      const result = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoDescendant(goalDescendantIndex) {
      marshalTreeCursor(this);
      C._ts_tree_cursor_goto_descendant_wasm(this.tree[0], goalDescendantIndex);
      unmarshalTreeCursor(this);
    }
    gotoFirstChildForIndex(goalIndex) {
      marshalTreeCursor(this);
      C.setValue(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalIndex, "i32");
      const result = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    gotoFirstChildForPosition(goalPosition) {
      marshalTreeCursor(this);
      marshalPoint(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalPosition);
      const result = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
      return result === 1;
    }
    reset(node) {
      marshalNode(node);
      marshalTreeCursor(this, TRANSFER_BUFFER + SIZE_OF_NODE);
      C._ts_tree_cursor_reset_wasm(this.tree[0]);
      unmarshalTreeCursor(this);
    }
    resetTo(cursor) {
      marshalTreeCursor(this, TRANSFER_BUFFER);
      marshalTreeCursor(cursor, TRANSFER_BUFFER + SIZE_OF_CURSOR);
      C._ts_tree_cursor_reset_to_wasm(this.tree[0], cursor.tree[0]);
      unmarshalTreeCursor(this);
    }
  };
  Node = class {
    static {
      __name(this, "Node");
    }
    [0] = 0;
    _children;
    _namedChildren;
    constructor(internal, {
      id,
      tree,
      startIndex,
      startPosition,
      other
    }) {
      assertInternal(internal);
      this[0] = other;
      this.id = id;
      this.tree = tree;
      this.startIndex = startIndex;
      this.startPosition = startPosition;
    }
    id;
    startIndex;
    startPosition;
    tree;
    get typeId() {
      marshalNode(this);
      return C._ts_node_symbol_wasm(this.tree[0]);
    }
    get grammarId() {
      marshalNode(this);
      return C._ts_node_grammar_symbol_wasm(this.tree[0]);
    }
    get type() {
      return this.tree.language.types[this.typeId] || "ERROR";
    }
    get grammarType() {
      return this.tree.language.types[this.grammarId] || "ERROR";
    }
    get isNamed() {
      marshalNode(this);
      return C._ts_node_is_named_wasm(this.tree[0]) === 1;
    }
    get isExtra() {
      marshalNode(this);
      return C._ts_node_is_extra_wasm(this.tree[0]) === 1;
    }
    get isError() {
      marshalNode(this);
      return C._ts_node_is_error_wasm(this.tree[0]) === 1;
    }
    get isMissing() {
      marshalNode(this);
      return C._ts_node_is_missing_wasm(this.tree[0]) === 1;
    }
    get hasChanges() {
      marshalNode(this);
      return C._ts_node_has_changes_wasm(this.tree[0]) === 1;
    }
    get hasError() {
      marshalNode(this);
      return C._ts_node_has_error_wasm(this.tree[0]) === 1;
    }
    get endIndex() {
      marshalNode(this);
      return C._ts_node_end_index_wasm(this.tree[0]);
    }
    get endPosition() {
      marshalNode(this);
      C._ts_node_end_point_wasm(this.tree[0]);
      return unmarshalPoint(TRANSFER_BUFFER);
    }
    get text() {
      return getText(this.tree, this.startIndex, this.endIndex, this.startPosition);
    }
    get parseState() {
      marshalNode(this);
      return C._ts_node_parse_state_wasm(this.tree[0]);
    }
    get nextParseState() {
      marshalNode(this);
      return C._ts_node_next_parse_state_wasm(this.tree[0]);
    }
    equals(other) {
      return this.tree === other.tree && this.id === other.id;
    }
    child(index) {
      marshalNode(this);
      C._ts_node_child_wasm(this.tree[0], index);
      return unmarshalNode(this.tree);
    }
    namedChild(index) {
      marshalNode(this);
      C._ts_node_named_child_wasm(this.tree[0], index);
      return unmarshalNode(this.tree);
    }
    childForFieldId(fieldId) {
      marshalNode(this);
      C._ts_node_child_by_field_id_wasm(this.tree[0], fieldId);
      return unmarshalNode(this.tree);
    }
    childForFieldName(fieldName) {
      const fieldId = this.tree.language.fields.indexOf(fieldName);
      if (fieldId !== -1)
        return this.childForFieldId(fieldId);
      return null;
    }
    fieldNameForChild(index) {
      marshalNode(this);
      const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index);
      if (!address)
        return null;
      return C.AsciiToString(address);
    }
    fieldNameForNamedChild(index) {
      marshalNode(this);
      const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index);
      if (!address)
        return null;
      return C.AsciiToString(address);
    }
    childrenForFieldName(fieldName) {
      const fieldId = this.tree.language.fields.indexOf(fieldName);
      if (fieldId !== -1 && fieldId !== 0)
        return this.childrenForFieldId(fieldId);
      return [];
    }
    childrenForFieldId(fieldId) {
      marshalNode(this);
      C._ts_node_children_by_field_id_wasm(this.tree[0], fieldId);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
        C._free(buffer);
      }
      return result;
    }
    firstChildForIndex(index) {
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      C.setValue(address, index, "i32");
      C._ts_node_first_child_for_byte_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    firstNamedChildForIndex(index) {
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      C.setValue(address, index, "i32");
      C._ts_node_first_named_child_for_byte_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get childCount() {
      marshalNode(this);
      return C._ts_node_child_count_wasm(this.tree[0]);
    }
    get namedChildCount() {
      marshalNode(this);
      return C._ts_node_named_child_count_wasm(this.tree[0]);
    }
    get firstChild() {
      return this.child(0);
    }
    get firstNamedChild() {
      return this.namedChild(0);
    }
    get lastChild() {
      return this.child(this.childCount - 1);
    }
    get lastNamedChild() {
      return this.namedChild(this.namedChildCount - 1);
    }
    get children() {
      if (!this._children) {
        marshalNode(this);
        C._ts_node_children_wasm(this.tree[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        this._children = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0;i2 < count; i2++) {
            this._children[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
          C._free(buffer);
        }
      }
      return this._children;
    }
    get namedChildren() {
      if (!this._namedChildren) {
        marshalNode(this);
        C._ts_node_named_children_wasm(this.tree[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        this._namedChildren = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0;i2 < count; i2++) {
            this._namedChildren[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
          C._free(buffer);
        }
      }
      return this._namedChildren;
    }
    descendantsOfType(types, startPosition = ZERO_POINT, endPosition = ZERO_POINT) {
      if (!Array.isArray(types))
        types = [types];
      const symbols = [];
      const typesBySymbol = this.tree.language.types;
      for (const node_type of types) {
        if (node_type == "ERROR") {
          symbols.push(65535);
        }
      }
      for (let i2 = 0, n = typesBySymbol.length;i2 < n; i2++) {
        if (types.includes(typesBySymbol[i2])) {
          symbols.push(i2);
        }
      }
      const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
      for (let i2 = 0, n = symbols.length;i2 < n; i2++) {
        C.setValue(symbolsAddress + i2 * SIZE_OF_INT, symbols[i2], "i32");
      }
      marshalNode(this);
      C._ts_node_descendants_of_type_wasm(this.tree[0], symbolsAddress, symbols.length, startPosition.row, startPosition.column, endPosition.row, endPosition.column);
      const descendantCount = C.getValue(TRANSFER_BUFFER, "i32");
      const descendantAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(descendantCount);
      if (descendantCount > 0) {
        let address = descendantAddress;
        for (let i2 = 0;i2 < descendantCount; i2++) {
          result[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
      }
      C._free(descendantAddress);
      C._free(symbolsAddress);
      return result;
    }
    get nextSibling() {
      marshalNode(this);
      C._ts_node_next_sibling_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get previousSibling() {
      marshalNode(this);
      C._ts_node_prev_sibling_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get nextNamedSibling() {
      marshalNode(this);
      C._ts_node_next_named_sibling_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get previousNamedSibling() {
      marshalNode(this);
      C._ts_node_prev_named_sibling_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    get descendantCount() {
      marshalNode(this);
      return C._ts_node_descendant_count_wasm(this.tree[0]);
    }
    get parent() {
      marshalNode(this);
      C._ts_node_parent_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    childWithDescendant(descendant) {
      marshalNode(this);
      marshalNode(descendant, 1);
      C._ts_node_child_with_descendant_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    descendantForIndex(start2, end = start2) {
      if (typeof start2 !== "number" || typeof end !== "number") {
        throw new Error("Arguments must be numbers");
      }
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      C.setValue(address, start2, "i32");
      C.setValue(address + SIZE_OF_INT, end, "i32");
      C._ts_node_descendant_for_index_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    namedDescendantForIndex(start2, end = start2) {
      if (typeof start2 !== "number" || typeof end !== "number") {
        throw new Error("Arguments must be numbers");
      }
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      C.setValue(address, start2, "i32");
      C.setValue(address + SIZE_OF_INT, end, "i32");
      C._ts_node_named_descendant_for_index_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    descendantForPosition(start2, end = start2) {
      if (!isPoint(start2) || !isPoint(end)) {
        throw new Error("Arguments must be {row, column} objects");
      }
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      marshalPoint(address, start2);
      marshalPoint(address + SIZE_OF_POINT, end);
      C._ts_node_descendant_for_position_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    namedDescendantForPosition(start2, end = start2) {
      if (!isPoint(start2) || !isPoint(end)) {
        throw new Error("Arguments must be {row, column} objects");
      }
      marshalNode(this);
      const address = TRANSFER_BUFFER + SIZE_OF_NODE;
      marshalPoint(address, start2);
      marshalPoint(address + SIZE_OF_POINT, end);
      C._ts_node_named_descendant_for_position_wasm(this.tree[0]);
      return unmarshalNode(this.tree);
    }
    walk() {
      marshalNode(this);
      C._ts_tree_cursor_new_wasm(this.tree[0]);
      return new TreeCursor(INTERNAL, this.tree);
    }
    edit(edit) {
      if (this.startIndex >= edit.oldEndIndex) {
        this.startIndex = edit.newEndIndex + (this.startIndex - edit.oldEndIndex);
        let subbedPointRow;
        let subbedPointColumn;
        if (this.startPosition.row > edit.oldEndPosition.row) {
          subbedPointRow = this.startPosition.row - edit.oldEndPosition.row;
          subbedPointColumn = this.startPosition.column;
        } else {
          subbedPointRow = 0;
          subbedPointColumn = this.startPosition.column;
          if (this.startPosition.column >= edit.oldEndPosition.column) {
            subbedPointColumn = this.startPosition.column - edit.oldEndPosition.column;
          }
        }
        if (subbedPointRow > 0) {
          this.startPosition.row += subbedPointRow;
          this.startPosition.column = subbedPointColumn;
        } else {
          this.startPosition.column += subbedPointColumn;
        }
      } else if (this.startIndex > edit.startIndex) {
        this.startIndex = edit.newEndIndex;
        this.startPosition.row = edit.newEndPosition.row;
        this.startPosition.column = edit.newEndPosition.column;
      }
    }
    toString() {
      marshalNode(this);
      const address = C._ts_node_to_string_wasm(this.tree[0]);
      const result = C.AsciiToString(address);
      C._free(address);
      return result;
    }
  };
  __name(unmarshalCaptures, "unmarshalCaptures");
  __name(marshalNode, "marshalNode");
  __name(unmarshalNode, "unmarshalNode");
  __name(marshalTreeCursor, "marshalTreeCursor");
  __name(unmarshalTreeCursor, "unmarshalTreeCursor");
  __name(marshalPoint, "marshalPoint");
  __name(unmarshalPoint, "unmarshalPoint");
  __name(marshalRange, "marshalRange");
  __name(unmarshalRange, "unmarshalRange");
  __name(marshalEdit, "marshalEdit");
  __name(unmarshalLanguageMetadata, "unmarshalLanguageMetadata");
  LANGUAGE_FUNCTION_REGEX = /^tree_sitter_\w+$/;
  Language = class _Language {
    static {
      __name(this, "Language");
    }
    [0] = 0;
    types;
    fields;
    constructor(internal, address) {
      assertInternal(internal);
      this[0] = address;
      this.types = new Array(C._ts_language_symbol_count(this[0]));
      for (let i2 = 0, n = this.types.length;i2 < n; i2++) {
        if (C._ts_language_symbol_type(this[0], i2) < 2) {
          this.types[i2] = C.UTF8ToString(C._ts_language_symbol_name(this[0], i2));
        }
      }
      this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
      for (let i2 = 0, n = this.fields.length;i2 < n; i2++) {
        const fieldName = C._ts_language_field_name_for_id(this[0], i2);
        if (fieldName !== 0) {
          this.fields[i2] = C.UTF8ToString(fieldName);
        } else {
          this.fields[i2] = null;
        }
      }
    }
    get name() {
      const ptr = C._ts_language_name(this[0]);
      if (ptr === 0)
        return null;
      return C.UTF8ToString(ptr);
    }
    get abiVersion() {
      return C._ts_language_abi_version(this[0]);
    }
    get metadata() {
      C._ts_language_metadata_wasm(this[0]);
      const length = C.getValue(TRANSFER_BUFFER, "i32");
      if (length === 0)
        return null;
      return unmarshalLanguageMetadata(TRANSFER_BUFFER + SIZE_OF_INT);
    }
    get fieldCount() {
      return this.fields.length - 1;
    }
    get stateCount() {
      return C._ts_language_state_count(this[0]);
    }
    fieldIdForName(fieldName) {
      const result = this.fields.indexOf(fieldName);
      return result !== -1 ? result : null;
    }
    fieldNameForId(fieldId) {
      return this.fields[fieldId] ?? null;
    }
    idForNodeType(type, named) {
      const typeLength = C.lengthBytesUTF8(type);
      const typeAddress = C._malloc(typeLength + 1);
      C.stringToUTF8(type, typeAddress, typeLength + 1);
      const result = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named ? 1 : 0);
      C._free(typeAddress);
      return result || null;
    }
    get nodeTypeCount() {
      return C._ts_language_symbol_count(this[0]);
    }
    nodeTypeForId(typeId) {
      const name2 = C._ts_language_symbol_name(this[0], typeId);
      return name2 ? C.UTF8ToString(name2) : null;
    }
    nodeTypeIsNamed(typeId) {
      return C._ts_language_type_is_named_wasm(this[0], typeId) ? true : false;
    }
    nodeTypeIsVisible(typeId) {
      return C._ts_language_type_is_visible_wasm(this[0], typeId) ? true : false;
    }
    get supertypes() {
      C._ts_language_supertypes_wasm(this[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = C.getValue(address, "i16");
          address += SIZE_OF_SHORT;
        }
      }
      return result;
    }
    subtypes(supertype) {
      C._ts_language_subtypes_wasm(this[0], supertype);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = C.getValue(address, "i16");
          address += SIZE_OF_SHORT;
        }
      }
      return result;
    }
    nextState(stateId, typeId) {
      return C._ts_language_next_state(this[0], stateId, typeId);
    }
    lookaheadIterator(stateId) {
      const address = C._ts_lookahead_iterator_new(this[0], stateId);
      if (address)
        return new LookaheadIterator(INTERNAL, address, this);
      return null;
    }
    static async load(input) {
      let binary2;
      if (input instanceof Uint8Array) {
        binary2 = input;
      } else if (globalThis.process?.versions.node) {
        const fs2 = await import("fs/promises");
        binary2 = await fs2.readFile(input);
      } else {
        const response = await fetch(input);
        if (!response.ok) {
          const body2 = await response.text();
          throw new Error(`Language.load failed with status ${response.status}.

${body2}`);
        }
        const retryResp = response.clone();
        try {
          binary2 = await WebAssembly.compileStreaming(response);
        } catch (reason) {
          console.error("wasm streaming compile failed:", reason);
          console.error("falling back to ArrayBuffer instantiation");
          binary2 = new Uint8Array(await retryResp.arrayBuffer());
        }
      }
      const mod = await C.loadWebAssemblyModule(binary2, { loadAsync: true });
      const symbolNames = Object.keys(mod);
      const functionName = symbolNames.find((key) => LANGUAGE_FUNCTION_REGEX.test(key) && !key.includes("external_scanner_"));
      if (!functionName) {
        console.log(`Couldn't find language function in Wasm file. Symbols:
${JSON.stringify(symbolNames, null, 2)}`);
        throw new Error("Language.load failed: no language function found in Wasm file");
      }
      const languageAddress = mod[functionName]();
      return new _Language(INTERNAL, languageAddress);
    }
  };
  __name(Module2, "Module");
  web_tree_sitter_default = Module2;
  __name(initializeBinding, "initializeBinding");
  __name(checkModule, "checkModule");
  Parser = class {
    static {
      __name(this, "Parser");
    }
    [0] = 0;
    [1] = 0;
    logCallback = null;
    language = null;
    static async init(moduleOptions) {
      setModule(await initializeBinding(moduleOptions));
      TRANSFER_BUFFER = C._ts_init();
      LANGUAGE_VERSION = C.getValue(TRANSFER_BUFFER, "i32");
      MIN_COMPATIBLE_VERSION = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    }
    constructor() {
      this.initialize();
    }
    initialize() {
      if (!checkModule()) {
        throw new Error("cannot construct a Parser before calling `init()`");
      }
      C._ts_parser_new_wasm();
      this[0] = C.getValue(TRANSFER_BUFFER, "i32");
      this[1] = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    }
    delete() {
      C._ts_parser_delete(this[0]);
      C._free(this[1]);
      this[0] = 0;
      this[1] = 0;
    }
    setLanguage(language) {
      let address;
      if (!language) {
        address = 0;
        this.language = null;
      } else if (language.constructor === Language) {
        address = language[0];
        const version = C._ts_language_abi_version(address);
        if (version < MIN_COMPATIBLE_VERSION || LANGUAGE_VERSION < version) {
          throw new Error(`Incompatible language version ${version}. Compatibility range ${MIN_COMPATIBLE_VERSION} through ${LANGUAGE_VERSION}.`);
        }
        this.language = language;
      } else {
        throw new Error("Argument must be a Language");
      }
      C._ts_parser_set_language(this[0], address);
      return this;
    }
    parse(callback, oldTree, options) {
      if (typeof callback === "string") {
        C.currentParseCallback = (index) => callback.slice(index);
      } else if (typeof callback === "function") {
        C.currentParseCallback = callback;
      } else {
        throw new Error("Argument must be a string or a function");
      }
      if (options?.progressCallback) {
        C.currentProgressCallback = options.progressCallback;
      } else {
        C.currentProgressCallback = null;
      }
      if (this.logCallback) {
        C.currentLogCallback = this.logCallback;
        C._ts_parser_enable_logger_wasm(this[0], 1);
      } else {
        C.currentLogCallback = null;
        C._ts_parser_enable_logger_wasm(this[0], 0);
      }
      let rangeCount = 0;
      let rangeAddress = 0;
      if (options?.includedRanges) {
        rangeCount = options.includedRanges.length;
        rangeAddress = C._calloc(rangeCount, SIZE_OF_RANGE);
        let address = rangeAddress;
        for (let i2 = 0;i2 < rangeCount; i2++) {
          marshalRange(address, options.includedRanges[i2]);
          address += SIZE_OF_RANGE;
        }
      }
      const treeAddress = C._ts_parser_parse_wasm(this[0], this[1], oldTree ? oldTree[0] : 0, rangeAddress, rangeCount);
      if (!treeAddress) {
        C.currentParseCallback = null;
        C.currentLogCallback = null;
        C.currentProgressCallback = null;
        return null;
      }
      if (!this.language) {
        throw new Error("Parser must have a language to parse");
      }
      const result = new Tree(INTERNAL, treeAddress, this.language, C.currentParseCallback);
      C.currentParseCallback = null;
      C.currentLogCallback = null;
      C.currentProgressCallback = null;
      return result;
    }
    reset() {
      C._ts_parser_reset(this[0]);
    }
    getIncludedRanges() {
      C._ts_parser_included_ranges_wasm(this[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const result = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0;i2 < count; i2++) {
          result[i2] = unmarshalRange(address);
          address += SIZE_OF_RANGE;
        }
        C._free(buffer);
      }
      return result;
    }
    setLogger(callback) {
      if (!callback) {
        this.logCallback = null;
      } else if (typeof callback !== "function") {
        throw new Error("Logger callback must be a function");
      } else {
        this.logCallback = callback;
      }
      return this;
    }
    getLogger() {
      return this.logCallback;
    }
  };
  QUERY_WORD_REGEX = /[\w-]+/g;
  CaptureQuantifier = {
    Zero: 0,
    ZeroOrOne: 1,
    ZeroOrMore: 2,
    One: 3,
    OneOrMore: 4
  };
  isCaptureStep = /* @__PURE__ */ __name((step) => step.type === "capture", "isCaptureStep");
  isStringStep = /* @__PURE__ */ __name((step) => step.type === "string", "isStringStep");
  QueryErrorKind = {
    Syntax: 1,
    NodeName: 2,
    FieldName: 3,
    CaptureName: 4,
    PatternStructure: 5
  };
  QueryError = class _QueryError extends Error {
    constructor(kind, info2, index, length) {
      super(_QueryError.formatMessage(kind, info2));
      this.kind = kind;
      this.info = info2;
      this.index = index;
      this.length = length;
      this.name = "QueryError";
    }
    static {
      __name(this, "QueryError");
    }
    static formatMessage(kind, info2) {
      switch (kind) {
        case QueryErrorKind.NodeName:
          return `Bad node name '${info2.word}'`;
        case QueryErrorKind.FieldName:
          return `Bad field name '${info2.word}'`;
        case QueryErrorKind.CaptureName:
          return `Bad capture name @${info2.word}`;
        case QueryErrorKind.PatternStructure:
          return `Bad pattern structure at offset ${info2.suffix}`;
        case QueryErrorKind.Syntax:
          return `Bad syntax at offset ${info2.suffix}`;
      }
    }
  };
  __name(parseAnyPredicate, "parseAnyPredicate");
  __name(parseMatchPredicate, "parseMatchPredicate");
  __name(parseAnyOfPredicate, "parseAnyOfPredicate");
  __name(parseIsPredicate, "parseIsPredicate");
  __name(parseSetDirective, "parseSetDirective");
  __name(parsePattern, "parsePattern");
  Query = class {
    static {
      __name(this, "Query");
    }
    [0] = 0;
    exceededMatchLimit;
    textPredicates;
    captureNames;
    captureQuantifiers;
    predicates;
    setProperties;
    assertedProperties;
    refutedProperties;
    matchLimit;
    constructor(language, source) {
      const sourceLength = C.lengthBytesUTF8(source);
      const sourceAddress = C._malloc(sourceLength + 1);
      C.stringToUTF8(source, sourceAddress, sourceLength + 1);
      const address = C._ts_query_new(language[0], sourceAddress, sourceLength, TRANSFER_BUFFER, TRANSFER_BUFFER + SIZE_OF_INT);
      if (!address) {
        const errorId = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const errorByte = C.getValue(TRANSFER_BUFFER, "i32");
        const errorIndex = C.UTF8ToString(sourceAddress, errorByte).length;
        const suffix = source.slice(errorIndex, errorIndex + 100).split(`
`)[0];
        const word = suffix.match(QUERY_WORD_REGEX)?.[0] ?? "";
        C._free(sourceAddress);
        switch (errorId) {
          case QueryErrorKind.Syntax:
            throw new QueryError(QueryErrorKind.Syntax, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
          case QueryErrorKind.NodeName:
            throw new QueryError(errorId, { word }, errorIndex, word.length);
          case QueryErrorKind.FieldName:
            throw new QueryError(errorId, { word }, errorIndex, word.length);
          case QueryErrorKind.CaptureName:
            throw new QueryError(errorId, { word }, errorIndex, word.length);
          case QueryErrorKind.PatternStructure:
            throw new QueryError(errorId, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
        }
      }
      const stringCount = C._ts_query_string_count(address);
      const captureCount = C._ts_query_capture_count(address);
      const patternCount = C._ts_query_pattern_count(address);
      const captureNames = new Array(captureCount);
      const captureQuantifiers = new Array(patternCount);
      const stringValues = new Array(stringCount);
      for (let i2 = 0;i2 < captureCount; i2++) {
        const nameAddress = C._ts_query_capture_name_for_id(address, i2, TRANSFER_BUFFER);
        const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
        captureNames[i2] = C.UTF8ToString(nameAddress, nameLength);
      }
      for (let i2 = 0;i2 < patternCount; i2++) {
        const captureQuantifiersArray = new Array(captureCount);
        for (let j = 0;j < captureCount; j++) {
          const quantifier = C._ts_query_capture_quantifier_for_id(address, i2, j);
          captureQuantifiersArray[j] = quantifier;
        }
        captureQuantifiers[i2] = captureQuantifiersArray;
      }
      for (let i2 = 0;i2 < stringCount; i2++) {
        const valueAddress = C._ts_query_string_value_for_id(address, i2, TRANSFER_BUFFER);
        const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
        stringValues[i2] = C.UTF8ToString(valueAddress, nameLength);
      }
      const setProperties = new Array(patternCount);
      const assertedProperties = new Array(patternCount);
      const refutedProperties = new Array(patternCount);
      const predicates = new Array(patternCount);
      const textPredicates = new Array(patternCount);
      for (let i2 = 0;i2 < patternCount; i2++) {
        const predicatesAddress = C._ts_query_predicates_for_pattern(address, i2, TRANSFER_BUFFER);
        const stepCount = C.getValue(TRANSFER_BUFFER, "i32");
        predicates[i2] = [];
        textPredicates[i2] = [];
        const steps = new Array;
        let stepAddress = predicatesAddress;
        for (let j = 0;j < stepCount; j++) {
          const stepType = C.getValue(stepAddress, "i32");
          stepAddress += SIZE_OF_INT;
          const stepValueId = C.getValue(stepAddress, "i32");
          stepAddress += SIZE_OF_INT;
          parsePattern(i2, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties);
        }
        Object.freeze(textPredicates[i2]);
        Object.freeze(predicates[i2]);
        Object.freeze(setProperties[i2]);
        Object.freeze(assertedProperties[i2]);
        Object.freeze(refutedProperties[i2]);
      }
      C._free(sourceAddress);
      this[0] = address;
      this.captureNames = captureNames;
      this.captureQuantifiers = captureQuantifiers;
      this.textPredicates = textPredicates;
      this.predicates = predicates;
      this.setProperties = setProperties;
      this.assertedProperties = assertedProperties;
      this.refutedProperties = refutedProperties;
      this.exceededMatchLimit = false;
    }
    delete() {
      C._ts_query_delete(this[0]);
      this[0] = 0;
    }
    matches(node, options = {}) {
      const startPosition = options.startPosition ?? ZERO_POINT;
      const endPosition = options.endPosition ?? ZERO_POINT;
      const startIndex = options.startIndex ?? 0;
      const endIndex = options.endIndex ?? 0;
      const startContainingPosition = options.startContainingPosition ?? ZERO_POINT;
      const endContainingPosition = options.endContainingPosition ?? ZERO_POINT;
      const startContainingIndex = options.startContainingIndex ?? 0;
      const endContainingIndex = options.endContainingIndex ?? 0;
      const matchLimit = options.matchLimit ?? 4294967295;
      const maxStartDepth = options.maxStartDepth ?? 4294967295;
      const progressCallback = options.progressCallback;
      if (typeof matchLimit !== "number") {
        throw new Error("Arguments must be numbers");
      }
      this.matchLimit = matchLimit;
      if (endIndex !== 0 && startIndex > endIndex) {
        throw new Error("`startIndex` cannot be greater than `endIndex`");
      }
      if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
        throw new Error("`startPosition` cannot be greater than `endPosition`");
      }
      if (endContainingIndex !== 0 && startContainingIndex > endContainingIndex) {
        throw new Error("`startContainingIndex` cannot be greater than `endContainingIndex`");
      }
      if (endContainingPosition !== ZERO_POINT && (startContainingPosition.row > endContainingPosition.row || startContainingPosition.row === endContainingPosition.row && startContainingPosition.column > endContainingPosition.column)) {
        throw new Error("`startContainingPosition` cannot be greater than `endContainingPosition`");
      }
      if (progressCallback) {
        C.currentQueryProgressCallback = progressCallback;
      }
      marshalNode(node);
      C._ts_query_matches_wasm(this[0], node.tree[0], startPosition.row, startPosition.column, endPosition.row, endPosition.column, startIndex, endIndex, startContainingPosition.row, startContainingPosition.column, endContainingPosition.row, endContainingPosition.column, startContainingIndex, endContainingIndex, matchLimit, maxStartDepth);
      const rawCount = C.getValue(TRANSFER_BUFFER, "i32");
      const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
      const result = new Array(rawCount);
      this.exceededMatchLimit = Boolean(didExceedMatchLimit);
      let filteredCount = 0;
      let address = startAddress;
      for (let i2 = 0;i2 < rawCount; i2++) {
        const patternIndex = C.getValue(address, "i32");
        address += SIZE_OF_INT;
        const captureCount = C.getValue(address, "i32");
        address += SIZE_OF_INT;
        const captures = new Array(captureCount);
        address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
        if (this.textPredicates[patternIndex].every((p) => p(captures))) {
          result[filteredCount] = { patternIndex, captures };
          const setProperties = this.setProperties[patternIndex];
          result[filteredCount].setProperties = setProperties;
          const assertedProperties = this.assertedProperties[patternIndex];
          result[filteredCount].assertedProperties = assertedProperties;
          const refutedProperties = this.refutedProperties[patternIndex];
          result[filteredCount].refutedProperties = refutedProperties;
          filteredCount++;
        }
      }
      result.length = filteredCount;
      C._free(startAddress);
      C.currentQueryProgressCallback = null;
      return result;
    }
    captures(node, options = {}) {
      const startPosition = options.startPosition ?? ZERO_POINT;
      const endPosition = options.endPosition ?? ZERO_POINT;
      const startIndex = options.startIndex ?? 0;
      const endIndex = options.endIndex ?? 0;
      const startContainingPosition = options.startContainingPosition ?? ZERO_POINT;
      const endContainingPosition = options.endContainingPosition ?? ZERO_POINT;
      const startContainingIndex = options.startContainingIndex ?? 0;
      const endContainingIndex = options.endContainingIndex ?? 0;
      const matchLimit = options.matchLimit ?? 4294967295;
      const maxStartDepth = options.maxStartDepth ?? 4294967295;
      const progressCallback = options.progressCallback;
      if (typeof matchLimit !== "number") {
        throw new Error("Arguments must be numbers");
      }
      this.matchLimit = matchLimit;
      if (endIndex !== 0 && startIndex > endIndex) {
        throw new Error("`startIndex` cannot be greater than `endIndex`");
      }
      if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
        throw new Error("`startPosition` cannot be greater than `endPosition`");
      }
      if (endContainingIndex !== 0 && startContainingIndex > endContainingIndex) {
        throw new Error("`startContainingIndex` cannot be greater than `endContainingIndex`");
      }
      if (endContainingPosition !== ZERO_POINT && (startContainingPosition.row > endContainingPosition.row || startContainingPosition.row === endContainingPosition.row && startContainingPosition.column > endContainingPosition.column)) {
        throw new Error("`startContainingPosition` cannot be greater than `endContainingPosition`");
      }
      if (progressCallback) {
        C.currentQueryProgressCallback = progressCallback;
      }
      marshalNode(node);
      C._ts_query_captures_wasm(this[0], node.tree[0], startPosition.row, startPosition.column, endPosition.row, endPosition.column, startIndex, endIndex, startContainingPosition.row, startContainingPosition.column, endContainingPosition.row, endContainingPosition.column, startContainingIndex, endContainingIndex, matchLimit, maxStartDepth);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
      const result = new Array;
      this.exceededMatchLimit = Boolean(didExceedMatchLimit);
      const captures = new Array;
      let address = startAddress;
      for (let i2 = 0;i2 < count; i2++) {
        const patternIndex = C.getValue(address, "i32");
        address += SIZE_OF_INT;
        const captureCount = C.getValue(address, "i32");
        address += SIZE_OF_INT;
        const captureIndex = C.getValue(address, "i32");
        address += SIZE_OF_INT;
        captures.length = captureCount;
        address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
        if (this.textPredicates[patternIndex].every((p) => p(captures))) {
          const capture = captures[captureIndex];
          const setProperties = this.setProperties[patternIndex];
          capture.setProperties = setProperties;
          const assertedProperties = this.assertedProperties[patternIndex];
          capture.assertedProperties = assertedProperties;
          const refutedProperties = this.refutedProperties[patternIndex];
          capture.refutedProperties = refutedProperties;
          result.push(capture);
        }
      }
      C._free(startAddress);
      C.currentQueryProgressCallback = null;
      return result;
    }
    predicatesForPattern(patternIndex) {
      return this.predicates[patternIndex];
    }
    disableCapture(captureName) {
      const captureNameLength = C.lengthBytesUTF8(captureName);
      const captureNameAddress = C._malloc(captureNameLength + 1);
      C.stringToUTF8(captureName, captureNameAddress, captureNameLength + 1);
      C._ts_query_disable_capture(this[0], captureNameAddress, captureNameLength);
      C._free(captureNameAddress);
    }
    disablePattern(patternIndex) {
      if (patternIndex >= this.predicates.length) {
        throw new Error(`Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`);
      }
      C._ts_query_disable_pattern(this[0], patternIndex);
    }
    didExceedMatchLimit() {
      return this.exceededMatchLimit;
    }
    startIndexForPattern(patternIndex) {
      if (patternIndex >= this.predicates.length) {
        throw new Error(`Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`);
      }
      return C._ts_query_start_byte_for_pattern(this[0], patternIndex);
    }
    endIndexForPattern(patternIndex) {
      if (patternIndex >= this.predicates.length) {
        throw new Error(`Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`);
      }
      return C._ts_query_end_byte_for_pattern(this[0], patternIndex);
    }
    patternCount() {
      return C._ts_query_pattern_count(this[0]);
    }
    captureIndexForName(captureName) {
      return this.captureNames.indexOf(captureName);
    }
    isPatternRooted(patternIndex) {
      return C._ts_query_is_pattern_rooted(this[0], patternIndex) === 1;
    }
    isPatternNonLocal(patternIndex) {
      return C._ts_query_is_pattern_non_local(this[0], patternIndex) === 1;
    }
    isPatternGuaranteedAtStep(byteIndex) {
      return C._ts_query_is_pattern_guaranteed_at_step(this[0], byteIndex) === 1;
    }
  };
});

// src/hooks/detectors/tree-sitter-init.ts
import { existsSync as existsSync2 } from "fs";
import { dirname as dirname2, join as join3 } from "path";
function extToLanguage(ext) {
  const map = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".js": "typescript",
    ".jsx": "tsx",
    ".mjs": "typescript",
    ".cjs": "typescript",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".kt": "java"
  };
  return map[ext.toLowerCase()] ?? null;
}
function resolveWasmPath(filename) {
  const cwd = process.cwd();
  const candidates = [
    join3(cwd, "plugin", "wasm", filename),
    join3(dirname2(dirname2(dirname2(__dirname))), "plugin", "wasm", filename)
  ];
  if (filename.startsWith("tree-sitter-") && filename.endsWith(".wasm")) {
    const lang = filename.replace("tree-sitter-", "").replace(".wasm", "");
    candidates.push(join3(cwd, "node_modules", "@lumis-sh", `wasm-${lang}`, filename));
  }
  if (filename === "web-tree-sitter.wasm") {
    candidates.push(join3(cwd, "node_modules", "web-tree-sitter", filename));
  }
  for (const p of candidates) {
    if (existsSync2(p))
      return p;
  }
  return null;
}
async function initParser(lang) {
  try {
    const { Parser: Parser2, Language: Language2 } = await Promise.resolve().then(() => (init_web_tree_sitter(), exports_web_tree_sitter));
    if (!_initDone) {
      const enginePath = resolveWasmPath("web-tree-sitter.wasm");
      if (!enginePath)
        return null;
      await Parser2.init({ locateFile: () => enginePath });
      _initDone = true;
    }
    let language = _languageCache.get(lang);
    if (!language) {
      const grammarPath = resolveWasmPath(`tree-sitter-${lang}.wasm`);
      if (!grammarPath)
        return null;
      language = await Language2.load(grammarPath);
      _languageCache.set(lang, language);
    }
    const parser = new Parser2;
    parser.setLanguage(language);
    return {
      parser,
      language,
      parse: (code) => parser.parse(code)
    };
  } catch {
    return null;
  }
}
var __dirname = "/Users/shunichi/Projects/qult/src/hooks/detectors", _initDone = false, _languageCache;
var init_tree_sitter_init = __esm(() => {
  _languageCache = new Map;
});

// src/hooks/detectors/complexity-check.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
import { extname } from "path";
function getLanguageNodes(lang) {
  switch (lang) {
    case "typescript":
    case "tsx":
      return TS_NODES;
    case "python":
      return PYTHON_NODES;
    case "go":
      return GO_NODES;
    case "rust":
      return RUST_NODES;
    case "ruby":
      return RUBY_NODES;
    case "java":
      return JAVA_NODES;
  }
}
async function computeComplexity(file) {
  if (isGateDisabled("complexity-check"))
    return null;
  try {
    const ext = extname(file).toLowerCase();
    const lang = extToLanguage(ext);
    if (!lang)
      return null;
    if (!existsSync3(file))
      return null;
    const content = readFileSync2(file, "utf-8");
    if (content.length > MAX_CHECK_SIZE)
      return null;
    const result = await initParser(lang);
    if (!result)
      return null;
    const tree = result.parse(content);
    if (!tree)
      return null;
    const rootNode = tree.rootNode;
    const langNodes = getLanguageNodes(lang);
    const config = loadConfig();
    const functions = [];
    const warnings = [];
    findFunctions(rootNode, langNodes, functions);
    for (const fn of functions) {
      if (fn.cyclomatic > config.gates.complexity_threshold) {
        warnings.push(`L${fn.line}: function "${fn.name}" has cyclomatic complexity ${fn.cyclomatic} (threshold: ${config.gates.complexity_threshold})`);
      }
      if (fn.lineCount > config.gates.function_size_limit) {
        warnings.push(`L${fn.line}: function "${fn.name}" has ${fn.lineCount} lines (limit: ${config.gates.function_size_limit})`);
      }
    }
    return { functions, warnings };
  } catch {
    return null;
  }
}
function cacheComplexityResult(file, result) {
  _lastFile = file;
  _lastResult = result;
}
function findFunctions(node, langNodes, results) {
  if (langNodes.functionTypes.includes(node.type)) {
    const name2 = extractFuncName(node) ?? "<anonymous>";
    const line = node.startPosition.row + 1;
    const lineCount = node.endPosition.row - node.startPosition.row + 1;
    let cyclomatic = 1;
    countBranches(node, langNodes, (_n) => {
      cyclomatic++;
    });
    const cognitive = computeCognitive(node, langNodes, 0);
    results.push({ name: name2, line, cyclomatic, cognitive, lineCount });
  }
  for (const child of node.children) {
    findFunctions(child, langNodes, results);
  }
}
function countBranches(node, langNodes, onBranch) {
  if (langNodes.branchTypes.includes(node.type)) {
    onBranch(node);
  }
  if (node.type === "binary_expression" || node.type === "boolean_operator" || node.type === "binary_operator") {
    for (const child of node.children) {
      if (langNodes.logicalOperatorTypes.includes(child.type) || langNodes.logicalOperatorTypes.includes(child.text)) {
        onBranch(child);
      }
    }
  }
  if (langNodes.ternaryType && node.type === langNodes.ternaryType) {
    onBranch(node);
  }
  for (const child of node.children) {
    if (!langNodes.functionTypes.includes(child.type)) {
      countBranches(child, langNodes, onBranch);
    }
  }
}
function computeCognitive(node, langNodes, nestingLevel) {
  let score = 0;
  for (const child of node.children) {
    if (langNodes.functionTypes.includes(child.type))
      continue;
    if (langNodes.nestingTypes.includes(child.type)) {
      score += 1 + nestingLevel;
      score += computeCognitive(child, langNodes, nestingLevel + 1);
      continue;
    }
    if (child.type === "binary_expression" || child.type === "boolean_operator" || child.type === "binary_operator") {
      for (const grandchild of child.children) {
        if (langNodes.logicalOperatorTypes.includes(grandchild.type) || langNodes.logicalOperatorTypes.includes(grandchild.text)) {
          score += 1;
        }
      }
    }
    if (langNodes.ternaryType && child.type === langNodes.ternaryType) {
      score += 1 + nestingLevel;
    }
    score += computeCognitive(child, langNodes, nestingLevel);
  }
  return score;
}
function extractFuncName(node) {
  const nameNode = node.childForFieldName("name");
  if (nameNode)
    return nameNode.text;
  return null;
}
var MAX_CHECK_SIZE = 500000, TS_NODES, PYTHON_NODES, GO_NODES, RUST_NODES, RUBY_NODES, JAVA_NODES, _lastFile = null, _lastResult = null;
var init_complexity_check = __esm(() => {
  init_config();
  init_session_state();
  init_tree_sitter_init();
  TS_NODES = {
    functionTypes: [
      "function_declaration",
      "arrow_function",
      "method_definition",
      "function_expression"
    ],
    branchTypes: [
      "if_statement",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "catch_clause",
      "switch_case"
    ],
    logicalOperatorTypes: ["&&", "||", "??"],
    nestingTypes: [
      "if_statement",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "switch_statement",
      "catch_clause"
    ],
    ternaryType: "ternary_expression"
  };
  PYTHON_NODES = {
    functionTypes: ["function_definition"],
    branchTypes: ["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause"],
    logicalOperatorTypes: ["and", "or"],
    nestingTypes: ["if_statement", "for_statement", "while_statement", "except_clause"],
    ternaryType: "conditional_expression"
  };
  GO_NODES = {
    functionTypes: ["function_declaration", "method_declaration", "func_literal"],
    branchTypes: ["if_statement", "for_statement", "expression_case", "type_case", "default_case"],
    logicalOperatorTypes: ["&&", "||"],
    nestingTypes: ["if_statement", "for_statement", "select_statement"],
    ternaryType: null
  };
  RUST_NODES = {
    functionTypes: ["function_item"],
    branchTypes: ["if_expression", "for_expression", "while_expression", "match_arm"],
    logicalOperatorTypes: ["&&", "||"],
    nestingTypes: ["if_expression", "for_expression", "while_expression", "match_expression"],
    ternaryType: null
  };
  RUBY_NODES = {
    functionTypes: ["method", "singleton_method"],
    branchTypes: ["if", "elsif", "unless", "for", "while", "until", "when", "rescue"],
    logicalOperatorTypes: ["and", "or", "&&", "||"],
    nestingTypes: ["if", "unless", "for", "while", "until", "case"],
    ternaryType: "conditional"
  };
  JAVA_NODES = {
    functionTypes: ["method_declaration", "constructor_declaration"],
    branchTypes: [
      "if_statement",
      "for_statement",
      "enhanced_for_statement",
      "while_statement",
      "do_statement",
      "catch_clause",
      "switch_block_statement_group"
    ],
    logicalOperatorTypes: ["&&", "||"],
    nestingTypes: [
      "if_statement",
      "for_statement",
      "enhanced_for_statement",
      "while_statement",
      "do_statement",
      "switch_expression",
      "catch_clause"
    ],
    ternaryType: "ternary_expression"
  };
});

// src/hooks/sanitize.ts
function sanitizeForStderr(input) {
  const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// src/hooks/detectors/convention-check.ts
import { readdirSync as readdirSync2, statSync as statSync2 } from "fs";
import { basename as basename2, dirname as dirname3, extname as extname2, join as join4 } from "path";
function classify(name2) {
  if (KEBAB_RE.test(name2))
    return "kebab-case";
  if (SNAKE_RE.test(name2))
    return "snake_case";
  if (PASCAL_RE.test(name2))
    return "PascalCase";
  if (CAMEL_RE.test(name2))
    return "camelCase";
  return "other";
}
function detectConventionDrift(file) {
  const dir = dirname3(file);
  const fileName = basename2(file);
  const stem = basename2(fileName, extname2(fileName));
  let siblings;
  try {
    siblings = readdirSync2(dir).filter((f) => {
      try {
        return f !== fileName && statSync2(join4(dir, f)).isFile();
      } catch {
        return false;
      }
    }).map((f) => basename2(f, extname2(f)));
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

// src/hooks/detectors/dataflow-patterns.ts
function getPatternsForLanguage(lang) {
  switch (lang) {
    case "typescript":
    case "tsx":
      return TS_JS_PATTERN;
    case "python":
      return PYTHON_PATTERN;
    case "go":
      return GO_PATTERN;
    case "rust":
      return RUST_PATTERN;
    case "ruby":
      return RUBY_PATTERN;
    case "java":
      return JAVA_PATTERN;
    default:
      return null;
  }
}
var TS_JS_PATTERN, PYTHON_PATTERN, GO_PATTERN, RUST_PATTERN, RUBY_PATTERN, JAVA_PATTERN;
var init_dataflow_patterns = __esm(() => {
  TS_JS_PATTERN = {
    sources: [
      { nodeType: "member_expression", textPattern: /req(?:uest)?\.body/, desc: "HTTP request body" },
      {
        nodeType: "member_expression",
        textPattern: /req(?:uest)?\.params/,
        desc: "HTTP request params"
      },
      {
        nodeType: "member_expression",
        textPattern: /req(?:uest)?\.query/,
        desc: "HTTP request query"
      },
      {
        nodeType: "member_expression",
        textPattern: /req(?:uest)?\.headers/,
        desc: "HTTP request headers"
      },
      { nodeType: "member_expression", textPattern: /process\.argv/, desc: "process.argv" },
      { nodeType: "member_expression", textPattern: /process\.stdin/, desc: "process.stdin" }
    ],
    sinks: [
      {
        nodeType: "call_expression",
        textPattern: /\beval\s*\(/,
        desc: "eval() \u2014 code injection risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /\bexec\s*\(/,
        desc: "exec() \u2014 command injection risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /\bexecSync\s*\(/,
        desc: "execSync() \u2014 command injection risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /\bFunction\s*\(/,
        desc: "Function() \u2014 code injection risk"
      },
      {
        nodeType: "assignment_expression",
        textPattern: /\.innerHTML\s*=/,
        desc: "innerHTML \u2014 XSS risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /document\.write\s*\(/,
        desc: "document.write() \u2014 XSS risk"
      }
    ],
    scopeNodes: ["statement_block", "arrow_function", "function_declaration", "method_definition"],
    functionNodes: [
      "function_declaration",
      "arrow_function",
      "method_definition",
      "function_expression"
    ],
    parameterNodes: ["formal_parameters", "required_parameter", "optional_parameter"],
    variableDeclarationNodes: ["variable_declarator", "lexical_declaration"],
    assignmentNodes: ["assignment_expression"],
    callNodes: ["call_expression"]
  };
  PYTHON_PATTERN = {
    sources: [
      { nodeType: "attribute", textPattern: /request\.form/, desc: "Flask request.form" },
      { nodeType: "attribute", textPattern: /request\.args/, desc: "Flask request.args" },
      { nodeType: "attribute", textPattern: /request\.json/, desc: "Flask request.json" },
      { nodeType: "attribute", textPattern: /request\.data/, desc: "Flask request.data" },
      { nodeType: "attribute", textPattern: /sys\.argv/, desc: "sys.argv" },
      { nodeType: "call", textPattern: /\binput\s*\(/, desc: "input()" }
    ],
    sinks: [
      { nodeType: "call", textPattern: /\beval\s*\(/, desc: "eval() \u2014 code injection risk" },
      { nodeType: "call", textPattern: /\bexec\s*\(/, desc: "exec() \u2014 code injection risk" },
      {
        nodeType: "call",
        textPattern: /os\.system\s*\(/,
        desc: "os.system() \u2014 command injection risk"
      },
      {
        nodeType: "call",
        textPattern: /subprocess\.(?:call|run|Popen)\s*\(/,
        desc: "subprocess \u2014 command injection risk"
      },
      {
        nodeType: "call",
        textPattern: /cursor\.execute\s*\(/,
        desc: "cursor.execute() \u2014 SQL injection risk"
      }
    ],
    scopeNodes: ["block", "function_definition", "class_definition"],
    functionNodes: ["function_definition"],
    parameterNodes: ["parameters", "default_parameter", "typed_parameter"],
    variableDeclarationNodes: [],
    assignmentNodes: ["assignment", "augmented_assignment"],
    callNodes: ["call"]
  };
  GO_PATTERN = {
    sources: [
      { nodeType: "call_expression", textPattern: /\.FormValue\s*\(/, desc: "HTTP FormValue" },
      { nodeType: "selector_expression", textPattern: /\.URL\.Query/, desc: "URL.Query" },
      { nodeType: "selector_expression", textPattern: /os\.Args/, desc: "os.Args" }
    ],
    sinks: [
      {
        nodeType: "call_expression",
        textPattern: /exec\.Command\s*\(/,
        desc: "exec.Command() \u2014 command injection risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /template\.HTML\s*\(/,
        desc: "template.HTML() \u2014 XSS risk"
      },
      {
        nodeType: "call_expression",
        textPattern: /db\.(?:Exec|Query)\s*\(/,
        desc: "db.Exec/Query() \u2014 SQL injection risk"
      }
    ],
    scopeNodes: ["block", "function_declaration", "method_declaration"],
    functionNodes: ["function_declaration", "method_declaration", "func_literal"],
    parameterNodes: ["parameter_list", "parameter_declaration"],
    variableDeclarationNodes: ["short_var_declaration", "var_declaration"],
    assignmentNodes: ["assignment_statement"],
    callNodes: ["call_expression"]
  };
  RUST_PATTERN = {
    sources: [
      { nodeType: "call_expression", textPattern: /std::io::stdin/, desc: "stdin" },
      { nodeType: "call_expression", textPattern: /env::args/, desc: "env::args" }
    ],
    sinks: [
      { nodeType: "macro_invocation", textPattern: /format!/, desc: "format! with user input" }
    ],
    scopeNodes: ["block", "function_item", "impl_item"],
    functionNodes: ["function_item"],
    parameterNodes: ["parameters", "parameter"],
    variableDeclarationNodes: ["let_declaration"],
    assignmentNodes: ["assignment_expression"],
    callNodes: ["call_expression", "macro_invocation"]
  };
  RUBY_PATTERN = {
    sources: [
      { nodeType: "element_reference", textPattern: /params\[/, desc: "params[] \u2014 user input" },
      { nodeType: "call", textPattern: /request\.env/, desc: "request.env" },
      { nodeType: "call", textPattern: /\bgets\b/, desc: "gets \u2014 stdin" }
    ],
    sinks: [
      { nodeType: "call", textPattern: /\bsystem\s*\(/, desc: "system() \u2014 command injection risk" },
      { nodeType: "call", textPattern: /\beval\s*\(/, desc: "eval() \u2014 code injection risk" },
      { nodeType: "call", textPattern: /\bexec\s*\(/, desc: "exec() \u2014 command injection risk" },
      { nodeType: "subshell", textPattern: /`/, desc: "backtick command \u2014 command injection risk" }
    ],
    scopeNodes: ["body_statement", "method", "do_block", "block"],
    functionNodes: ["method", "singleton_method"],
    parameterNodes: ["method_parameters", "block_parameters"],
    variableDeclarationNodes: [],
    assignmentNodes: ["assignment"],
    callNodes: ["call", "method_call"]
  };
  JAVA_PATTERN = {
    sources: [
      {
        nodeType: "method_invocation",
        textPattern: /\.getParameter\s*\(/,
        desc: "request.getParameter"
      },
      {
        nodeType: "method_invocation",
        textPattern: /\.getInputStream\s*\(/,
        desc: "request.getInputStream"
      },
      { nodeType: "method_invocation", textPattern: /\.getHeader\s*\(/, desc: "request.getHeader" }
    ],
    sinks: [
      {
        nodeType: "method_invocation",
        textPattern: /Runtime.*\.exec\s*\(/,
        desc: "Runtime.exec() \u2014 command injection"
      },
      {
        nodeType: "object_creation_expression",
        textPattern: /new\s+ProcessBuilder/,
        desc: "ProcessBuilder \u2014 command injection"
      },
      {
        nodeType: "method_invocation",
        textPattern: /\.execute\s*\(/,
        desc: "Statement.execute() \u2014 SQL injection"
      },
      {
        nodeType: "method_invocation",
        textPattern: /\.executeQuery\s*\(/,
        desc: "executeQuery() \u2014 SQL injection"
      }
    ],
    scopeNodes: ["block", "method_declaration", "constructor_declaration"],
    functionNodes: ["method_declaration", "constructor_declaration"],
    parameterNodes: ["formal_parameters", "formal_parameter"],
    variableDeclarationNodes: ["local_variable_declaration"],
    assignmentNodes: ["assignment_expression"],
    callNodes: ["method_invocation"]
  };
});

// src/hooks/detectors/dataflow-check.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs";
import { extname as extname3 } from "path";
async function detectDataflowIssues(file) {
  if (isGateDisabled("dataflow-check"))
    return [];
  try {
    const ext = extname3(file).toLowerCase();
    const lang = extToLanguage(ext);
    if (!lang)
      return [];
    if (!existsSync4(file))
      return [];
    const content = readFileSync3(file, "utf-8");
    if (content.length > MAX_CHECK_SIZE2)
      return [];
    const patterns = getPatternsForLanguage(lang);
    if (!patterns)
      return [];
    const result = await initParser(lang);
    if (!result)
      return [];
    const tree = result.parse(content);
    if (!tree)
      return [];
    const errors = [];
    const rootNode = tree.rootNode;
    const globalTainted = new Map;
    const functionDefs = new Map;
    collectTaintsAndFunctions(rootNode, patterns, lang, globalTainted, functionDefs, 0);
    for (let hop = 1;hop <= MAX_HOPS; hop++) {
      propagateTaint(rootNode, globalTainted, patterns, hop);
    }
    propagateThroughCalls(rootNode, globalTainted, functionDefs, patterns);
    checkSinks(rootNode, globalTainted, patterns, errors);
    if (errors.length === 0)
      return [];
    return [
      {
        file,
        errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
        gate: "dataflow-check"
      }
    ];
  } catch {
    return [];
  }
}
function collectTaintsAndFunctions(node, patterns, lang, tainted, functions, scopeDepth) {
  if (!patterns)
    return;
  if (isVariableDeclaration(node, patterns, lang)) {
    const varName = extractAssignTarget(node);
    const initializer = extractAssignSource(node);
    if (varName && initializer) {
      for (const src of patterns.sources) {
        if (src.textPattern.test(initializer.text)) {
          tainted.set(varName, { name: varName, scopeDepth, hop: 0, sourceDesc: src.desc });
          break;
        }
      }
    }
  }
  if (patterns.functionNodes.includes(node.type)) {
    const funcName = extractFunctionName(node, lang);
    if (funcName) {
      const params = extractParams(node, lang);
      const body2 = findBody(node, lang);
      if (body2) {
        functions.set(funcName, { params, bodyNode: body2 });
      }
    }
  }
  const newDepth = patterns.scopeNodes.includes(node.type) ? scopeDepth + 1 : scopeDepth;
  for (const child of node.children) {
    collectTaintsAndFunctions(child, patterns, lang, tainted, functions, newDepth);
  }
}
function propagateTaint(node, tainted, patterns, hop) {
  if (!patterns)
    return;
  const isDecl = node.type === "variable_declarator" || patterns.assignmentNodes.includes(node.type) || node.type === "assignment" || node.type === "short_var_declaration";
  if (isDecl) {
    const varName = extractAssignTarget(node);
    const rhs = extractAssignSource(node);
    if (varName && rhs) {
      const rhsText = rhs.text.trim();
      const tv = tainted.get(rhsText);
      if (tv) {
        const newHop = tv.hop + 1;
        if (newHop <= MAX_HOPS) {
          const existing = tainted.get(varName);
          if (!existing || existing.hop > newHop) {
            tainted.set(varName, {
              name: varName,
              scopeDepth: 0,
              hop: newHop,
              sourceDesc: tv.sourceDesc
            });
          }
        }
      }
    }
  }
  for (const child of node.children) {
    propagateTaint(child, tainted, patterns, hop);
  }
}
function propagateThroughCalls(node, tainted, functions, patterns) {
  if (!patterns)
    return;
  if (!patterns.callNodes.includes(node.type)) {
    for (const child of node.children) {
      propagateThroughCalls(child, tainted, functions, patterns);
    }
    return;
  }
  const funcName = extractCallName(node);
  const funcDef = funcName ? functions.get(funcName) : null;
  if (funcDef) {
    const argsNode = node.childForFieldName("arguments");
    const argNodes = argsNode ? argsNode.namedChildren : [];
    for (let i2 = 0;i2 < argNodes.length && i2 < funcDef.params.length; i2++) {
      const argNode = argNodes[i2];
      const argText = argNode.text.trim();
      const tv = tainted.get(argText);
      if (tv && tv.hop < MAX_HOPS) {
        tainted.set(funcDef.params[i2], {
          name: funcDef.params[i2],
          scopeDepth: 0,
          hop: tv.hop + 1,
          sourceDesc: tv.sourceDesc
        });
        continue;
      }
      if (patterns) {
        for (const src of patterns.sources) {
          if (src.textPattern.test(argText)) {
            tainted.set(funcDef.params[i2], {
              name: funcDef.params[i2],
              scopeDepth: 0,
              hop: 1,
              sourceDesc: src.desc
            });
            break;
          }
        }
      }
    }
  }
  for (const child of node.children) {
    propagateThroughCalls(child, tainted, functions, patterns);
  }
}
function checkSinks(node, tainted, patterns, errors) {
  if (!patterns)
    return;
  for (const sink of patterns.sinks) {
    if (node.type === sink.nodeType || patterns.callNodes.includes(node.type)) {
      if (sink.textPattern.test(node.text)) {
        const args2 = extractCallArgs(node);
        for (const arg of args2) {
          const tv = tainted.get(arg.trim());
          if (tv) {
            const line = node.startPosition.row + 1;
            errors.push(`L${line}: ${sink.desc} \u2014 tainted by ${tv.sourceDesc} (${tv.hop + 1} hop${tv.hop > 0 ? "s" : ""})`);
            break;
          }
        }
      }
    }
  }
  for (const child of node.children) {
    checkSinks(child, tainted, patterns, errors);
  }
}
function isVariableDeclaration(node, patterns, lang) {
  if (!patterns)
    return false;
  if (patterns.variableDeclarationNodes.includes(node.type))
    return true;
  if (patterns.assignmentNodes.includes(node.type))
    return true;
  if (lang === "python" && node.type === "expression_statement") {
    const child = node.namedChild(0);
    if (child && child.type === "assignment")
      return true;
  }
  return false;
}
function extractAssignTarget(node) {
  if (node.type === "variable_declarator") {
    return node.childForFieldName("name")?.text ?? null;
  }
  if (node.type === "lexical_declaration") {
    const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
    return declarator ? extractAssignTarget(declarator) : null;
  }
  if (node.type === "assignment" || node.type === "assignment_expression" || node.type === "assignment_statement") {
    return node.childForFieldName("left")?.text ?? null;
  }
  if (node.type === "short_var_declaration") {
    return node.childForFieldName("left")?.text ?? null;
  }
  if (node.type === "expression_statement") {
    const child = node.namedChild(0);
    if (child?.type === "assignment")
      return extractAssignTarget(child);
  }
  return null;
}
function extractAssignSource(node) {
  if (node.type === "variable_declarator") {
    return node.childForFieldName("value");
  }
  if (node.type === "lexical_declaration") {
    const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
    return declarator ? extractAssignSource(declarator) : null;
  }
  if (node.type === "assignment" || node.type === "assignment_expression" || node.type === "assignment_statement") {
    return node.childForFieldName("right");
  }
  if (node.type === "short_var_declaration") {
    return node.childForFieldName("right");
  }
  if (node.type === "expression_statement") {
    const child = node.namedChild(0);
    if (child?.type === "assignment")
      return extractAssignSource(child);
  }
  return null;
}
function extractFunctionName(node, _lang) {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}
function extractParams(node, _lang) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode)
    return [];
  return paramsNode.namedChildren.map((p) => {
    const nameField = p.childForFieldName("name") ?? p.childForFieldName("pattern");
    if (nameField)
      return nameField.text;
    if (p.type === "identifier")
      return p.text;
    const firstIdent = p.namedChildren.find((c) => c.type === "identifier");
    return firstIdent?.text ?? p.text;
  }).filter((name2) => name2.length > 0);
}
function findBody(node, _lang) {
  return node.childForFieldName("body");
}
function extractCallName(node) {
  const funcNode = node.childForFieldName("function");
  if (funcNode?.type === "identifier")
    return funcNode.text;
  return null;
}
function extractCallArgs(node) {
  const argsNode = node.childForFieldName("arguments");
  if (!argsNode) {
    const argList = node.namedChildren.find((c) => c.type === "arguments" || c.type === "argument_list");
    if (argList) {
      return argList.namedChildren.map((c) => c.text);
    }
    return [];
  }
  return argsNode.namedChildren.map((c) => c.text);
}
var MAX_CHECK_SIZE2 = 500000, MAX_HOPS = 3;
var init_dataflow_check = __esm(() => {
  init_session_state();
  init_dataflow_patterns();
  init_tree_sitter_init();
});

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "fs";
import { extname as extname4 } from "path";
function detectDeadImports(file) {
  if (isGateDisabled("dead-import-check"))
    return [];
  const ext = extname4(file).toLowerCase();
  if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext))
    return [];
  if (!existsSync5(file))
    return [];
  let content;
  try {
    content = readFileSync4(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE3)
    return [];
  if (PY_EXTS.has(ext))
    return detectDeadPythonImports(content);
  return detectDeadTsJsImports(content);
}
function detectDeadTsJsImports(content) {
  const lines = content.split(`
`);
  const imports = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    if (SIDE_EFFECT_RE.test(line) && !DEFAULT_IMPORT_RE.test(line) && !NAMED_IMPORT_RE.test(line) && !NAMESPACE_IMPORT_RE.test(line))
      continue;
    if (REEXPORT_RE.test(line))
      continue;
    const typeMatch = line.match(TYPE_IMPORT_RE);
    if (typeMatch) {
      for (const imp of parseNamedImports(typeMatch[1])) {
        imports.push({ name: imp.alias, line: i2 + 1 });
      }
      continue;
    }
    const defaultMatch = line.match(DEFAULT_IMPORT_RE);
    if (defaultMatch) {
      imports.push({ name: defaultMatch[1], line: i2 + 1 });
    }
    const namedMatch = line.match(NAMED_IMPORT_RE);
    if (namedMatch) {
      for (const imp of parseNamedImports(namedMatch[1])) {
        imports.push({ name: imp.alias, line: i2 + 1 });
      }
    }
    const nsMatch = line.match(NAMESPACE_IMPORT_RE);
    if (nsMatch) {
      imports.push({ name: nsMatch[1], line: i2 + 1 });
    }
  }
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ")).map((line) => line.replace(/\/\/.*$/, "")).join(`
`).replace(/\/\*[\s\S]*?\*\//g, "");
  const warnings = [];
  for (const { name: name2, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name2)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name2}" \u2014 consider removing`));
    }
  }
  return warnings;
}
function detectDeadPythonImports(content) {
  const lines = content.split(`
`);
  const imports = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    if (line.trimStart().startsWith("#"))
      continue;
    const fromMatch = line.match(PY_FROM_IMPORT_RE);
    if (fromMatch) {
      const names = fromMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const n of names) {
        const parts2 = n.split(/\s+as\s+/);
        const alias = (parts2.length > 1 ? parts2[1] : parts2[0]).trim();
        if (alias === "*")
          continue;
        if (/^\w+$/.test(alias)) {
          imports.push({ name: alias, line: i2 + 1 });
        }
      }
      continue;
    }
    const importMatch = line.match(PY_IMPORT_RE);
    if (importMatch) {
      const names = importMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const n of names) {
        const parts2 = n.split(/\s+as\s+/);
        const alias = (parts2.length > 1 ? parts2[1] : parts2[0]).trim();
        const topName = alias.split(".")[0];
        if (/^\w+$/.test(topName)) {
          imports.push({ name: topName, line: i2 + 1 });
        }
      }
    }
  }
  const codeWithoutImports = lines.filter((line) => !line.trimStart().startsWith("import ") && !line.trimStart().startsWith("from ")).map((line) => line.replace(/#.*$/, "")).join(`
`);
  const warnings = [];
  for (const { name: name2, line } of imports) {
    const usageRe = new RegExp(`\\b${escapeRegex(name2)}\\b`);
    if (!usageRe.test(codeWithoutImports)) {
      warnings.push(sanitizeForStderr(`L${line}: unused import "${name2}" \u2014 consider removing`));
    }
  }
  return warnings;
}
function parseNamedImports(raw) {
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
    const withoutType = s.replace(/^type\s+/, "");
    const parts2 = withoutType.split(/\s+as\s+/);
    return {
      name: parts2[0].trim(),
      alias: (parts2.length > 1 ? parts2[1] : parts2[0]).trim()
    };
  }).filter(({ alias }) => /^\w+$/.test(alias));
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var TS_JS_EXTS, PY_EXTS, MAX_CHECK_SIZE3 = 500000, DEFAULT_IMPORT_RE, NAMED_IMPORT_RE, NAMESPACE_IMPORT_RE, SIDE_EFFECT_RE, REEXPORT_RE, TYPE_IMPORT_RE, PY_FROM_IMPORT_RE, PY_IMPORT_RE;
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

// src/hooks/detectors/dep-vuln-check.ts
import { execFileSync } from "child_process";
function extractInstalledPackages(command) {
  const sanitized = command.replace(/\s*(?:&&|\|\||[;|]).*$/, "");
  for (const { re, pm } of PM_PATTERNS) {
    if (!re.test(sanitized))
      continue;
    const match = sanitized.match(re);
    if (!match)
      continue;
    const afterCmd = sanitized.slice(match.index + match[0].length).trim();
    const FLAGS_WITH_ARGS = new Set([
      "-r",
      "-e",
      "-c",
      "-f",
      "--requirement",
      "--editable",
      "--constraint",
      "--config",
      "--features",
      "--path",
      "--prefix",
      "--target",
      "--registry"
    ]);
    const tokens = afterCmd.split(/\s+/).filter((t) => t.length > 0);
    const packages = [];
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (token.startsWith("-")) {
        if (FLAGS_WITH_ARGS.has(token)) {
          skipNext = true;
        }
        continue;
      }
      if (token === "." || token.startsWith("./") || token.startsWith("/") || token.startsWith("~")) {
        continue;
      }
      if (pm === "pip") {
        packages.push(token.replace(/[><=!~;].*/, ""));
      } else if (pm === "npm" || pm === "yarn" || pm === "pnpm" || pm === "bun") {
        let cleaned = token;
        const lastAt = token.lastIndexOf("@");
        if (lastAt > 0) {
          cleaned = token.slice(0, lastAt);
        }
        packages.push(cleaned);
      } else {
        packages.push(token);
      }
    }
    if (packages.length === 0)
      return null;
    return { pm, packages };
  }
  return null;
}
function getSeverity(vuln) {
  if (vuln.database_specific?.severity) {
    return vuln.database_specific.severity.toUpperCase();
  }
  if (vuln.severity) {
    for (const s of vuln.severity) {
      if ((s.type === "CVSS_V3" || s.type === "CVSS_V4") && s.score) {
        const vec = s.score;
        const isNetwork = vec.includes("AV:N");
        const hasHighImpact = vec.includes("C:H") || vec.includes("I:H") || vec.includes("A:H");
        if (isNetwork && hasHighImpact)
          return "HIGH";
        if (hasHighImpact)
          return "HIGH";
        return "MODERATE";
      }
    }
  }
  return "UNKNOWN";
}
function runOsvScanner(args2, cwd, timeout) {
  try {
    const output = execFileSync("osv-scanner", args2, {
      cwd,
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8"
    });
    return typeof output === "string" ? output : String(output);
  } catch (err2) {
    if (err2 && typeof err2 === "object" && "stdout" in err2 && typeof err2.stdout === "string" && err2.stdout.length > 0) {
      return err2.stdout;
    }
    return null;
  }
}
function scanDependencyVulns(cwd) {
  if (isGateDisabled("dep-vuln-check"))
    return [];
  const raw = runOsvScanner(["--format", "json", "-r", "."], cwd, SCAN_TIMEOUT);
  if (!raw)
    return [];
  try {
    return parseOsvOutput(raw);
  } catch {
    return [];
  }
}
function parseOsvOutput(raw) {
  const data = JSON.parse(raw);
  if (!data.results || !Array.isArray(data.results))
    return [];
  const blockingFixes = [];
  for (const result of data.results) {
    const sourceFile = result.source?.path ?? "(unknown)";
    for (const pkg of result.packages ?? []) {
      const name2 = pkg.package?.name ?? "unknown";
      const version = pkg.package?.version ?? "?";
      for (const vuln of pkg.vulnerabilities ?? []) {
        const severity = getSeverity(vuln);
        const id = vuln.id ?? "unknown";
        const summary = vuln.summary ?? "";
        const desc = `[${severity}] ${name2}@${version} \u2014 ${id}: ${summary}`.slice(0, 300);
        if (BLOCKING_SEVERITIES.has(severity)) {
          const existing = blockingFixes.find((f) => f.file === sourceFile);
          if (existing) {
            existing.errors.push(desc);
          } else {
            blockingFixes.push({
              file: sourceFile,
              gate: "dep-vuln-check",
              errors: [desc]
            });
          }
        } else {
          process.stderr.write(`[qult] dep-vuln advisory: ${desc}
`);
        }
      }
    }
  }
  return blockingFixes;
}
var SCAN_TIMEOUT = 8000, BLOCKING_SEVERITIES, PM_PATTERNS;
var init_dep_vuln_check = __esm(() => {
  init_session_state();
  BLOCKING_SEVERITIES = new Set(["CRITICAL", "HIGH"]);
  PM_PATTERNS = [
    { re: /\bnpm\s+(?:install|i|add)\b/, pm: "npm" },
    { re: /\byarn\s+add\b/, pm: "yarn" },
    { re: /\bpnpm\s+add\b/, pm: "pnpm" },
    { re: /\bbun\s+add\b/, pm: "bun" },
    { re: /\bpip\s+install\b/, pm: "pip" },
    { re: /\bcargo\s+add\b/, pm: "cargo" },
    { re: /\bgo\s+get\b/, pm: "go" },
    { re: /\bgem\s+install\b/, pm: "gem" },
    { re: /\bcomposer\s+require\b/, pm: "composer" }
  ];
});

// src/hooks/detectors/duplication-check.ts
import { existsSync as existsSync6, readFileSync as readFileSync5 } from "fs";
import { basename as basename3, dirname as dirname4, extname as extname5, resolve } from "path";
function isTestFile(filePath) {
  const name2 = basename3(filePath);
  if (/\.(test|spec)\.[^.]+$/.test(name2))
    return true;
  const parent = basename3(dirname4(filePath));
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
  for (let i2 = 0;i2 < lines.length; i2++) {
    const norm = normalizeLine(lines[i2]);
    if (norm !== null) {
      normalized.push({ line: i2 + 1, text: norm });
    }
  }
  const windows = new Map;
  for (let i2 = 0;i2 <= normalized.length - MIN_BLOCK_LINES; i2++) {
    const key = normalized.slice(i2, i2 + MIN_BLOCK_LINES).map((n) => n.text).join(`
`);
    const startLine = normalized[i2].line;
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
  const ext = extname5(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync6(file))
    return [];
  let content;
  try {
    content = readFileSync5(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE4)
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
  if (isTestFile(file))
    return [];
  if (isGateDisabled("duplication-check"))
    return [];
  if (sessionFiles.length > MAX_SESSION_FILES) {
    process.stderr.write(`[qult] Cross-file duplication check skipped: session has ${sessionFiles.length} files, max ${MAX_SESSION_FILES} allowed. Increase MAX_SESSION_FILES to enable on large refactorings.
`);
    return [];
  }
  const ext = extname5(file).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext))
    return [];
  if (!existsSync6(file))
    return [];
  let content;
  try {
    content = readFileSync5(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE4)
    return [];
  const sourceWindows = buildHashWindows(content);
  const warnings = [];
  const cwd = process.cwd();
  for (const otherFile of sessionFiles) {
    if (otherFile === file)
      continue;
    if (isTestFile(otherFile))
      continue;
    const absOther = resolve(otherFile);
    if (!absOther.startsWith(`${cwd}/`))
      continue;
    if (!existsSync6(otherFile))
      continue;
    const otherExt = extname5(otherFile).toLowerCase();
    if (!CHECKABLE_EXTS.has(otherExt))
      continue;
    let otherContent;
    try {
      otherContent = readFileSync5(otherFile, "utf-8");
    } catch {
      continue;
    }
    if (otherContent.length > MAX_CHECK_SIZE4)
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
function getRelativePath(filePath, cwd) {
  const full = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
  const segments = full.split("/");
  if (segments.length <= 3)
    return full;
  return `${segments[0]}/.../.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
var CHECKABLE_EXTS, MAX_CHECK_SIZE4 = 500000, MIN_BLOCK_LINES = 4, MAX_SESSION_FILES = 20;
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
import { execSync as execSync2 } from "child_process";
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "fs";
import { extname as extname6 } from "path";
function detectExportBreakingChanges(file) {
  if (isGateDisabled("export-check"))
    return [];
  const ext = extname6(file).toLowerCase();
  if (!TS_JS_EXTS2.has(ext))
    return [];
  if (!existsSync7(file))
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
  const newContent = readFileSync6(file, "utf-8");
  const oldExports = new Set;
  for (const match of oldContent.matchAll(EXPORT_RE)) {
    oldExports.add(match[1]);
  }
  const newExports = new Set;
  for (const match of newContent.matchAll(EXPORT_RE)) {
    newExports.add(match[1]);
  }
  const removed = [...oldExports].filter((name2) => !newExports.has(name2));
  const oldSigs = new Map;
  for (const match of oldContent.matchAll(FUNC_SIG_RE)) {
    const params = match[2].trim();
    oldSigs.set(match[1], params ? params.split(",").length : 0);
  }
  const signatureChanges = [];
  for (const match of newContent.matchAll(FUNC_SIG_RE)) {
    const name2 = match[1];
    const newParamCount = match[2].trim() ? match[2].trim().split(",").length : 0;
    const oldParamCount = oldSigs.get(name2);
    if (oldParamCount !== undefined && oldParamCount !== newParamCount) {
      signatureChanges.push(`Signature change: "${sanitizeForStderr(name2)}" params ${oldParamCount}\u2192${newParamCount}. Consumers may break.`);
    }
  }
  const typeChanges = detectTypeFieldChanges(oldContent, newContent);
  const errors = [
    ...removed.map((name2) => `Breaking change: export "${sanitizeForStderr(name2)}" was removed`),
    ...signatureChanges,
    ...typeChanges
  ];
  if (errors.length === 0)
    return [];
  return [{ file, errors, gate: "export-check" }];
}
function detectTypeFieldChanges(oldContent, newContent) {
  const TYPE_DEF_RE = /\bexport\s+(?:type|interface)\s+(\w+)\s*(?:=\s*)?{([^}]*)}/g;
  const countFields = (body2) => body2.split(/[;\n]/).map((s) => s.trim()).filter((s) => s && !s.startsWith("//")).length;
  const oldTypes = new Map;
  for (const m of oldContent.matchAll(TYPE_DEF_RE)) {
    oldTypes.set(m[1], countFields(m[2]));
  }
  const changes = [];
  for (const m of newContent.matchAll(TYPE_DEF_RE)) {
    const name2 = m[1];
    const newFields = countFields(m[2]);
    const oldFields = oldTypes.get(name2);
    if (oldFields !== undefined && oldFields !== newFields) {
      changes.push(`Type change: "${sanitizeForStderr(name2)}" fields ${oldFields}\u2192${newFields}. Consumers may need updates.`);
    }
  }
  return changes;
}
var TS_JS_EXTS2, EXPORT_RE, FUNC_SIG_RE;
var init_export_check = __esm(() => {
  init_session_state();
  TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  FUNC_SIG_RE = /\bexport\s+(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
});

// src/hooks/detectors/hallucinated-package-check.ts
async function checkPackageExists(pm, packageName) {
  const urlBuilder = REGISTRY_URLS[pm];
  if (!urlBuilder)
    return true;
  const url = urlBuilder(packageName);
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal
    });
    if (response.status === 404)
      return false;
    return true;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}
async function checkInstalledPackages(pm, packages) {
  if (isGateDisabled("hallucinated-package-check"))
    return [];
  if (packages.length === 0)
    return [];
  const results = await Promise.allSettled(packages.map(async (pkg) => {
    const exists = await checkPackageExists(pm, pkg);
    return { pkg, exists };
  }));
  const nonExistent = [];
  for (const result of results) {
    if (result.status === "fulfilled" && !result.value.exists) {
      nonExistent.push(result.value.pkg);
    }
  }
  if (nonExistent.length === 0)
    return [];
  return [
    {
      file: "(install-command)",
      gate: "hallucinated-package-check",
      errors: nonExistent.map((pkg) => `Package "${pkg}" does not exist in ${pm} registry \u2014 possible hallucination. Remove or replace with a real package.`)
    }
  ];
}
var CHECK_TIMEOUT = 3000, REGISTRY_URLS;
var init_hallucinated_package_check = __esm(() => {
  init_session_state();
  REGISTRY_URLS = {
    npm: (pkg) => `https://registry.npmjs.org/${pkg}`,
    yarn: (pkg) => `https://registry.npmjs.org/${pkg}`,
    pnpm: (pkg) => `https://registry.npmjs.org/${pkg}`,
    bun: (pkg) => `https://registry.npmjs.org/${pkg}`,
    pip: (pkg) => `https://pypi.org/pypi/${pkg}/json`,
    cargo: (pkg) => `https://crates.io/api/v1/crates/${pkg}`,
    gem: (pkg) => `https://rubygems.org/api/v1/gems/${pkg}.json`,
    go: (pkg) => `https://proxy.golang.org/${pkg}/@v/list`,
    composer: (pkg) => `https://repo.packagist.org/p2/${pkg}.json`
  };
});

// src/hooks/detectors/import-check.ts
import { existsSync as existsSync8, readdirSync as readdirSync3, readFileSync as readFileSync7 } from "fs";
import { extname as extname7, join as join5, resolve as resolve2 } from "path";
function detectHallucinatedImports(file) {
  if (isGateDisabled("import-check"))
    return [];
  const ext = extname7(file).toLowerCase();
  if (!TS_JS_EXTS3.has(ext) && !PY_EXTS2.has(ext) && !GO_EXTS.has(ext))
    return [];
  if (!existsSync8(file))
    return [];
  const content = readFileSync7(file, "utf-8");
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
    const tsconfigPath = join5(cwd, "tsconfig.json");
    if (!existsSync8(tsconfigPath))
      return aliases;
    const raw = readFileSync7(tsconfigPath, "utf-8");
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
    if (!existsSync8(join5(cwd, "node_modules", pkgName))) {
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
    if (existsSync8(join5(cwd, `${moduleName}.py`)) || existsSync8(join5(cwd, moduleName)))
      continue;
    if (sitePackagesDirs.some((dir) => existsSync8(join5(dir, moduleName)) || existsSync8(join5(dir, `${moduleName}.py`))))
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
    goSum = readFileSync7(join5(cwd, "go.sum"), "utf-8");
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
    if (vendorPath.startsWith(`${vendorDir}/`) && existsSync8(vendorPath))
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
  const venvRoots = [join5(cwd, ".venv"), join5(cwd, "venv")];
  for (const root of venvRoots) {
    try {
      if (!existsSync8(root))
        continue;
      const libDir = join5(root, "lib");
      if (!existsSync8(libDir))
        continue;
      const entries = readdirSync3(libDir).filter((e) => e.startsWith("python"));
      for (const entry of entries) {
        const sp = join5(libDir, entry, "site-packages");
        if (existsSync8(sp))
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

// src/hooks/detectors/test-file-resolver.ts
import { existsSync as existsSync9 } from "fs";
import { basename as basename4, dirname as dirname5, extname as extname8, join as join6 } from "path";
function resolveTestFile(sourceFile) {
  const ext = extname8(sourceFile);
  const base = basename4(sourceFile, ext);
  const dir = dirname5(sourceFile);
  if (isTestFile2(sourceFile))
    return null;
  for (const pattern of TEST_PATTERNS) {
    const candidate = pattern(dir, base, ext);
    if (candidate && existsSync9(candidate)) {
      return candidate;
    }
  }
  return null;
}
function isTestFile2(file) {
  const base = basename4(file);
  return /\.(test|spec)\.\w+$/.test(base) || /^test_\w+\.py$/.test(base) || /_test\.go$/.test(base) || /\/(__tests__|tests)\//.test(file);
}
var TEST_PATTERNS;
var init_test_file_resolver = __esm(() => {
  TEST_PATTERNS = [
    (dir, name2, ext) => join6(dir, `${name2}.test${ext}`),
    (dir, name2, ext) => join6(dir, `${name2}.spec${ext}`),
    (dir, name2, ext) => join6(dir, "__tests__", `${name2}.test${ext}`),
    (dir, name2, ext) => join6(dir, "__tests__", `${name2}.spec${ext}`),
    (dir, name2, ext) => join6(dir, "tests", `${name2}.test${ext}`),
    (dir, name2, ext) => ext === ".py" ? join6(dir, `test_${name2}${ext}`) : null,
    (dir, name2, ext) => ext === ".py" ? join6(dir, "tests", `test_${name2}${ext}`) : null,
    (dir, name2, ext) => ext === ".go" ? join6(dir, `${name2}_test${ext}`) : null,
    (dir, name2, ext) => ext === ".rs" ? join6(dir, "tests", `${name2}${ext}`) : null
  ];
});

// src/hooks/detectors/import-graph.ts
import { existsSync as existsSync10, lstatSync, readdirSync as readdirSync4, readFileSync as readFileSync8, statSync as statSync3 } from "fs";
import { dirname as dirname6, extname as extname9, join as join7, resolve as resolve3 } from "path";
function stripComments(content) {
  return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function extractRelativeImports(content, filePath) {
  const stripped = stripComments(content);
  const specifiers = [];
  const ext = filePath ? extname9(filePath).toLowerCase() : "";
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
  const dir = dirname6(fromFile);
  const dotMatch = specifier.match(/^(\.+)(.*)/);
  if (!dotMatch)
    return null;
  const dots = dotMatch[1].length;
  const modulePart = dotMatch[2];
  let base = dir;
  for (let i2 = 1;i2 < dots; i2++) {
    base = dirname6(base);
  }
  if (!modulePart) {
    return null;
  }
  const parts2 = modulePart.split(".");
  const candidate = join7(base, ...parts2);
  if (existsSync10(`${candidate}.py`))
    return `${candidate}.py`;
  if (existsSync10(join7(candidate, "__init__.py")))
    return join7(candidate, "__init__.py");
  return null;
}
function resolveRustImport(specifier, fromFile, scanRoot) {
  const dir = dirname6(fromFile);
  if (specifier.startsWith("mod:")) {
    const name2 = specifier.slice(4);
    const asFile = join7(dir, `${name2}.rs`);
    if (existsSync10(asFile))
      return asFile;
    const asDir = join7(dir, name2, "mod.rs");
    if (existsSync10(asDir))
      return asDir;
  } else if (specifier.startsWith("crate:")) {
    const name2 = specifier.slice(6);
    const srcDir = join7(scanRoot, "src");
    const asFile = join7(srcDir, `${name2}.rs`);
    if (existsSync10(asFile))
      return asFile;
    const asDir = join7(srcDir, name2, "mod.rs");
    if (existsSync10(asDir))
      return asDir;
  }
  return null;
}
function getGoModulePath(scanRoot) {
  if (_goModuleCache !== undefined)
    return _goModuleCache;
  try {
    const goMod = readFileSync8(join7(scanRoot, "go.mod"), "utf-8");
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
  const dir = join7(scanRoot, relPath);
  if (existsSync10(dir) && statSync3(dir).isDirectory())
    return dir;
  return null;
}
function resolveImportPath(specifier, fromFile, scanRoot) {
  const fileExt = extname9(fromFile).toLowerCase();
  if (fileExt === ".py") {
    return resolvePythonImport(specifier, fromFile);
  }
  if (fileExt === ".rs" && scanRoot) {
    return resolveRustImport(specifier, fromFile, scanRoot);
  }
  if (fileExt === ".go" && scanRoot) {
    return resolveGoImport(specifier, scanRoot);
  }
  const dir = dirname6(fromFile);
  const raw = resolve3(dir, specifier);
  if (existsSync10(raw) && statSync3(raw).isFile())
    return raw;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const withExt = `${raw}${ext}`;
    if (existsSync10(withExt))
      return withExt;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const index = join7(raw, `index${ext}`);
    if (existsSync10(index))
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
      entries = readdirSync4(current);
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
      const full = join7(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink())
          continue;
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile() && SCAN_EXTS.has(extname9(full))) {
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
  if (!existsSync10(scanRoot))
    return [];
  const clampedDepth = Math.min(Math.max(depth, 1), 3);
  const files = collectFiles(scanRoot);
  const visited = new Set;
  const allImporters = [];
  function findDirectImporters(targetAbs) {
    const direct = [];
    const targetDir = dirname6(targetAbs);
    const targetExt = extname9(targetAbs).toLowerCase();
    for (const file of files) {
      const fileAbs = resolve3(file);
      if (fileAbs === targetAbs)
        continue;
      if (targetExt === ".go" && extname9(file).toLowerCase() === ".go" && dirname6(fileAbs) === targetDir) {
        direct.push(file);
        continue;
      }
      try {
        const content = readFileSync8(file, "utf-8");
        const specifiers = extractRelativeImports(content, file);
        for (const spec of specifiers) {
          const resolved = resolveImportPath(spec, file, scanRoot);
          if (!resolved)
            continue;
          if (extname9(file).toLowerCase() === ".go") {
            if (resolve3(resolved) === targetDir) {
              direct.push(file);
              break;
            }
          } else if (resolve3(resolved) === targetAbs) {
            direct.push(file);
            break;
          }
        }
      } catch {}
    }
    if (targetExt === ".py") {
      const targetName = targetAbs.replace(/\.py$/, "").split("/").pop();
      for (const file of files) {
        const fileAbs = resolve3(file);
        if (fileAbs === targetAbs || direct.includes(file))
          continue;
        if (extname9(file).toLowerCase() !== ".py")
          continue;
        try {
          const content = readFileSync8(file, "utf-8");
          const bareImport = new RegExp(`from\\s+\\.\\s+import\\s+(?:.*\\b${targetName}\\b)`, "m");
          if (bareImport.test(content) && dirname6(fileAbs) === targetDir) {
            direct.push(file);
          }
        } catch {}
      }
    }
    return direct;
  }
  let currentTargets = [resolve3(targetFile)];
  for (let d = 0;d < clampedDepth; d++) {
    const nextTargets = [];
    for (const target of currentTargets) {
      if (visited.has(target))
        continue;
      visited.add(target);
      const direct = findDirectImporters(target);
      for (const imp of direct) {
        const impAbs = resolve3(imp);
        if (!visited.has(impAbs) && impAbs !== resolve3(targetFile)) {
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
var SCAN_EXTS, SKIP_DIRS, MAX_FILE_SIZE, MAX_FILES = 2000, MAX_DEPTH = 50, _goModuleCache;
var init_import_graph = __esm(() => {
  init_test_file_resolver();
  SCAN_EXTS = new Set([
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
  SKIP_DIRS = new Set([
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
  MAX_FILE_SIZE = 256 * 1024;
});

// src/hooks/detectors/security-check.ts
import { existsSync as existsSync11, readFileSync as readFileSync9 } from "fs";
import { basename as basename5, extname as extname10 } from "path";
function detectSecurityPatterns(file) {
  if (isGateDisabled("security-check"))
    return [];
  const ext = extname10(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (!existsSync11(file))
    return [];
  let content;
  try {
    content = readFileSync9(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE5)
    return [];
  const errors = [];
  const lines = content.split(`
`);
  const fileName = file.split("/").pop() ?? "";
  const isTestFile3 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_") || fileName.includes("_test.");
  const starIsComment = JS_TS_EXTS.has(ext) || ext === ".java" || ext === ".kt" || ext === ".cs";
  const hasBlockComments = JS_TS_EXTS.has(ext) || ext === ".java" || ext === ".kt" || ext === ".cs" || ext === ".go" || ext === ".rs";
  let inBlockComment = false;
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
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
    if (!isTestFile3) {
      for (const { re, desc } of SECRET_PATTERNS) {
        if (re.test(scanLine)) {
          if (/process\.env\b/.test(scanLine))
            continue;
          if (/os\.environ/.test(scanLine))
            continue;
          if (/\$\{?\w*ENV\w*\}?/.test(scanLine))
            continue;
          errors.push(`L${i2 + 1}: ${desc}`);
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
        if (suppressFile?.test(basename5(file)))
          continue;
        errors.push(`L${i2 + 1}: ${desc}`);
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
function matchAdvisoryPatterns(file, content) {
  const ext = extname10(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (content.length > MAX_CHECK_SIZE5)
    return [];
  const lines = content.split(`
`);
  const matches = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const trimmed = lines[i2].trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*"))
      continue;
    for (const { re, suppress, desc, exts } of ADVISORY_PATTERNS) {
      if (exts && !exts.has(ext))
        continue;
      if (re.test(lines[i2]) && !suppress?.test(lines[i2])) {
        matches.push({ line: i2 + 1, desc });
      }
    }
  }
  return matches;
}
function getAdvisoryAsPendingFixes(file, content) {
  try {
    const matches = matchAdvisoryPatterns(file, content);
    if (matches.length === 0)
      return [];
    return [
      {
        file,
        gate: "security-check-advisory",
        errors: matches.map((m) => sanitizeForStderr(`L${m.line}: ${m.desc}`.slice(0, 300)))
      }
    ];
  } catch {
    return [];
  }
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
var CHECKABLE_EXTS2, MAX_CHECK_SIZE5 = 500000, SECRET_PATTERNS, JS_TS_EXTS, PY_EXTS3, GO_EXTS2, RB_EXTS, JAVA_EXTS, DANGEROUS_PATTERNS, ADVISORY_PATTERNS;
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
  JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  PY_EXTS3 = new Set([".py", ".pyi"]);
  GO_EXTS2 = new Set([".go"]);
  RB_EXTS = new Set([".rb"]);
  JAVA_EXTS = new Set([".java", ".kt"]);
  DANGEROUS_PATTERNS = [
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
  ADVISORY_PATTERNS = [
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
});

// src/hooks/detectors/semantic-check.ts
import { existsSync as existsSync12, readFileSync as readFileSync10 } from "fs";
import { extname as extname11 } from "path";
function detectEmptyCatch(lines) {
  const errors = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*"))
      continue;
    if (!/\bcatch\b/.test(trimmed))
      continue;
    if (!trimmed.includes("{"))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    if (i2 > 0 && INTENTIONAL_RE.test(lines[i2 - 1]))
      continue;
    const afterBrace = trimmed.slice(trimmed.indexOf("{") + 1);
    if (/^\s*\}/.test(afterBrace)) {
      errors.push(`L${i2 + 1}: Empty catch block \u2014 errors silently swallowed`);
      continue;
    }
    if (afterBrace.trim() === "") {
      const next = lines[i2 + 1]?.trimStart() ?? "";
      if (INTENTIONAL_RE.test(lines[i2 + 1] ?? ""))
        continue;
      if (/^\}/.test(next)) {
        errors.push(`L${i2 + 1}: Empty catch block \u2014 errors silently swallowed`);
      }
    }
  }
  return errors;
}
function detectIgnoredReturn(lines) {
  const errors = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
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
    const nextLine = lines[i2 + 1]?.trimStart() ?? "";
    if (nextLine.startsWith("."))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    errors.push(`L${i2 + 1}: Return value of pure method discarded \u2014 probable no-op (assign or remove)`);
  }
  return errors;
}
function detectConditionAssignment(lines) {
  const errors = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*"))
      continue;
    if (!CONDITION_ASSIGNMENT_RE.test(trimmed))
      continue;
    if (DESTRUCTURE_RE.test(trimmed))
      continue;
    if (INTENTIONAL_RE.test(line))
      continue;
    if (i2 > 0 && INTENTIONAL_RE.test(lines[i2 - 1]))
      continue;
    const condMatch = trimmed.match(/\b(?:if|while)\s*\((.+)\)/);
    if (!condMatch)
      continue;
    const cond = condMatch[1];
    const stripped = cond.replace(/(?:[!=<>]=|=>|===|!==)/g, "");
    if (!stripped.includes("="))
      continue;
    errors.push(`L${i2 + 1}: Assignment (=) inside condition \u2014 use === for comparison`);
  }
  return errors;
}
function detectUnreachableCode(lines) {
  const errors = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*"))
      continue;
    if (!/^\s*(?:return\b|throw\b)/.test(line))
      continue;
    const openBraces = (trimmed.match(/\{/g) ?? []).length;
    const closeBraces = (trimmed.match(/\}/g) ?? []).length;
    if (openBraces > closeBraces)
      continue;
    for (let j = i2 + 1;j < lines.length; j++) {
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
      errors.push(`L${j + 1}: Unreachable code after return/throw at L${i2 + 1}`);
      break;
    }
  }
  return errors;
}
function detectLooseEquality(lines) {
  const errors = [];
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
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
    errors.push(`L${i2 + 1}: Loose equality (== or !=) \u2014 use === or !== for strict comparison`);
  }
  return errors;
}
function detectSwitchFallthrough(lines) {
  const errors = [];
  let inCase = false;
  let caseStartLine = 0;
  let hasBreak = false;
  let hasFallthroughComment = false;
  let hasIntentional = false;
  let hasCode = false;
  let braceDepth = 0;
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    const trimmed = line.trimStart();
    if (CASE_OR_DEFAULT_RE.test(trimmed)) {
      if (inCase && hasCode && !hasBreak && !hasFallthroughComment && !hasIntentional) {
        errors.push(`L${i2 + 1}: Switch case fallthrough from case at L${caseStartLine} \u2014 add break, return, or // fallthrough comment`);
      }
      inCase = true;
      caseStartLine = i2 + 1;
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
function emitPbtAdvisory(file, content) {
  try {
    const fileName = file.split("/").pop() ?? "";
    const isTestFile3 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_");
    if (!isTestFile3)
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
  const ext = extname11(file).toLowerCase();
  if (!CHECKABLE_EXTS3.has(ext))
    return [];
  if (!existsSync12(file))
    return [];
  let content;
  try {
    content = readFileSync10(file, "utf-8");
  } catch {
    return [];
  }
  if (content.length > MAX_CHECK_SIZE6)
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
var JS_TS_EXTS2, PY_EXTS4, CHECKABLE_EXTS3, MAX_CHECK_SIZE6 = 500000, INTENTIONAL_RE, PURE_METHODS_RE, CHAIN_CONTINUATION_RE, CONDITION_ASSIGNMENT_RE, DESTRUCTURE_RE, LOOSE_EQ_RE, NULL_COALESCE_RE, STRING_LITERAL_RE, CASE_OR_DEFAULT_RE, BREAK_RE, FALLTHROUGH_COMMENT_RE, TEST_CASE_RE, PBT_IMPORT_RE;
var init_semantic_check = __esm(() => {
  init_session_state();
  JS_TS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  PY_EXTS4 = new Set([".py", ".pyi"]);
  CHECKABLE_EXTS3 = new Set([...JS_TS_EXTS2, ...PY_EXTS4, ".go", ".rs", ".rb", ".java", ".kt"]);
  INTENTIONAL_RE = /(?:\/\/|\/\*|#)\s*(?:fail-open|intentional|deliberate|nolint|noqa|NOLINT)/i;
  PURE_METHODS_RE = /^\s*(?:[a-zA-Z_$][\w$.]*\s*\.\s*)?(?:map|filter|reduce|flatMap|flat|slice|concat|toSorted|toReversed|toSpliced|replace|replaceAll|trim|trimStart|trimEnd|padStart|padEnd|substring|toLowerCase|toUpperCase)\s*\(/;
  CHAIN_CONTINUATION_RE = /\)\s*\./;
  CONDITION_ASSIGNMENT_RE = /\b(?:if|while)\s*\(.*[^!=<>]=(?!=)[^=]/;
  DESTRUCTURE_RE = /\b(?:const|let|var)\s/;
  LOOSE_EQ_RE = /(?<![!=])(?:==|!=)(?!=)/;
  NULL_COALESCE_RE = /(?:==|!=)\s*null\b/;
  STRING_LITERAL_RE = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/g;
  CASE_OR_DEFAULT_RE = /^\s*(?:case\b|default\s*:)/;
  BREAK_RE = /^\s*(?:break|return|throw|continue)\b/;
  FALLTHROUGH_COMMENT_RE = /(?:\/\/|\/\*)\s*fall\s*-?\s*through/i;
  TEST_CASE_RE = /\b(?:it|test)\s*\(/g;
  PBT_IMPORT_RE = /(?:fast-check|@fast-check|fc\.|property\s*\(|forAll\s*\(|arbitrary)/;
});

// src/hooks/detectors/spec-trace-check.ts
import { existsSync as existsSync13, readFileSync as readFileSync11 } from "fs";
import { basename as basename6, dirname as dirname7, relative } from "path";
function parseVerifyField2(verify) {
  if (!verify?.includes(":"))
    return null;
  const lastColon = verify.lastIndexOf(":");
  const testFile = verify.slice(0, lastColon).trim();
  const testFunction = verify.slice(lastColon + 1).trim();
  if (!testFile || !testFunction)
    return null;
  return { testFile, testFunction };
}
function validateTestFileExists(testFilePath) {
  return existsSync13(testFilePath);
}
function validateTestCoversImpl(testFile, _testFunction, implFile, _projectRoot) {
  if (!existsSync13(testFile))
    return false;
  try {
    const content = readFileSync11(testFile, "utf-8");
    const implBasename = basename6(implFile).replace(/\.[^.]+$/, "");
    const implRelative = relative(dirname7(testFile), implFile).replace(/\\/g, "/").replace(/\.[^.]+$/, "");
    const importPatterns = [
      new RegExp(`(?:import|require).*['"].*${escapeRegex2(implRelative)}(?:\\.[^'"]*)?['"]`, "m"),
      new RegExp(`(?:import|require).*['"].*/${escapeRegex2(implBasename)}(?:\\.[^'"]*)?['"]`, "m")
    ];
    return importPatterns.some((pattern) => pattern.test(content));
  } catch {
    return false;
  }
}
function validateTestFunctionExists(testFile, functionName) {
  if (!existsSync13(testFile))
    return false;
  try {
    const content = readFileSync11(testFile, "utf-8");
    const ext = testFile.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "py") {
      const pyRe = /\bdef\s+(\w+)\s*\(/g;
      for (const m of content.matchAll(pyRe)) {
        if (m[1] === functionName)
          return true;
      }
      return false;
    }
    const jsRe = /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]*)["'`]/g;
    for (const m of content.matchAll(jsRe)) {
      if (m[1] === functionName || m[1]?.includes(functionName))
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
function escapeRegex2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var init_spec_trace_check = () => {};

// src/hooks/detectors/test-quality-check.ts
import { existsSync as existsSync14, readFileSync as readFileSync12 } from "fs";
import { basename as basename7, dirname as dirname8, extname as extname12, resolve as resolve4 } from "path";
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
  const cwd = resolve4(process.cwd());
  const absPath = resolve4(cwd, file);
  if (!absPath.startsWith(cwd))
    return null;
  if (!existsSync14(absPath))
    return null;
  let content;
  try {
    content = readFileSync12(absPath, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_CHECK_SIZE7)
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
    for (let i2 = 0;i2 < lines.length; i2++) {
      const line = lines[i2];
      if (PBT_DEGENERATE_RUNS_RE.test(line)) {
        smells.push({
          type: "pbt-degenerate-runs",
          line: i2 + 1,
          message: "numRuns: 1 defeats the purpose of property-based testing \u2014 increase run count"
        });
      }
      if (PBT_CONSTRAINED_GEN_RE.test(line)) {
        smells.push({
          type: "pbt-constrained-generator",
          line: i2 + 1,
          message: "Generator min equals max \u2014 produces a single constant value, not random input"
        });
      }
    }
  }
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//"))
      continue;
    if (!isPbt) {
      for (const { re, name: name2 } of WEAK_MATCHERS) {
        if (re.test(line)) {
          smells.push({
            type: "weak-matcher",
            line: i2 + 1,
            message: `Weak matcher ${name2} \u2014 consider asserting a specific value`
          });
          break;
        }
      }
    }
    if (TRIVIAL_ASSERTION_RE.test(line)) {
      smells.push({
        type: "trivial-assertion",
        line: i2 + 1,
        message: "Trivial assertion: comparing variable to itself"
      });
    }
    if (EMPTY_TEST_RE.test(line)) {
      smells.push({
        type: "empty-test",
        line: i2 + 1,
        message: "Empty test body \u2014 no assertions"
      });
    }
    if (ALWAYS_TRUE_RE.test(line)) {
      smells.push({
        type: "always-true",
        line: i2 + 1,
        message: "Always-true assertion \u2014 tests a literal, not computed behavior"
      });
    }
    if (CONSTANT_SELF_RE.test(line)) {
      smells.push({
        type: "constant-self",
        line: i2 + 1,
        message: "Constant-to-constant assertion: literal compared to itself"
      });
    }
    if (IMPL_COUPLED_RE.test(line)) {
      smells.push({
        type: "impl-coupled",
        line: i2 + 1,
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
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    if (!inAsyncTest && ASYNC_TEST_RE.test(line)) {
      inAsyncTest = true;
      asyncTestLine = i2 + 1;
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
  for (let i2 = 0;i2 < lines.length; i2++) {
    const line = lines[i2];
    if (MODULE_LET_RE.test(line)) {
      moduleLetCount++;
      if (moduleLetCount === 1) {
        smells.push({
          type: "shared-mutable-state",
          line: i2 + 1,
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
    const snapDir = `${dirname8(absPath)}/__snapshots__/`;
    const snapFile = `${snapDir}${basename7(absPath)}.snap`;
    if (existsSync14(snapFile)) {
      const snapContent = readFileSync12(snapFile, "utf-8");
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
          const implContent = readFileSync12(implFile, "utf-8");
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
        const body2 = codeOnly.slice(prev.start, match.index);
        prev.assertions = (body2.match(assertRe) ?? []).length;
      }
      testBodies.push({ name: match[1], start: match.index, assertions: 0 });
    }
    if (testBodies.length > 0) {
      const last = testBodies[testBodies.length - 1];
      const body2 = codeOnly.slice(last.start);
      last.assertions = (body2.match(assertRe) ?? []).length;
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
function getBlockingTestSmells(file, result) {
  if (result.blockingSmells.length === 0)
    return [];
  return [
    {
      file,
      gate: "test-quality-check",
      errors: result.blockingSmells.map((s) => `L${s.line}: ${s.message}`)
    }
  ];
}
function findImplFile(testPath) {
  try {
    const dir = dirname8(testPath);
    const base = basename7(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve4(dir, implName);
    if (existsSync14(sameDirPath))
      return sameDirPath;
    const parentDir = dirname8(dir);
    const parentPath = resolve4(parentDir, implName);
    if (existsSync14(parentPath))
      return parentPath;
    const srcPath = resolve4(parentDir, "src", implName);
    if (existsSync14(srcPath))
      return srcPath;
    return null;
  } catch {
    return null;
  }
}
function formatTestQualityWarnings(file, result, taskKey) {
  const warnings = [];
  const prefix = taskKey ? `${taskKey}: ` : "";
  if (result.avgAssertions < 2 && !result.isPbt) {
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
      warnings.push(`${prefix}${file}: ${items.length}x ${type} (L${lineNums}${suffix}) \u2014 ${items[0].message}`);
    }
  }
  if (!result.isPbt) {
    const hasPbtSmell = result.smells.some((s) => s.type === "happy-path-only" || s.type === "missing-boundary");
    if (hasPbtSmell) {
      const ext = extname12(file).toLowerCase();
      const JS_TS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
      const PY = new Set([".py", ".pyi"]);
      if (JS_TS.has(ext)) {
        warnings.push(`${prefix}${file}: Consider property-based testing with fast-check: fc.assert(fc.property(fc.integer(), (n) => ...)) to auto-discover edge cases`);
      } else if (PY.has(ext)) {
        warnings.push(`${prefix}${file}: Consider property-based testing with hypothesis: @given(st.integers()) to auto-discover edge cases`);
      } else {
        warnings.push(`${prefix}${file}: Consider property-based testing to auto-discover edge cases and boundary values`);
      }
    }
  }
  return warnings;
}
function suggestPbt(implFile) {
  const name2 = basename7(implFile);
  if (!PBT_CANDIDATE_RE.test(name2))
    return null;
  const testFile = resolveTestFile(implFile);
  if (!testFile || !existsSync14(testFile))
    return null;
  try {
    const stats = __require("fs").statSync(testFile);
    if (stats.size > MAX_CHECK_SIZE7)
      return null;
    const content = readFileSync12(testFile, "utf-8");
    if (PBT_RE.test(content))
      return null;
  } catch {
    return null;
  }
  const relative2 = implFile.split("/").slice(-3).join("/");
  return `${relative2}: Consider property-based testing (fast-check/hypothesis) for validation/serialization logic`;
}
var MAX_CHECK_SIZE7 = 500000, BLOCKING_SMELL_TYPES, ASSERTION_RE, TEST_CASE_RE2, WEAK_MATCHERS, TRIVIAL_ASSERTION_RE, EMPTY_TEST_RE, MOCK_RE, ALWAYS_TRUE_RE, CONSTANT_SELF_RE, SNAPSHOT_RE, IMPL_COUPLED_RE, ASYNC_TEST_RE, AWAIT_RE, MODULE_LET_RE, LARGE_TEST_FILE_LINES = 500, LARGE_SNAPSHOT_CHARS = 5000, PBT_RE, PBT_DEGENERATE_RUNS_RE, PBT_CONSTRAINED_GEN_RE, SETUP_BLOCK_RE, PBT_CANDIDATE_RE;
var init_test_quality_check = __esm(() => {
  init_test_file_resolver();
  BLOCKING_SMELL_TYPES = new Set([
    "empty-test",
    "always-true",
    "trivial-assertion",
    "constant-self"
  ]);
  ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
  TEST_CASE_RE2 = /\b(it|test)\s*\(/g;
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
  ASYNC_TEST_RE = /\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*async\s/;
  AWAIT_RE = /\bawait\b/;
  MODULE_LET_RE = /^let\s+\w+\s*(?:[:=])/;
  PBT_RE = /\b(?:fc\.assert|fc\.property|fast-check|@fast-check\/vitest|hypothesis\.given|@given)\b/;
  PBT_DEGENERATE_RUNS_RE = /numRuns\s*:\s*1\b/;
  PBT_CONSTRAINED_GEN_RE = /fc\.\w+\(\s*\{\s*min\s*:\s*(\d+)\s*,\s*max\s*:\s*\1\s*\}/;
  SETUP_BLOCK_RE = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(/;
  PBT_CANDIDATE_RE = /(?:valid|parse|serial|codec|schema|encode|decode)/i;
});

// src/hooks/respond.ts
function compactStateSummary() {
  try {
    const state = readSessionState();
    const fixes = readPendingFixes();
    const parts2 = [];
    if (fixes.length > 0)
      parts2.push(`${fixes.length} pending fix(es)`);
    parts2.push(state.test_passed_at ? "tests: PASS" : "tests: NOT PASSED");
    parts2.push(state.review_completed_at ? "review: DONE" : "review: NOT DONE");
    const changed = state.changed_file_paths?.length ?? 0;
    if (changed > 0)
      parts2.push(`${changed} file(s) changed`);
    const disabled = state.disabled_gates ?? [];
    if (disabled.length > 0)
      parts2.push(`disabled: ${disabled.map((g) => sanitizeForStderr(g)).join(",")}`);
    return `
[qult state] ${parts2.join(" | ")}`;
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
var init_respond = __esm(() => {
  init_flush();
  init_pending_fixes();
  init_session_state();
});

// src/hooks/post-tool.ts
var exports_post_tool = {};
__export(exports_post_tool, {
  default: () => postTool
});
import { readFileSync as readFileSync13 } from "fs";
import { dirname as dirname9, extname as extname13, resolve as resolve5 } from "path";
async function postTool(ev) {
  const tool = ev.tool_name;
  if (!tool)
    return;
  if (tool === "Edit" || tool === "Write") {
    await handleEditWrite(ev);
  } else if (tool === "Bash") {
    await handleBash(ev);
  }
}
async function handleEditWrite(ev) {
  const rawFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
  if (!rawFile)
    return;
  const file = resolve5(rawFile);
  try {
    const existingFixes = readPendingFixes();
    if (existingFixes.length > 0 && !existingFixes.some((f) => resolve5(f.file) === file)) {
      deny(`Fix existing errors before editing other files (PostToolUse fallback):
${existingFixes.map((f) => `  ${f.file}`).join(`
`)}`);
    }
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
  }
  const config = loadConfig();
  const gates = loadGates();
  const hasWriteGates = !!gates?.on_write;
  const fileExt = extname13(file).toLowerCase();
  const gatedExts = getGatedExtensions();
  const gateEntries = [];
  if (hasWriteGates && gates?.on_write) {
    for (const [name2, gate] of Object.entries(gates.on_write)) {
      if (isGateDisabled(name2))
        continue;
      if (gate.run_once_per_batch && shouldSkipGate(name2, file))
        continue;
      const hasPlaceholder = gate.command.includes("{file}");
      if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt))
        continue;
      gateEntries.push({ name: name2, gate, fileArg: hasPlaceholder ? file : undefined });
    }
  }
  const results = await Promise.allSettled(gateEntries.map((entry) => runGateAsync(entry.name, entry.gate, entry.fileArg)));
  const newFixes = [];
  for (let i2 = 0;i2 < results.length; i2++) {
    const settled = results[i2];
    const entry = gateEntries[i2];
    try {
      if (settled.status === "fulfilled") {
        if (entry.gate.run_once_per_batch) {
          markGateRan(entry.name);
        }
        if (!settled.value.passed) {
          const classified = settled.value.classifiedDiagnostics;
          if (classified?.length) {
            newFixes.push(...classifiedToPendingFixes(classified));
          } else {
            newFixes.push({ file, errors: [settled.value.output], gate: entry.name });
          }
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
    if (exportFixes.length > 0) {
      newFixes.push(...exportFixes);
      try {
        const consumers = findImporters(file, process.cwd());
        for (const consumer of consumers) {
          const removedNames = exportFixes.flatMap((f) => f.errors.map((e) => {
            const m = e.match(/export "(\w+)" was removed/);
            return m ? m[1] : null;
          }).filter(Boolean));
          newFixes.push({
            file: consumer,
            errors: [
              `Consumer may be broken: ${file} removed exports [${removedNames.join(", ")}]. Update imports.`
            ],
            gate: "export-check"
          });
        }
      } catch {}
    }
  } catch {}
  try {
    const plan = getActivePlan();
    if (plan?.tasks) {
      for (const task of plan.tasks) {
        if (!task.verify || !task.file)
          continue;
        if (resolve5(task.file) !== resolve5(file))
          continue;
        const parsed = parseVerifyField2(task.verify);
        if (!parsed)
          continue;
        const absTestFile = resolve5(parsed.testFile);
        if (!validateTestFileExists(absTestFile)) {
          newFixes.push({
            file,
            errors: [`Verify test not found: ${parsed.testFile}. Create the test file first.`],
            gate: "spec-trace-check"
          });
        } else if (!validateTestFunctionExists(absTestFile, parsed.testFunction)) {
          newFixes.push({
            file,
            errors: [
              `Verify test function "${parsed.testFunction}" not found in ${parsed.testFile}. Create the test first.`
            ],
            gate: "spec-trace-check"
          });
        } else if (!validateTestCoversImpl(absTestFile, parsed.testFunction, file, process.cwd())) {
          newFixes.push({
            file,
            errors: [
              `Verify test ${parsed.testFile} does not import ${file}. Test must cover the implementation.`
            ],
            gate: "spec-trace-check"
          });
        }
      }
    }
  } catch {}
  const existingFixKeys = new Set(readPendingFixes().map((f) => `${resolve5(f.file)}:${f.gate}`));
  const fileName = file.split("/").pop() ?? "";
  const isTestFile3 = fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_") || fileName.includes("_test.");
  try {
    const securityFixes = detectSecurityPatterns(file);
    if (securityFixes.length > 0) {
      newFixes.push(...securityFixes);
      if (!isTestFile3 && !existingFixKeys.has(`${file}:security-check`)) {
        const count = incrementEscalation("security_warning_count");
        if (count >= 10) {
          process.stderr.write(`[qult] Security escalation: ${count} security warnings this session. Review security posture.
`);
        }
      }
    }
  } catch {}
  try {
    const dataflowFixes = await detectDataflowIssues(file);
    if (dataflowFixes.length > 0) {
      newFixes.push(...dataflowFixes);
      if (!isTestFile3 && !existingFixKeys.has(`${resolve5(file)}:dataflow-check`)) {
        incrementEscalation("security_warning_count");
      }
    }
  } catch {}
  try {
    if (!isGateDisabled("complexity-check")) {
      const complexityResult = await computeComplexity(file);
      if (complexityResult) {
        cacheComplexityResult(file, complexityResult);
        const relPath = file.split("/").slice(-3).join("/");
        for (const w of complexityResult.warnings) {
          process.stderr.write(`[qult] Complexity advisory: ${relPath}:${w}
`);
        }
      }
    }
  } catch {}
  try {
    const semanticFixes = detectSemanticPatterns(file);
    if (semanticFixes.length > 0) {
      newFixes.push(...semanticFixes);
      if (!isTestFile3 && !existingFixKeys.has(`${file}:semantic-check`)) {
        const count = incrementEscalation("semantic_warning_count");
        if (count >= 8) {
          process.stderr.write(`[qult] Semantic escalation: ${count} semantic warnings this session. Review code for silent failures.
`);
        }
      }
    }
  } catch {}
  try {
    const deadImportWarnings = detectDeadImports(file);
    if (deadImportWarnings.length > 0) {
      let diCount = readSessionState().dead_import_warning_count ?? 0;
      if (!existingFixKeys.has(`${file}:dead-import-check`)) {
        diCount = incrementEscalation("dead_import_warning_count");
      }
      if (diCount >= config.escalation.dead_import_blocking_threshold) {
        newFixes.push({
          file,
          gate: "dead-import-check",
          errors: deadImportWarnings
        });
        process.stderr.write(`[qult] Dead import escalation: ${diCount} warnings exceeded threshold \u2014 promoting to blocking
`);
      } else {
        for (const w of deadImportWarnings) {
          process.stderr.write(`[qult] Dead import: ${w}
`);
        }
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
      if (!existingFixKeys.has(`${file}:duplication-check`)) {
        incrementEscalation("duplication_warning_count");
      }
    }
    const sessionFiles = readSessionState().changed_file_paths ?? [];
    const crossDupWarnings = detectCrossFileDuplication(file, sessionFiles);
    if (crossDupWarnings.length > 0) {
      if (!existingFixKeys.has(`${file}:duplication-check`)) {
        incrementEscalation("duplication_warning_count");
      }
      for (const w of crossDupWarnings) {
        process.stderr.write(`[qult] Duplication: ${w}
`);
      }
    }
  } catch {}
  try {
    if (isTestFile3 && !isGateDisabled("test-quality-check")) {
      const tqResult = analyzeTestQuality(file);
      if (tqResult) {
        const blockingFixes = getBlockingTestSmells(file, tqResult);
        if (blockingFixes.length > 0) {
          newFixes.push(...blockingFixes);
        }
      }
    }
  } catch {}
  try {
    if (!isTestFile3) {
      const pbtSuggestion = suggestPbt(file);
      if (pbtSuggestion) {
        process.stderr.write(`[qult] PBT advisory: ${pbtSuggestion}
`);
      }
    }
  } catch {}
  try {
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
  try {
    if (!isTestFile3 && !isGateDisabled("missing-test-warning")) {
      const testFile = resolveTestFile(file);
      if (!testFile) {
        process.stderr.write(`[qult] missing-test-warning: No test file for ${file}
`);
      }
    }
  } catch {}
  try {
    if (!isGateDisabled("security-check-advisory")) {
      const editCount = incrementFileEditCount(file);
      const projectRoot = resolve5(process.cwd());
      if (editCount >= config.escalation.security_iterative_threshold && file.startsWith(`${projectRoot}/`)) {
        const fileContent = readFileSync13(file, "utf-8");
        const advisoryFixes = getAdvisoryAsPendingFixes(file, fileContent);
        if (advisoryFixes.length > 0) {
          newFixes.push(...advisoryFixes);
          const relative2 = file.split("/").slice(-3).join("/");
          process.stderr.write(`[qult] Iterative security escalation: ${relative2} edited ${editCount} times \u2014 advisory patterns promoted to blocking
`);
        }
      }
    }
  } catch {}
  try {
    const config2 = loadConfig();
    if (config2.gates.consumer_typecheck) {
      const gates2 = loadGates();
      const typecheckGate = gates2?.on_write?.typecheck;
      if (typecheckGate?.run_once_per_batch) {} else if (typecheckGate) {
        const importers = findImporters(file, process.cwd(), config2.gates.import_graph_depth);
        const consumerResults = await Promise.allSettled(importers.map((imp) => runGateAsync("typecheck", typecheckGate, imp)));
        for (let ci = 0;ci < consumerResults.length; ci++) {
          const cr = consumerResults[ci];
          if (cr.status === "fulfilled" && !cr.value.passed) {
            const classified = cr.value.classifiedDiagnostics;
            if (classified?.length) {
              newFixes.push(...classifiedToPendingFixes(classified));
            } else {
              newFixes.push({ file: importers[ci], errors: [cr.value.output], gate: "typecheck" });
            }
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
      const gateParts = gateEntries.map((entry, i2) => {
        const settled = results[i2];
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
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve5(cwd, t.file)));
  const unplannedCount = changed.filter((f) => !planFiles.has(f)).length;
  const planTaskCount = plan.tasks.filter((t) => t.file).length;
  const overEngThreshold = loadConfig().review.required_changed_files;
  if (unplannedCount > overEngThreshold || totalChanged > planTaskCount * 2) {
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
    return `go test -v -run . ${shellEscape(dirname9(testFile))}`;
  }
  if (/\bmocha\b/.test(testCommand)) {
    return `${testCommand} ${escaped}`;
  }
  return null;
}
async function handleBash(ev) {
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
  if (INSTALL_CMD_RE.test(command)) {
    try {
      await onInstallCommand(command);
    } catch {}
  }
}
async function onInstallCommand(command) {
  const parsed = extractInstalledPackages(command);
  if (!parsed)
    return;
  const cwd = process.cwd();
  if (!isGateDisabled("hallucinated-package-check") && parsed.packages.length > 0) {
    try {
      const hallucinationFixes = await checkInstalledPackages(parsed.pm, parsed.packages);
      if (hallucinationFixes.length > 0) {
        addPendingFixes("(install-command)", hallucinationFixes);
      }
    } catch {}
  }
  if (!isGateDisabled("dep-vuln-check")) {
    try {
      const vulnFixes = scanDependencyVulns(cwd);
      if (vulnFixes.length > 0) {
        addPendingFixes("(dep-vuln)", vulnFixes);
      }
    } catch {}
  }
}
function onGitCommit() {
  clearOnCommit();
  const gates = loadGates();
  if (!gates?.on_commit)
    return;
  const config = loadConfig();
  const coverageThreshold = config.gates.coverage_threshold;
  for (const [name2, gate] of Object.entries(gates.on_commit)) {
    try {
      if (isGateDisabled(name2))
        continue;
      if (name2 === "coverage" && coverageThreshold > 0) {
        const result = runCoverageGate(name2, gate, coverageThreshold);
        if (!result.passed) {
          addPendingFixes("__commit__", [
            { file: "__commit__", errors: [result.output], gate: name2 }
          ]);
        }
        continue;
      }
      runGate(name2, gate);
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
      for (const [name2, gate] of Object.entries(gates.on_write)) {
        if (isGateDisabled(name2))
          continue;
        const hasPlaceholder = gate.command.includes("{file}");
        if (!hasPlaceholder)
          continue;
        try {
          const result = runGate(name2, gate, fix.file);
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
var planWarnedAt, GIT_COMMIT_RE, LINT_FIX_RE, TEST_CMD_RE, INSTALL_CMD_RE;
var init_post_tool = __esm(() => {
  init_config();
  init_load();
  init_runner();
  init_pending_fixes();
  init_plan_status();
  init_session_state();
  init_complexity_check();
  init_convention_check();
  init_dataflow_check();
  init_dead_import_check();
  init_dep_vuln_check();
  init_diagnostic_classifier();
  init_duplication_check();
  init_export_check();
  init_hallucinated_package_check();
  init_import_check();
  init_import_graph();
  init_security_check();
  init_semantic_check();
  init_spec_trace_check();
  init_test_file_resolver();
  init_test_quality_check();
  init_respond();
  planWarnedAt = new Set;
  GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
  LINT_FIX_RE = /\b(biome\s+(check|lint).*--(fix|write)|biome\s+format|eslint.*--fix|prettier.*--write|ruff\s+check.*--fix|ruff\s+format|gofmt|go\s+fmt|cargo\s+fmt|autopep8|black)\b/;
  TEST_CMD_RE = /\b(bun\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/;
  INSTALL_CMD_RE = /\b(npm\s+(?:install|i|add)|pip\s+install|cargo\s+add|go\s+get|bun\s+add|yarn\s+add|pnpm\s+add|gem\s+install|composer\s+require)\b/;
});

// src/hooks/pre-tool.ts
var exports_pre_tool = {};
__export(exports_pre_tool, {
  default: () => preTool
});
import { resolve as resolve6 } from "path";
async function preTool(ev) {
  const tool = ev.tool_name;
  if (tool === "EnterPlanMode") {
    checkEnterPlanMode();
  } else if (tool === "ExitPlanMode") {
    checkExitPlanMode();
  } else if (tool === "Edit" || tool === "Write") {
    checkEditWrite(ev);
  } else if (tool === "Bash") {
    checkBash(ev);
  }
}
function checkEnterPlanMode() {
  deny("Use /qult:plan-generator instead of entering plan mode directly. " + "Manual plans bypass plan-evaluator validation. " + "Run /qult:plan-generator to create a structured, evaluated plan.");
}
function checkExitPlanMode() {
  if (wasPlanSelfcheckBlocked())
    return;
  const scores = getPlanEvalScoreHistory();
  if (scores.length > 0) {
    const lastScore = scores[scores.length - 1];
    if (lastScore >= loadConfig().plan_eval.score_threshold)
      return;
  }
  recordPlanSelfcheckBlocked();
  deny("Before finalizing the plan, review the entire session from start to now for omissions. " + "Check: missing files, untested edge cases, migration concerns, documentation gaps, " + "dependency changes, and anything discussed but not included in the plan. " + "After your review, call ExitPlanMode again.");
}
function checkEditWrite(ev) {
  const targetFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
  if (!targetFile)
    return;
  const resolvedTarget = resolve6(targetFile);
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const isFixingPendingFile = fixes.some((f) => resolve6(f.file) === resolvedTarget);
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
    const taskFile = resolve6(cwd, task.file);
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
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve6(cwd, t.file)));
  if (planFiles.has(resolvedTarget))
    return;
  const relative2 = resolvedTarget.startsWith(cwd) ? resolvedTarget.slice(cwd.length + 1) : resolvedTarget;
  process.stderr.write(`[qult] Task drift: ${sanitizeForStderr(relative2)} is not in the current plan scope.
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
    const implFile = resolve6(cwd, task.file);
    if (resolvedTarget !== implFile)
      continue;
    const testFile = resolve6(cwd, parsed.file);
    if (resolvedTarget === testFile)
      return;
    if (!changed.includes(testFile)) {
      deny(`TDD enforcement: \u30C6\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB ${parsed.file} \u3092\u5148\u306B\u7DE8\u96C6\u3057\u3066\u304F\u3060\u3055\u3044\uFF08RED\u2192GREEN\u2192REFACTOR\uFF09\u3002\u5B9F\u88C5\u30D5\u30A1\u30A4\u30EB ${task.file} \u306F\u30C6\u30B9\u30C8\u7DE8\u96C6\u5F8C\u306B\u7DE8\u96C6\u3067\u304D\u307E\u3059\u3002`);
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
      process.stderr.write(`[qult] Advisory: ${changedCount} files changed without a plan. Consider using /qult:explore for complex changes.
`);
    }
    if (!readLastReview()) {
      if (isReviewRequired() && !isGateDisabled("review")) {
        deny("Run /qult:review before committing. Independent review is required.");
      }
    }
    if (hasPlanFile() && !wasFinishStarted()) {
      deny("Plan is active. Use /qult:finish for structured branch completion. " + "Direct commits bypass the completion checklist (merge/PR/hold/discard). " + "/qult:finish will handle the commit after the checklist passes.");
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
  default: () => stop2
});
async function stop2(ev) {
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
    const failed = [];
    for (const t of doneTasks) {
      const key = t.taskNumber != null ? `Task ${t.taskNumber}` : t.name;
      const result = readTaskVerifyResult(key);
      if (result !== null) {
        tracked.push(t);
        if (result.passed !== true) {
          failed.push({ task: t, key });
        }
      } else {
        untracked.push(t);
      }
    }
    if (failed.length > 0) {
      const list = failed.map((f) => `  ${f.key}: ${f.task.name}`).join(`
`);
      block(`${failed.length} plan task(s) have failing Verify tests:
${list}
Fix tests before finishing.`);
    }
    if (untracked.length > 0) {
      const list = untracked.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name}`).join(`
`);
      process.stderr.write(`[qult] ${untracked.length} plan task(s) have Verify fields but were not tracked via TaskCreate:
${list}
Consider using TaskCreate for Verify test execution.
`);
    }
    const doneNoVerify = plan.tasks.filter((t) => t.status === "done" && t.file && !t.verify);
    if (doneNoVerify.length > 0) {
      const list = doneNoVerify.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name} (File: ${t.file})`).join(`
`);
      process.stderr.write(`[qult] ${doneNoVerify.length} completed task(s) have File but no Verify field \u2014 add test verification for spec compliance:
${list}
`);
    }
  }
  if (hasSourceChanges2) {
    if (!plan) {
      const changed = state.changed_file_paths.length;
      const threshold = loadConfig().review.required_changed_files;
      if (changed >= threshold) {
        process.stderr.write(`[qult] Advisory: ${changed} files changed without a plan. Consider using /qult:explore for complex changes.
`);
      }
    }
    if (!readLastReview()) {
      if (isReviewRequired() && !isGateDisabled("review") && getReviewIteration() === 0) {
        block("Run /qult:review before finishing. Independent review is required.");
      }
    }
  }
  const lastReview = readLastReview();
  if (hasSourceChanges2 && lastReview) {
    const config = loadConfig();
    if (config.review.require_human_approval && !readHumanApproval()) {
      block("Human approval required. The architect must review the changes and call record_human_approval before finishing.");
    }
  }
  if (lastReview) {
    process.stderr.write(`[qult] Review complete. Run /qult:finish for structured branch completion (merge/PR/hold/discard).
`);
  }
  const escalation = loadConfig().escalation;
  const securityCount = readEscalation("security_warning_count");
  if (securityCount >= escalation.security_threshold && !isGateDisabled("security-check")) {
    block(`${securityCount} security warnings emitted this session. Fix security issues before finishing.`);
  }
  const driftCount = readEscalation("drift_warning_count");
  if (driftCount >= escalation.drift_threshold) {
    block(`${driftCount} drift warnings emitted this session. Review scope and address drift before finishing.`);
  }
  const testQualityCount = readEscalation("test_quality_warning_count");
  if (testQualityCount >= escalation.test_quality_threshold) {
    block(`${testQualityCount} test quality warnings emitted this session. Improve test assertions before finishing.`);
  }
  const duplicationCount = readEscalation("duplication_warning_count");
  if (duplicationCount >= escalation.duplication_threshold) {
    block(`${duplicationCount} duplication warnings emitted this session. Extract shared code before finishing.`);
  }
  const semanticCount = readEscalation("semantic_warning_count");
  if (semanticCount >= escalation.semantic_threshold && !isGateDisabled("semantic-check")) {
    block(`${semanticCount} semantic warnings emitted this session. Fix silent failure patterns before finishing.`);
  }
}
var SOURCE_EXTS2;
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

// src/hooks/subagent-stop/claim-grounding.ts
import { existsSync as existsSync15, readFileSync as readFileSync14, statSync as statSync4 } from "fs";
import { join as join8 } from "path";
function groundClaims(output, cwd) {
  try {
    const ungrounded = [];
    let total = 0;
    for (const match of output.matchAll(FINDING_FILE_RE)) {
      total++;
      const filePath = match[2];
      const description = match[4] ?? "";
      const absPath = join8(cwd, filePath);
      const normalizedCwd = cwd.replace(/\/+$/, "");
      if (!absPath.startsWith(`${normalizedCwd}/`)) {
        ungrounded.push(`Path traversal rejected: ${filePath}`);
        continue;
      }
      if (!existsSync15(absPath)) {
        ungrounded.push(`File not found: ${filePath}`);
        continue;
      }
      let fileContent = null;
      for (const funcMatch of description.matchAll(FUNC_REF_RE)) {
        const funcName = funcMatch[1];
        if (!fileContent) {
          try {
            const size = statSync4(absPath).size;
            if (size > MAX_FILE_SIZE2)
              break;
            fileContent = readFileSync14(absPath, "utf-8");
          } catch {
            break;
          }
        }
        const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wordRe = new RegExp(`\\b${escaped}\\b`);
        if (!wordRe.test(fileContent)) {
          ungrounded.push(`Symbol \`${funcName}\` not found in ${filePath}`);
        }
      }
    }
    return { total, ungrounded };
  } catch {
    return { total: 0, ungrounded: [] };
  }
}
var FINDING_FILE_RE, FUNC_REF_RE, MAX_FILE_SIZE2 = 500000;
var init_claim_grounding = __esm(() => {
  FINDING_FILE_RE = /\[(critical|high|medium|low)\]\s+((?:[^\s:]+\/[^\s:]+|[^\s:]+\.\w{1,5}))(?::(\d+))?\s+[\u2014\u2013]\s+(.+?)(?:\n|$)/gi;
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
    } else if (stageName === "Adversarial") {
      checkAdversarialContradiction(output, contradictions);
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
    const testQuality = state.test_quality_warning_count ?? 0;
    const duplication = state.duplication_warning_count ?? 0;
    const totalWarnings = deadImports + driftWarnings + testQuality + duplication;
    if (totalWarnings < 5)
      return;
    if (deadImports >= 5) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${deadImports} dead-import warnings`);
    }
    if (driftWarnings >= 5) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${driftWarnings} convention drift warnings`);
    }
    if (testQuality >= 5) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${testQuality} test quality warnings`);
    }
    if (duplication >= 5) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${duplication} duplication warnings`);
    }
    if (contradictions.length === 0 && totalWarnings >= 5) {
      contradictions.push(`Quality reviewer declared "No issues found" but session has ${totalWarnings} total quality warnings (dead-imports: ${deadImports}, drift: ${driftWarnings}, test-quality: ${testQuality}, duplication: ${duplication})`);
    }
  } catch {}
}
function checkAdversarialContradiction(output, contradictions) {
  if (!NO_ISSUES_RE.test(output))
    return;
  try {
    const state = readSessionState();
    const semanticWarnings = state.semantic_warning_count ?? 0;
    const testQuality = state.test_quality_warning_count ?? 0;
    if (semanticWarnings >= 3) {
      contradictions.push(`Adversarial reviewer declared "No issues found" but session has ${semanticWarnings} semantic warnings (silent failures)`);
    }
    if (testQuality >= 3) {
      contradictions.push(`Adversarial reviewer declared "No issues found" but session has ${testQuality} test quality warnings`);
    }
  } catch {}
}
function crossValidateReviewers(stageScores) {
  try {
    const contradictions = [];
    const spec = stageScores.Spec;
    const quality = stageScores.Quality;
    if (spec?.completeness === 5 && quality?.design != null && quality.design <= 2) {
      contradictions.push("Spec rated Completeness=5 but Quality rated Design\u22642 \u2014 fully complete code with poor design warrants investigation");
    }
    return contradictions;
  } catch {
    return [];
  }
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
  for (const [name2, score] of Object.entries(dimensions)) {
    if (!weakest || score < weakest.score) {
      weakest = { name: name2, score };
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
    return `${header} Score improved ${prev}\u2192${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
  }
  if (trend === "regressing" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score regressed ${prev}\u2192${aggregate}. Last changes introduced new issues \u2014 revert recent ${weakest.name.toLowerCase()}-related changes and take a minimal approach.`;
  }
  if (history.length >= 2) {
    return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working \u2014 try a fundamentally different structure.`;
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
    return `${header} Score improved ${prev}\u2192${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
  }
  if (trend === "regressing" && history.length >= 2) {
    const prev = history[history.length - 2];
    return `${header} Score regressed ${prev}\u2192${aggregate}. Last revision made the plan worse \u2014 revert recent changes to ${weakest.name.toLowerCase()} and try a different approach.`;
  }
  if (history.length >= 2) {
    return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working \u2014 restructure the plan differently.`;
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
  for (let i2 = 0;i2 < taskHeaders.length; i2++) {
    const start2 = taskHeaders[i2].index;
    const end = i2 + 1 < taskHeaders.length ? taskHeaders[i2 + 1].index : tasksContent.length;
    const block2 = tasksContent.slice(start2, end);
    const taskNum = taskHeaders[i2][1];
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
  for (let i2 = 0;i2 < taskHeaders.length; i2++) {
    const start2 = taskHeaders[i2].index;
    const end = i2 + 1 < taskHeaders.length ? taskHeaders[i2 + 1].index : tasksContent.length;
    taskBlocks.push({ num: taskHeaders[i2][1], block: tasksContent.slice(start2, end) });
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
function escapeRegex3(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDimensionScore(output, name2) {
  const re = new RegExp(`${escapeRegex3(name2)}[=:]\\s*(\\d+)`, "i");
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
import { execSync as execSync3 } from "child_process";
import { existsSync as existsSync16, readdirSync as readdirSync5, readFileSync as readFileSync15, statSync as statSync5 } from "fs";
import { join as join9, normalize } from "path";
function checkReadOnlyViolation(normalized) {
  if (!READ_ONLY_REVIEWERS.has(normalized))
    return;
  try {
    const state = readSessionState();
    if (state.last_commit_at) {
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
    }
    if (state.changed_file_paths.length > 0) {
      const diffOutput = execSync3("git diff --name-only", {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      if (diffOutput) {
        const diffFiles = new Set(diffOutput.split(`
`).filter(Boolean));
        const knownRelative = new Set(state.changed_file_paths.map((p) => {
          if (p.startsWith("/")) {
            try {
              const cwd = process.cwd();
              return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
            } catch {
              return p;
            }
          }
          return p;
        }));
        const newFiles = [...diffFiles].filter((f) => !knownRelative.has(f));
        if (newFiles.length > 0) {
          block(`${normalized} violated read-only constraint: uncommitted changes detected in files not tracked before review: ${newFiles.slice(0, 5).join(", ")}. ` + "Reviewers must NOT modify files. Restore with `git checkout -- <file>` and rerun the review.");
        }
      }
    }
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
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
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
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
    const planDir = join9(process.cwd(), ".claude", "plans");
    if (!existsSync16(planDir))
      return;
    const files = readdirSync5(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync5(join9(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return;
    const content = readFileSync15(join9(planDir, files[0].name), "utf-8");
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
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
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
    const floor = loadConfig().review.dimension_floor;
    const belowFloor = Object.entries(scoreEntries).filter(([, v]) => typeof v === "number" && v < floor);
    if (belowFloor.length > 0) {
      const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      const dims = belowFloor.map(([name2, score]) => `${capitalize(name2)} (${score}/5)`).join(", ");
      block(`${stageName}: PASS but ${dims} below minimum ${floor}/5. Fix these dimensions and re-run /qult:review.`);
    }
    try {
      recordStageScores(stageName, scoreEntries);
    } catch {}
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
    } catch (err2) {
      if (err2 instanceof Error && err2.message.startsWith("process.exit"))
        throw err2;
    }
    try {
      const cv = crossValidate(output, stageName);
      if (cv.contradictions.length > 0) {
        block(`${stageName}: cross-validation contradiction(s):
${cv.contradictions.map((c) => `  - ${c}`).join(`
`)}
Reconcile findings and re-run /qult:review.`);
      }
    } catch (err2) {
      if (err2 instanceof Error && err2.message.startsWith("process.exit"))
        throw err2;
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
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
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
    const dims = belowThreshold.map(([name2, score]) => `${name2} (${score}/5)`).join(", ");
    block(`${stageName}: ${dims} scored below 4/5 but no findings cited. Low scores must include at least one [severity] file \u2014 description finding as evidence. Rerun the review with concrete findings.`);
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
          msg += ` Score improved ${prev}\u2192${aggregate}. Focus on: ${weakest.name} (${weakest.score}/5).`;
        } else if (trend === "regressing" && history.length >= 2) {
          const prev = history[history.length - 2];
          msg += ` Score regressed ${prev}\u2192${aggregate}. Revert recent ${weakest.name.toLowerCase()}-related changes.`;
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
  } catch (err2) {
    if (err2 instanceof Error && err2.message.startsWith("process.exit"))
      throw err2;
  }
}
function extractFindings(output, stageName) {
  const findingRe = /\[(critical|high|medium|low)\]\s*(\S+?)(?::\d+)?\s+(?:[\u2014\u2013]|\s-\s)\s*(.+?)(?:\n|$)/gi;
  for (const match of output.matchAll(findingRe)) {
    _currentFindings.push({
      file: normalize(match[2]),
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
  try {
    const db = getDb();
    const pid = getProjectId();
    const insert = db.prepare("INSERT INTO review_findings (project_id, file, severity, description, stage) VALUES (?, ?, ?, ?, ?)");
    for (const f of _currentFindings) {
      insert.run(pid, f.file, f.severity, f.description, f.stage);
    }
    db.prepare(`DELETE FROM review_findings WHERE project_id = ? AND id NOT IN (
				SELECT id FROM review_findings WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`).run(pid, pid, MAX_FINDINGS);
    const rows = db.prepare("SELECT file, severity, description, stage, recorded_at FROM review_findings WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(pid, MAX_FINDINGS);
    const history = rows.map((r) => ({
      file: r.file,
      severity: r.severity,
      description: r.description,
      stage: r.stage,
      timestamp: r.recorded_at
    }));
    _currentFindings = [];
    return history;
  } catch {
    _currentFindings = [];
    return null;
  }
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
var READ_ONLY_REVIEWERS, SEVERITY_PATTERN, FINDING_RE, NO_ISSUES_RE2, SPEC_PASS_RE, SPEC_FAIL_RE, QUALITY_PASS_RE, QUALITY_FAIL_RE, SECURITY_PASS_RE, SECURITY_FAIL_RE, ADVERSARIAL_PASS_RE, ADVERSARIAL_FAIL_RE, PLAN_PASS_RE, PLAN_REVISE_RE, ALL_STAGES, MAX_FINDINGS = 100, _currentFindings;
var init_agent_validators = __esm(() => {
  init_config();
  init_db();
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
  crossValidateReviewers: () => crossValidateReviewers,
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

// src/hooks/task-completed.ts
var exports_task_completed = {};
__export(exports_task_completed, {
  default: () => taskCompleted,
  checkVerifyTestQuality: () => checkVerifyTestQuality
});
import { spawnSync } from "child_process";
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
  const args2 = argsBuilder(parsed.file, parsed.testName);
  const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;
  try {
    const config = loadConfig();
    const verifyTimeout = config.gates.test_on_edit_timeout ?? DEFAULT_VERIFY_TIMEOUT;
    const extraPath = config.gates.extra_path.filter((p) => !p.includes(":")).map((p) => p.startsWith("/") ? p : `${process.cwd()}/${p}`).join(":");
    const pathPrefix = extraPath ? `${extraPath}:` : "";
    const result = spawnSync(args2[0], args2.slice(1), {
      cwd: process.cwd(),
      timeout: verifyTimeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${pathPrefix}${process.cwd()}/node_modules/.bin:${process.env.PATH}`
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
var TEST_RUNNER_RE, DEFAULT_VERIFY_TIMEOUT = 15000, SAFE_SHELL_ARG_RE;
var init_task_completed = __esm(() => {
  init_config();
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

// src/gates/detect.ts
import { existsSync as existsSync17, readFileSync as readFileSync16 } from "fs";
import { join as join10 } from "path";
function isReachable(exe, root) {
  if (!/^[a-zA-Z0-9_-]+$/.test(exe))
    return false;
  const nodeModulesBin = join10(root, "node_modules", ".bin", exe);
  if (existsSync17(nodeModulesBin))
    return true;
  try {
    const { execFileSync: execFileSync2 } = __require("child_process");
    execFileSync2("/bin/sh", ["-c", `command -v ${exe}`], {
      encoding: "utf-8",
      stdio: "pipe"
    });
    return true;
  } catch {
    return false;
  }
}
var init_detect = () => {};

// src/state/metrics.ts
function recordSessionMetrics(metrics) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    db.prepare(`INSERT INTO session_metrics (session_id, project_id, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(metrics.session_id, projectId, metrics.gate_failures, metrics.security_warnings, metrics.review_score, metrics.files_changed, metrics.test_quality_warnings ?? 0, metrics.duplication_warnings ?? 0, metrics.semantic_warnings ?? 0, metrics.drift_warnings ?? 0, metrics.escalation_hit ? 1 : 0);
    db.prepare(`DELETE FROM session_metrics WHERE project_id = ? AND id NOT IN (
				SELECT id FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`).run(projectId, projectId, MAX_ENTRIES);
  } catch {}
}
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
function applyFlywheelRecommendations(recs, config) {
  const applied = [];
  const deferred = [];
  if (!config.flywheel.auto_apply) {
    return { applied: [], deferred: recs };
  }
  try {
    const db = getDb();
    for (const rec of recs) {
      if (rec.direction !== "raise") {
        deferred.push(rec);
        continue;
      }
      const configKey = METRIC_NAME_TO_CONFIG_KEY[rec.metric];
      if (!configKey) {
        deferred.push(rec);
        continue;
      }
      const existing = db.prepare("SELECT value FROM global_configs WHERE key = ?").get(configKey);
      if (existing) {
        deferred.push(rec);
        continue;
      }
      db.prepare("INSERT INTO global_configs (key, value) VALUES (?, ?)").run(configKey, JSON.stringify(rec.suggested_threshold));
      applied.push(rec);
    }
  } catch {
    return { applied: [], deferred: recs };
  }
  return { applied, deferred };
}
function detectRecurringPatterns() {
  try {
    const history = readMetricsHistory();
    if (history.length < 5)
      return;
    const recent = history.slice(0, 5);
    const gateFailSessions = recent.filter((s) => s.gate_failures > 0).length;
    if (gateFailSessions >= 4) {
      const totalGateFailures = recent.reduce((sum, s) => sum + s.gate_failures, 0);
      const avgFailures = (totalGateFailures / recent.length).toFixed(1);
      process.stderr.write(`[qult] Pattern: gate failures in ${gateFailSessions}/5 recent sessions (avg ${avgFailures}/session). Review toolchain or add .claude/rules/ entries.
`);
    }
    const secWarnSessions = recent.filter((s) => s.security_warnings > 0).length;
    if (secWarnSessions >= 4) {
      const totalSecWarnings = recent.reduce((sum, s) => sum + s.security_warnings, 0);
      process.stderr.write(`[qult] Pattern: ${totalSecWarnings} security warnings across ${secWarnSessions}/5 recent sessions. Consider adding .claude/rules/ for security patterns.
`);
    }
  } catch {}
}
var MAX_ENTRIES = 50, METRIC_KEYS, WINDOW_SIZES, METRIC_TO_THRESHOLD, METRIC_NAME_TO_CONFIG_KEY, RULE_TEMPLATES;
var init_metrics = __esm(() => {
  init_db();
  METRIC_KEYS = [
    "gate_failures",
    "security_warnings",
    "test_quality_warnings",
    "duplication_warnings",
    "semantic_warnings",
    "drift_warnings"
  ];
  WINDOW_SIZES = [5, 10, 20];
  METRIC_TO_THRESHOLD = {
    security_warnings: { key: "security_threshold", name: "security" },
    test_quality_warnings: { key: "test_quality_threshold", name: "test quality" },
    duplication_warnings: { key: "duplication_threshold", name: "duplication" },
    semantic_warnings: { key: "semantic_threshold", name: "semantic" },
    drift_warnings: { key: "drift_threshold", name: "drift" }
  };
  METRIC_NAME_TO_CONFIG_KEY = {
    security: "escalation.security_threshold",
    "test quality": "escalation.test_quality_threshold",
    duplication: "escalation.duplication_threshold",
    semantic: "escalation.semantic_threshold",
    drift: "escalation.drift_threshold"
  };
  RULE_TEMPLATES = {
    security: {
      filename: "security-recurring.md",
      content: [
        "# Security Recurring Patterns",
        "",
        "Security warnings are frequent across multiple projects.",
        "Review common patterns: input validation, XSS prevention, SQL injection, SSRF.",
        "Consider adding project-specific security rules in .claude/rules/security.md."
      ].join(`
`)
    },
    test_quality: {
      filename: "test-quality-recurring.md",
      content: [
        "# Test Quality Recurring Patterns",
        "",
        "Test quality warnings are frequent across multiple projects.",
        "Review: empty tests, always-true assertions, trivial assertions.",
        "Consider enforcing minimum assertion counts per test."
      ].join(`
`)
    },
    duplication: {
      filename: "duplication-recurring.md",
      content: [
        "# Duplication Recurring Patterns",
        "",
        "Code duplication warnings are frequent across multiple projects.",
        "Review: copy-pasted code blocks, similar function signatures.",
        "Consider extracting shared utilities when 3+ duplicates exist."
      ].join(`
`)
    }
  };
});

// src/hooks/session-start.ts
var exports_session_start = {};
__export(exports_session_start, {
  default: () => sessionStart
});
import { existsSync as existsSync18 } from "fs";
import { join as join11 } from "path";
async function sessionStart(ev) {
  try {
    if (!_legacyWarned) {
      _legacyWarned = true;
      const cwd = ev.cwd ?? process.cwd();
      if (existsSync18(join11(cwd, ".qult"))) {
        process.stderr.write(`[qult] Legacy .qult/ directory detected. State is now stored in ~/.qult/qult.db. You can safely delete .qult/ from this project.
`);
      }
    }
    if (ev.source === "startup" || ev.source === "clear") {
      const cfg = loadConfig();
      try {
        const prevState = readSessionState();
        const gateFailures = Object.values(prevState.gate_failure_counts ?? {}).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
        if (gateFailures > 0 || (prevState.security_warning_count ?? 0) > 0 || (prevState.changed_file_paths ?? []).length > 0) {
          recordSessionMetrics({
            session_id: ev.session_id ?? "unknown",
            timestamp: new Date().toISOString(),
            gate_failures: gateFailures,
            security_warnings: prevState.security_warning_count ?? 0,
            review_score: prevState.review_completed_at ? Array.isArray(prevState.review_score_history) ? prevState.review_score_history.slice(-1)[0] ?? null : null : null,
            files_changed: (prevState.changed_file_paths ?? []).length,
            test_quality_warnings: prevState.test_quality_warning_count ?? 0,
            duplication_warnings: prevState.duplication_warning_count ?? 0,
            semantic_warnings: prevState.semantic_warning_count ?? 0,
            drift_warnings: prevState.drift_warning_count ?? 0,
            escalation_hit: (prevState.security_warning_count ?? 0) >= cfg.escalation.security_threshold || (prevState.test_quality_warning_count ?? 0) >= cfg.escalation.test_quality_threshold || (prevState.duplication_warning_count ?? 0) >= cfg.escalation.duplication_threshold || (prevState.semantic_warning_count ?? 0) >= cfg.escalation.semantic_threshold || (prevState.drift_warning_count ?? 0) >= cfg.escalation.drift_threshold
          });
        }
        detectRecurringPatterns();
      } catch {}
      try {
        if (cfg.flywheel.enabled) {
          const hist = readMetricsHistory();
          const recs = getFlywheelRecommendations(hist, cfg);
          for (const rec of recs) {
            process.stderr.write(`[qult] Flywheel: ${rec.metric} \u2014 suggest ${rec.direction === "lower" ? "lowering" : "raising"} threshold from ${rec.current_threshold} to ${rec.suggested_threshold} (${rec.confidence} confidence). ${rec.reason}
`);
          }
          if (cfg.flywheel.auto_apply && recs.length > 0) {
            try {
              const { applied, deferred } = applyFlywheelRecommendations(recs, cfg);
              for (const rec of applied) {
                process.stderr.write(`[qult] Flywheel auto-applied: ${rec.metric} threshold raised to ${rec.suggested_threshold}
`);
              }
              if (deferred.length > 0) {
                process.stderr.write(`[qult] Flywheel deferred: ${deferred.length} recommendation(s) require manual review
`);
              }
            } catch {}
          }
        }
      } catch {}
      writePendingFixes([]);
      try {
        flush();
      } catch {}
      if (ev.source === "startup") {
        try {
          if (cfg.security.require_semgrep && !isGateDisabled("semgrep-required") && !isReachable("semgrep", ev.cwd ?? process.cwd())) {
            addPendingFixes("(global)", [
              {
                file: "(global)",
                gate: "semgrep-required",
                errors: [
                  "Semgrep is required but not installed. Install: `brew install semgrep` or `pip install semgrep`. To skip: /qult:skip semgrep-required"
                ]
              }
            ]);
            try {
              flush();
            } catch {}
          }
        } catch {}
        try {
          if (cfg.security.require_osv_scanner && !isGateDisabled("dep-vuln-check") && !isReachable("osv-scanner", ev.cwd ?? process.cwd())) {
            addPendingFixes("(global)", [
              {
                file: "(global)",
                gate: "dep-vuln-check",
                errors: [
                  "osv-scanner is required but not installed. Install: `brew install osv-scanner`. To skip: /qult:skip dep-vuln-check"
                ]
              }
            ]);
            try {
              flush();
            } catch {}
          }
        } catch {}
        try {
          if (!isGateDisabled("dep-vuln-check")) {
            const cwd = ev.cwd ?? process.cwd();
            const vulnFixes = scanDependencyVulns(cwd);
            if (vulnFixes.length > 0) {
              addPendingFixes("(dep-vuln)", vulnFixes);
              try {
                flush();
              } catch {}
            }
          }
        } catch {}
      }
    }
    markSessionStartCompleted();
  } catch {}
}
var _legacyWarned = false;
var init_session_start = __esm(() => {
  init_config();
  init_detect();
  init_metrics();
  init_pending_fixes();
  init_session_state();
  init_dep_vuln_check();
  init_lazy_init();
});

// src/hooks/post-compact.ts
var exports_post_compact = {};
__export(exports_post_compact, {
  default: () => postCompact
});
import { existsSync as existsSync19, readdirSync as readdirSync6, readFileSync as readFileSync17, statSync as statSync6 } from "fs";
import { join as join12 } from "path";
async function postCompact(_ev) {
  try {
    const parts2 = [];
    const fixes = readPendingFixes();
    if (fixes.length > 0) {
      parts2.push(`[qult] ${fixes.length} pending fix(es):`);
      for (const fix of fixes) {
        parts2.push(`  [${fix.gate}] ${fix.file}`);
        if (fix.errors?.length > 0) {
          const shown = fix.errors.slice(0, 3).map((e) => `    ${sanitizeForStderr(e.slice(0, 200))}`);
          parts2.push(...shown);
          if (fix.errors.length > 3) {
            parts2.push(`    ... and ${fix.errors.length - 3} more error(s)`);
          }
        }
      }
    }
    const state = readSessionState();
    const summary = [];
    const hasGates = loadGates() !== null;
    if (state.test_passed_at)
      summary.push(`test_passed_at: ${state.test_passed_at}`);
    else if (hasGates)
      summary.push("tests: NOT PASSED");
    if (state.review_completed_at)
      summary.push(`review_completed_at: ${state.review_completed_at}`);
    else if (hasGates)
      summary.push("review: NOT DONE");
    if (state.changed_file_paths.length > 0)
      summary.push(`${state.changed_file_paths.length} file(s) changed`);
    if (state.disabled_gates.length > 0)
      summary.push(`disabled gates: ${state.disabled_gates.join(", ")}`);
    if (state.review_iteration > 0)
      summary.push(`review iteration: ${state.review_iteration}`);
    if (state.security_warning_count > 0)
      summary.push(`security warnings: ${state.security_warning_count}`);
    if (state.test_quality_warning_count > 0)
      summary.push(`test quality warnings: ${state.test_quality_warning_count}`);
    if (state.drift_warning_count > 0)
      summary.push(`drift warnings: ${state.drift_warning_count}`);
    if (state.dead_import_warning_count > 0)
      summary.push(`dead import warnings: ${state.dead_import_warning_count}`);
    if (summary.length > 0) {
      parts2.push(`[qult] Session: ${summary.join(", ")}`);
    }
    try {
      const planDir = join12(process.cwd(), ".claude", "plans");
      if (existsSync19(planDir)) {
        const planFiles = readdirSync6(planDir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, mtime: statSync6(join12(planDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
        if (planFiles.length > 0) {
          const content = readFileSync17(join12(planDir, planFiles[0].name), "utf-8");
          const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
          const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
          if (taskCount > 0) {
            parts2.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
          }
        }
      }
    } catch {}
    try {
      const db = getDb();
      const pid = getProjectId();
      const findings = db.prepare("SELECT file, severity, description FROM review_findings WHERE project_id = ? ORDER BY id DESC LIMIT 5").all(pid);
      if (findings.length > 0) {
        parts2.push("[qult] Recent review findings:");
        for (const f of findings) {
          parts2.push(`  [${sanitizeForStderr(f.severity)}] ${sanitizeForStderr(f.file)} \u2014 ${sanitizeForStderr(f.description.slice(0, 150))}`);
        }
      }
    } catch {}
    try {
      const { DEFAULTS: DEFAULTS2, loadConfig: loadConfig2 } = await Promise.resolve().then(() => (init_config(), exports_config));
      const config = loadConfig2();
      const d = DEFAULTS2;
      const overrides = [];
      if (config.review.score_threshold !== d.review.score_threshold)
        overrides.push(`score_threshold=${config.review.score_threshold}`);
      if (config.review.dimension_floor !== d.review.dimension_floor)
        overrides.push(`dimension_floor=${config.review.dimension_floor}`);
      if (config.review.required_changed_files !== d.review.required_changed_files)
        overrides.push(`required_changed_files=${config.review.required_changed_files}`);
      if (config.review.require_human_approval)
        overrides.push("require_human_approval=true");
      if (config.gates.test_on_edit)
        overrides.push("test_on_edit=true");
      if (overrides.length > 0) {
        parts2.push(`[qult] Config overrides: ${overrides.join(", ")}`);
      }
    } catch {}
    if (parts2.length > 0) {
      process.stdout.write(parts2.join(`
`));
    }
  } catch {}
}
var init_post_compact = __esm(() => {
  init_load();
  init_db();
  init_pending_fixes();
  init_session_state();
});

// src/hooks/dispatcher.ts
init_db();
init_flush();
init_lazy_init();
var EVENT_MAP = {
  "post-tool": () => Promise.resolve().then(() => (init_post_tool(), exports_post_tool)),
  "pre-tool": () => Promise.resolve().then(() => (init_pre_tool(), exports_pre_tool)),
  stop: () => Promise.resolve().then(() => (init_stop(), exports_stop)),
  "subagent-stop": () => Promise.resolve().then(() => (init_subagent_stop(), exports_subagent_stop)),
  "task-completed": () => Promise.resolve().then(() => (init_task_completed(), exports_task_completed)),
  "session-start": () => Promise.resolve().then(() => (init_session_start(), exports_session_start)),
  "post-compact": () => Promise.resolve().then(() => (init_post_compact(), exports_post_compact))
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
    input = await new Promise((resolve7, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve7(data));
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
  if (ev.cwd) {
    setProjectPath(ev.cwd);
  }
  lazyInit();
  const debug = !!process.env.QULT_DEBUG;
  try {
    if (debug)
      process.stderr.write(`[qult:debug] event=${event} input=${input.length}b
`);
    const start2 = Date.now();
    const handler = await loader();
    await handler.default(ev);
    if (debug)
      process.stderr.write(`[qult:debug] ${event} done in ${Date.now() - start2}ms
`);
  } catch (err2) {
    if (err2 instanceof Error && !err2.message.startsWith("process.exit")) {
      process.stderr.write(`[qult] ${event}: ${err2.message}
`);
    }
  } finally {
    try {
      flushAll();
    } catch {}
  }
}

// src/hook-entry.ts
var event = process.argv[2];
if (!event) {
  process.stderr.write(`Usage: hook.mjs <event>
`);
  process.exit(1);
}
dispatch(event).catch((err2) => {
  if (err2 instanceof Error) {
    process.stderr.write(`[qult] ${err2.message}
`);
  }
});
