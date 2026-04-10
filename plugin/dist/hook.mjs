// @bun
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
      coverage_threshold: 0
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
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
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
      for (const [name, entry] of Object.entries(state.ran_gates)) {
        insertRan.run(pid, name, entry.ran_at);
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
      for (let i = 0;i < state.review_score_history.length; i++) {
        insertReview.run(pid, i + 1, state.review_score_history[i]);
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
      for (let i = 0;i < state.plan_eval_score_history.length; i++) {
        insertPlan.run(pid, i + 1, state.plan_eval_score_history[i]);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
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
  } catch (err) {
    process.stderr.write(`[qult] file_edit_counts error: ${err instanceof Error ? err.message : "unknown"} \u2014 iterative escalation may be degraded
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
        const isTimeout = "killed" in err && err.killed && duration_ms >= timeout - 100;
        const prefix = isTimeout ? `TIMEOUT after ${timeout}ms
` : "";
        const output = prefix + (smartTruncate(deduplicateErrors(raw), maxChars) || `Exit code ${err.code ?? 1}`);
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
    const isTimeout = "signal" in e && e.signal === "SIGTERM" && duration_ms >= timeout - 100;
    const prefix = isTimeout ? `TIMEOUT after ${timeout}ms
` : "";
    const output = prefix + (smartTruncate(deduplicateErrors(stdout + stderr), maxChars) || `Exit code ${status}`);
    return {
      name,
      passed: false,
      output,
      duration_ms
    };
  }
}
function runCoverageGate(name, gate, threshold) {
  if (threshold <= 0) {
    return { name, passed: true, output: "coverage check skipped (threshold=0)", duration_ms: 0 };
  }
  const result = runGate(name, gate);
  if (!result.passed)
    return result;
  const coverage = parseCoveragePercent(result.output);
  if (coverage === null)
    return result;
  if (coverage < threshold) {
    return {
      name,
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
  init_coverage_parser();
  ERROR_CODE_RE = /\b([A-Z]{1,4}\d{1,5}|ERR_[A-Z_]+|E\d{3,5})\b/;
});

// src/hooks/sanitize.ts
function sanitizeForStderr(input) {
  const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// src/hooks/detectors/convention-check.ts
import { readdirSync as readdirSync2, statSync as statSync2 } from "fs";
import { basename as basename2, dirname as dirname2, extname, join as join3 } from "path";
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
  const fileName = basename2(file);
  const stem = basename2(fileName, extname(fileName));
  let siblings;
  try {
    siblings = readdirSync2(dir).filter((f) => {
      try {
        return f !== fileName && statSync2(join3(dir, f)).isFile();
      } catch {
        return false;
      }
    }).map((f) => basename2(f, extname(f)));
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
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { extname as extname2 } from "path";
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
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { basename as basename3, dirname as dirname3, extname as extname3, resolve } from "path";
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
    if (!existsSync3(otherFile))
      continue;
    const otherExt = extname3(otherFile).toLowerCase();
    if (!CHECKABLE_EXTS.has(otherExt))
      continue;
    let otherContent;
    try {
      otherContent = readFileSync3(otherFile, "utf-8");
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
function getRelativePath(filePath, cwd) {
  const full = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
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
import { execSync as execSync2 } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { extname as extname4 } from "path";
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
    oldContent = execSync2(`git show HEAD:${relPath}`, {
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
var TS_JS_EXTS2, EXPORT_RE;
var init_export_check = __esm(() => {
  init_session_state();
  TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
  EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
});

// src/hooks/detectors/import-check.ts
import { existsSync as existsSync5, readdirSync as readdirSync3, readFileSync as readFileSync5 } from "fs";
import { extname as extname5, join as join4, resolve as resolve2 } from "path";
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
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "fs";
import { basename as basename4, extname as extname6 } from "path";
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
var CHECKABLE_EXTS2, MAX_CHECK_SIZE3 = 500000, SECRET_PATTERNS, JS_TS_EXTS, PY_EXTS3, GO_EXTS2, RB_EXTS, JAVA_EXTS, DANGEROUS_PATTERNS, ADVISORY_PATTERNS;
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
import { existsSync as existsSync7, readFileSync as readFileSync7 } from "fs";
import { extname as extname7 } from "path";
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
var JS_TS_EXTS2, PY_EXTS4, CHECKABLE_EXTS3, MAX_CHECK_SIZE4 = 500000, INTENTIONAL_RE, PURE_METHODS_RE, CHAIN_CONTINUATION_RE, CONDITION_ASSIGNMENT_RE, DESTRUCTURE_RE, LOOSE_EQ_RE, NULL_COALESCE_RE, STRING_LITERAL_RE, CASE_OR_DEFAULT_RE, BREAK_RE, FALLTHROUGH_COMMENT_RE, TEST_CASE_RE, PBT_IMPORT_RE;
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

// src/hooks/detectors/test-file-resolver.ts
import { existsSync as existsSync8 } from "fs";
import { basename as basename5, dirname as dirname4, extname as extname8, join as join5 } from "path";
function resolveTestFile(sourceFile) {
  const ext = extname8(sourceFile);
  const base = basename5(sourceFile, ext);
  const dir = dirname4(sourceFile);
  if (isTestFile2(sourceFile))
    return null;
  for (const pattern of TEST_PATTERNS) {
    const candidate = pattern(dir, base, ext);
    if (candidate && existsSync8(candidate)) {
      return candidate;
    }
  }
  return null;
}
function isTestFile2(file) {
  const base = basename5(file);
  return /\.(test|spec)\.\w+$/.test(base) || /^test_\w+\.py$/.test(base) || /_test\.go$/.test(base) || /\/(__tests__|tests)\//.test(file);
}
var TEST_PATTERNS;
var init_test_file_resolver = __esm(() => {
  TEST_PATTERNS = [
    (dir, name, ext) => join5(dir, `${name}.test${ext}`),
    (dir, name, ext) => join5(dir, `${name}.spec${ext}`),
    (dir, name, ext) => join5(dir, "__tests__", `${name}.test${ext}`),
    (dir, name, ext) => join5(dir, "__tests__", `${name}.spec${ext}`),
    (dir, name, ext) => join5(dir, "tests", `${name}.test${ext}`),
    (dir, name, ext) => ext === ".py" ? join5(dir, `test_${name}${ext}`) : null,
    (dir, name, ext) => ext === ".py" ? join5(dir, "tests", `test_${name}${ext}`) : null,
    (dir, name, ext) => ext === ".go" ? join5(dir, `${name}_test${ext}`) : null,
    (dir, name, ext) => ext === ".rs" ? join5(dir, "tests", `${name}${ext}`) : null
  ];
});

// src/hooks/detectors/test-quality-check.ts
import { existsSync as existsSync9, readFileSync as readFileSync8 } from "fs";
import { basename as basename6, dirname as dirname5, extname as extname9, resolve as resolve3 } from "path";
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
  if (!existsSync9(absPath))
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
    const snapDir = `${dirname5(absPath)}/__snapshots__/`;
    const snapFile = `${snapDir}${basename6(absPath)}.snap`;
    if (existsSync9(snapFile)) {
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
    const dir = dirname5(testPath);
    const base = basename6(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve3(dir, implName);
    if (existsSync9(sameDirPath))
      return sameDirPath;
    const parentDir = dirname5(dir);
    const parentPath = resolve3(parentDir, implName);
    if (existsSync9(parentPath))
      return parentPath;
    const srcPath = resolve3(parentDir, "src", implName);
    if (existsSync9(srcPath))
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
      const ext = extname9(file).toLowerCase();
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
  const name = basename6(implFile);
  if (!PBT_CANDIDATE_RE.test(name))
    return null;
  const testFile = resolveTestFile(implFile);
  if (!testFile || !existsSync9(testFile))
    return null;
  try {
    const stats = __require("fs").statSync(testFile);
    if (stats.size > MAX_CHECK_SIZE5)
      return null;
    const content = readFileSync8(testFile, "utf-8");
    if (PBT_RE.test(content))
      return null;
  } catch {
    return null;
  }
  const relative = implFile.split("/").slice(-3).join("/");
  return `${relative}: Consider property-based testing (fast-check/hypothesis) for validation/serialization logic`;
}
var MAX_CHECK_SIZE5 = 500000, BLOCKING_SMELL_TYPES, ASSERTION_RE, TEST_CASE_RE2, WEAK_MATCHERS, TRIVIAL_ASSERTION_RE, EMPTY_TEST_RE, MOCK_RE, ALWAYS_TRUE_RE, CONSTANT_SELF_RE, SNAPSHOT_RE, IMPL_COUPLED_RE, ASYNC_TEST_RE, AWAIT_RE, MODULE_LET_RE, LARGE_TEST_FILE_LINES = 500, LARGE_SNAPSHOT_CHARS = 5000, PBT_RE, PBT_DEGENERATE_RUNS_RE, PBT_CONSTRAINED_GEN_RE, SETUP_BLOCK_RE, PBT_CANDIDATE_RE;
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
import { readFileSync as readFileSync9 } from "fs";
import { dirname as dirname6, extname as extname10, resolve as resolve4 } from "path";
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
  const file = resolve4(rawFile);
  try {
    const existingFixes = readPendingFixes();
    if (existingFixes.length > 0 && !existingFixes.some((f) => resolve4(f.file) === file)) {
      deny(`Fix existing errors before editing other files (PostToolUse fallback):
${existingFixes.map((f) => `  ${f.file}`).join(`
`)}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
  }
  const config = loadConfig();
  const gates = loadGates();
  const hasWriteGates = !!gates?.on_write;
  const fileExt = extname10(file).toLowerCase();
  const gatedExts = getGatedExtensions();
  const gateEntries = [];
  if (hasWriteGates && gates?.on_write) {
    for (const [name, gate] of Object.entries(gates.on_write)) {
      if (isGateDisabled(name))
        continue;
      if (gate.run_once_per_batch && shouldSkipGate(name, file))
        continue;
      const hasPlaceholder = gate.command.includes("{file}");
      if (hasPlaceholder && gatedExts.size > 0 && !gatedExts.has(fileExt))
        continue;
      gateEntries.push({ name, gate, fileArg: hasPlaceholder ? file : undefined });
    }
  }
  const results = await Promise.allSettled(gateEntries.map((entry) => runGateAsync(entry.name, entry.gate, entry.fileArg)));
  const newFixes = [];
  for (let i = 0;i < results.length; i++) {
    const settled = results[i];
    const entry = gateEntries[i];
    try {
      if (settled.status === "fulfilled") {
        if (entry.gate.run_once_per_batch) {
          markGateRan(entry.name);
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
  const existingFixKeys = new Set(readPendingFixes().map((f) => `${resolve4(f.file)}:${f.gate}`));
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
    if (!isGateDisabled("security-check-advisory")) {
      const editCount = incrementFileEditCount(file);
      const projectRoot = resolve4(process.cwd());
      if (editCount >= config.escalation.security_iterative_threshold && file.startsWith(`${projectRoot}/`)) {
        const fileContent = readFileSync9(file, "utf-8");
        const advisoryFixes = getAdvisoryAsPendingFixes(file, fileContent);
        if (advisoryFixes.length > 0) {
          newFixes.push(...advisoryFixes);
          const relative = file.split("/").slice(-3).join("/");
          process.stderr.write(`[qult] Iterative security escalation: ${relative} edited ${editCount} times \u2014 advisory patterns promoted to blocking
`);
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
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve4(cwd, t.file)));
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
    return `go test -v -run . ${shellEscape(dirname6(testFile))}`;
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
  const config = loadConfig();
  const coverageThreshold = config.gates.coverage_threshold;
  for (const [name, gate] of Object.entries(gates.on_commit)) {
    try {
      if (isGateDisabled(name))
        continue;
      if (name === "coverage" && coverageThreshold > 0) {
        const result = runCoverageGate(name, gate, coverageThreshold);
        if (!result.passed) {
          addPendingFixes("__commit__", [
            { file: "__commit__", errors: [result.output], gate: name }
          ]);
        }
        continue;
      }
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
  init_semantic_check();
  init_test_file_resolver();
  init_test_quality_check();
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
import { resolve as resolve5 } from "path";
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
  const resolvedTarget = resolve5(targetFile);
  const fixes = readPendingFixes();
  if (fixes.length > 0) {
    const isFixingPendingFile = fixes.some((f) => resolve5(f.file) === resolvedTarget);
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
    const taskFile = resolve5(cwd, task.file);
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
  const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve5(cwd, t.file)));
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
    const implFile = resolve5(cwd, task.file);
    if (resolvedTarget !== implFile)
      continue;
    const testFile = resolve5(cwd, parsed.file);
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
import { existsSync as existsSync10, readFileSync as readFileSync10, statSync as statSync3 } from "fs";
import { join as join6 } from "path";
function groundClaims(output, cwd) {
  try {
    const ungrounded = [];
    let total = 0;
    for (const match of output.matchAll(FINDING_FILE_RE)) {
      total++;
      const filePath = match[2];
      const description = match[4] ?? "";
      const absPath = join6(cwd, filePath);
      const normalizedCwd = cwd.replace(/\/+$/, "");
      if (!absPath.startsWith(`${normalizedCwd}/`)) {
        ungrounded.push(`Path traversal rejected: ${filePath}`);
        continue;
      }
      if (!existsSync10(absPath)) {
        ungrounded.push(`File not found: ${filePath}`);
        continue;
      }
      let fileContent = null;
      for (const funcMatch of description.matchAll(FUNC_REF_RE)) {
        const funcName = funcMatch[1];
        if (!fileContent) {
          try {
            const size = statSync3(absPath).size;
            if (size > MAX_FILE_SIZE)
              break;
            fileContent = readFileSync10(absPath, "utf-8");
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
var FINDING_FILE_RE, FUNC_REF_RE, MAX_FILE_SIZE = 500000;
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
import { execSync as execSync3 } from "child_process";
import { existsSync as existsSync11, readdirSync as readdirSync4, readFileSync as readFileSync11, statSync as statSync4 } from "fs";
import { join as join7, normalize } from "path";
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
    const planDir = join7(process.cwd(), ".claude", "plans");
    if (!existsSync11(planDir))
      return;
    const files = readdirSync4(planDir).filter((f) => f.endsWith(".md")).map((f) => ({
      name: f,
      mtime: statSync4(join7(planDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0)
      return;
    const content = readFileSync11(join7(planDir, files[0].name), "utf-8");
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
    const floor = loadConfig().review.dimension_floor;
    const belowFloor = Object.entries(scoreEntries).filter(([, v]) => typeof v === "number" && v < floor);
    if (belowFloor.length > 0) {
      const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      const dims = belowFloor.map(([name, score]) => `${capitalize(name)} (${score}/5)`).join(", ");
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
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("process.exit"))
      throw err;
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
  const args = argsBuilder(parsed.file, parsed.testName);
  const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;
  try {
    const config = loadConfig();
    const verifyTimeout = config.gates.test_on_edit_timeout ?? DEFAULT_VERIFY_TIMEOUT;
    const extraPath = config.gates.extra_path.filter((p) => !p.includes(":")).map((p) => p.startsWith("/") ? p : `${process.cwd()}/${p}`).join(":");
    const pathPrefix = extraPath ? `${extraPath}:` : "";
    const result = spawnSync(args[0], args.slice(1), {
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
import { existsSync as existsSync12, readFileSync as readFileSync12 } from "fs";
import { join as join8 } from "path";
function isReachable(exe, root) {
  if (!/^[a-zA-Z0-9_-]+$/.test(exe))
    return false;
  const nodeModulesBin = join8(root, "node_modules", ".bin", exe);
  if (existsSync12(nodeModulesBin))
    return true;
  try {
    const { execFileSync } = __require("child_process");
    execFileSync("/bin/sh", ["-c", `command -v ${exe}`], {
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
var MAX_ENTRIES = 50, METRIC_KEYS, WINDOW_SIZES, METRIC_TO_THRESHOLD;
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
});

// src/hooks/session-start.ts
var exports_session_start = {};
__export(exports_session_start, {
  default: () => sessionStart
});
import { existsSync as existsSync13 } from "fs";
import { join as join9 } from "path";
async function sessionStart(ev) {
  try {
    if (!_legacyWarned) {
      _legacyWarned = true;
      const cwd = ev.cwd ?? process.cwd();
      if (existsSync13(join9(cwd, ".qult"))) {
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
  init_lazy_init();
});

// src/hooks/post-compact.ts
var exports_post_compact = {};
__export(exports_post_compact, {
  default: () => postCompact
});
import { existsSync as existsSync14, readdirSync as readdirSync5, readFileSync as readFileSync13, statSync as statSync5 } from "fs";
import { join as join10 } from "path";
async function postCompact(_ev) {
  try {
    const parts = [];
    const fixes = readPendingFixes();
    if (fixes.length > 0) {
      parts.push(`[qult] ${fixes.length} pending fix(es):`);
      for (const fix of fixes) {
        parts.push(`  [${fix.gate}] ${fix.file}`);
        if (fix.errors?.length > 0) {
          const shown = fix.errors.slice(0, 3).map((e) => `    ${sanitizeForStderr(e.slice(0, 200))}`);
          parts.push(...shown);
          if (fix.errors.length > 3) {
            parts.push(`    ... and ${fix.errors.length - 3} more error(s)`);
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
      parts.push(`[qult] Session: ${summary.join(", ")}`);
    }
    try {
      const planDir = join10(process.cwd(), ".claude", "plans");
      if (existsSync14(planDir)) {
        const planFiles = readdirSync5(planDir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, mtime: statSync5(join10(planDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
        if (planFiles.length > 0) {
          const content = readFileSync13(join10(planDir, planFiles[0].name), "utf-8");
          const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
          const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
          if (taskCount > 0) {
            parts.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
          }
        }
      }
    } catch {}
    try {
      const db = getDb();
      const pid = getProjectId();
      const findings = db.prepare("SELECT file, severity, description FROM review_findings WHERE project_id = ? ORDER BY id DESC LIMIT 5").all(pid);
      if (findings.length > 0) {
        parts.push("[qult] Recent review findings:");
        for (const f of findings) {
          parts.push(`  [${sanitizeForStderr(f.severity)}] ${sanitizeForStderr(f.file)} \u2014 ${sanitizeForStderr(f.description.slice(0, 150))}`);
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
        parts.push(`[qult] Config overrides: ${overrides.join(", ")}`);
      }
    } catch {}
    if (parts.length > 0) {
      process.stdout.write(parts.join(`
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
  if (ev.cwd) {
    setProjectPath(ev.cwd);
  }
  lazyInit();
  const debug = !!process.env.QULT_DEBUG;
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
