// @bun
// src/mcp-server.ts
import { execFileSync as execFileSync2 } from "child_process";
import { existsSync as existsSync11 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4, resolve as resolve4 } from "path";
import { createInterface } from "readline";

// src/state/db.ts
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var SCHEMA_VERSION = 6;
var DB_DIR = join(homedir(), ".qult");
var DB_PATH = join(DB_DIR, "qult.db");
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
var METRIC_NAME_TO_CONFIG_KEY = {
  security: "escalation.security_threshold",
  "test quality": "escalation.test_quality_threshold",
  duplication: "escalation.duplication_threshold",
  semantic: "escalation.semantic_threshold",
  drift: "escalation.drift_threshold"
};
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
var METRIC_SESSION_KEYS = {
  security_warning_count: "security",
  test_quality_warning_count: "test_quality",
  duplication_warning_count: "duplication",
  semantic_warning_count: "semantic",
  drift_warning_count: "drift"
};
var RULE_TEMPLATES = {
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
function transferKnowledge() {
  const patterns = [];
  const templates = [];
  try {
    const db = getDb();
    const projects = db.prepare("SELECT DISTINCT project_id FROM session_metrics GROUP BY project_id HAVING COUNT(*) >= 5").all();
    if (projects.length < 3) {
      return { patterns, templates };
    }
    const metricColumns = [
      "security_warning_count",
      "test_quality_warning_count",
      "duplication_warning_count",
      "semantic_warning_count",
      "drift_warning_count"
    ];
    for (const col of metricColumns) {
      let projectsWithHighFreq = 0;
      for (const project of projects) {
        const rows = db.prepare(`SELECT ${col} as val FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT 10`).all(project.project_id);
        if (rows.length < 5)
          continue;
        const nonZero = rows.filter((r) => r.val > 0).length;
        const frequency = nonZero / rows.length;
        if (frequency > 0.6) {
          projectsWithHighFreq++;
        }
      }
      if (projectsWithHighFreq >= 3) {
        const metricName = METRIC_SESSION_KEYS[col] ?? col;
        patterns.push(`${metricName}: high frequency across ${projectsWithHighFreq} projects`);
        const configKey = METRIC_NAME_TO_CONFIG_KEY[metricName];
        if (configKey) {
          const existing = db.prepare("SELECT value FROM global_configs WHERE key = ?").get(configKey);
          if (!existing) {
            const currentDefault = metricName === "security" ? 10 : metricName === "drift" ? 8 : 8;
            const newVal = Math.max(1, Math.floor(currentDefault * 0.7));
            db.prepare("INSERT INTO global_configs (key, value) VALUES (?, ?)").run(configKey, JSON.stringify(newVal));
          }
        }
        const template = RULE_TEMPLATES[metricName];
        if (template) {
          templates.push(template);
        }
      }
    }
  } catch {}
  return { patterns, templates };
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

// src/hooks/detectors/dep-vuln-check.ts
import { execFileSync } from "child_process";

// src/state/plan-status.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, renameSync, statSync } from "fs";
import { homedir as homedir2 } from "os";
import { basename, dirname, join as join2 } from "path";
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
    const dir = dirname(planPath);
    const archiveDir = join2(dir, "archive");
    mkdirSync2(archiveDir, { recursive: true });
    renameSync(planPath, join2(archiveDir, basename(planPath)));
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
    const pid = getProjectId();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
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

// src/hooks/detectors/dep-vuln-check.ts
var BLOCKING_SEVERITIES = new Set(["CRITICAL", "HIGH"]);
function runOsvScanner(args, cwd, timeout) {
  try {
    const output = execFileSync("osv-scanner", args, {
      cwd,
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8"
    });
    return typeof output === "string" ? output : String(output);
  } catch (err) {
    if (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string" && err.stdout.length > 0) {
      return err.stdout;
    }
    return null;
  }
}

// src/hooks/detectors/health-score.ts
import { existsSync as existsSync8 } from "fs";

// src/hooks/detectors/tree-sitter-init.ts
var __dirname = "/Users/shunichi/Projects/qult/src/hooks/detectors";
var _languageCache = new Map;

// src/hooks/detectors/complexity-check.ts
var _lastFile = null;
var _lastResult = null;
function computeComplexitySync(file) {
  if (_lastFile === file && _lastResult)
    return _lastResult;
  return null;
}

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { extname } from "path";

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
import { basename as basename2, dirname as dirname2, extname as extname2, resolve } from "path";
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
  const name = basename2(filePath);
  if (/\.(test|spec)\.[^.]+$/.test(name))
    return true;
  const parent = basename2(dirname2(filePath));
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
  const ext = extname2(file).toLowerCase();
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
import { extname as extname3 } from "path";
var TS_JS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var EXPORT_RE = /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
var FUNC_SIG_RE = /\bexport\s+(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
function detectExportBreakingChanges(file) {
  if (isGateDisabled("export-check"))
    return [];
  const ext = extname3(file).toLowerCase();
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
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "fs";
import { basename as basename3, extname as extname4 } from "path";
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
  const ext = extname4(file).toLowerCase();
  if (!CHECKABLE_EXTS2.has(ext))
    return [];
  if (!existsSync5(file))
    return [];
  let content;
  try {
    content = readFileSync5(file, "utf-8");
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
        if (suppressFile?.test(basename3(file)))
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
  const ext = extname4(file).toLowerCase();
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
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "fs";
import { extname as extname5 } from "path";
var JS_TS_EXTS2 = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
var PY_EXTS3 = new Set([".py", ".pyi"]);
var CHECKABLE_EXTS3 = new Set([...JS_TS_EXTS2, ...PY_EXTS3, ".go", ".rs", ".rb", ".java", ".kt"]);
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
  const ext = extname5(file).toLowerCase();
  if (!CHECKABLE_EXTS3.has(ext))
    return [];
  if (!existsSync6(file))
    return [];
  let content;
  try {
    content = readFileSync6(file, "utf-8");
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
  if (PY_EXTS3.has(ext)) {
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
import { existsSync as existsSync7, readFileSync as readFileSync7 } from "fs";
import { basename as basename4, dirname as dirname3, extname as extname6, resolve as resolve2 } from "path";
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
  const cwd = resolve2(process.cwd());
  const absPath = resolve2(cwd, file);
  if (!absPath.startsWith(cwd))
    return null;
  if (!existsSync7(absPath))
    return null;
  let content;
  try {
    content = readFileSync7(absPath, "utf-8");
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
    const snapDir = `${dirname3(absPath)}/__snapshots__/`;
    const snapFile = `${snapDir}${basename4(absPath)}.snap`;
    if (existsSync7(snapFile)) {
      const snapContent = readFileSync7(snapFile, "utf-8");
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
          const implContent = readFileSync7(implFile, "utf-8");
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
    const dir = dirname3(testPath);
    const base = basename4(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve2(dir, implName);
    if (existsSync7(sameDirPath))
      return sameDirPath;
    const parentDir = dirname3(dir);
    const parentPath = resolve2(parentDir, implName);
    if (existsSync7(parentPath))
      return parentPath;
    const srcPath = resolve2(parentDir, "src", implName);
    if (existsSync7(srcPath))
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
  dataflow: -2.5,
  duplication: -1.5,
  semantic: -1,
  complexity: -1,
  dead_imports: -1,
  test_quality: -1.5
};
var DEFAULT_WEIGHT = -1;
function countFindings(fixes) {
  return fixes.reduce((sum, f) => sum + f.errors.length, 0);
}
function computeFileHealthScore(file) {
  if (!existsSync8(file)) {
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
  try {
    const complexityResult = computeComplexitySync(file);
    if (complexityResult !== null && complexityResult.warnings.length > 0)
      breakdown.complexity = (WEIGHTS.complexity ?? DEFAULT_WEIGHT) * complexityResult.warnings.length;
  } catch {}
  const totalPenalty = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.round((10 + totalPenalty) * 10) / 10);
  return { score, breakdown };
}

// src/hooks/detectors/import-graph.ts
import { existsSync as existsSync9, lstatSync, readdirSync as readdirSync2, readFileSync as readFileSync8, statSync as statSync2 } from "fs";
import { dirname as dirname4, extname as extname7, join as join3, resolve as resolve3 } from "path";
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
  const ext = filePath ? extname7(filePath).toLowerCase() : "";
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
  const dir = dirname4(fromFile);
  const dotMatch = specifier.match(/^(\.+)(.*)/);
  if (!dotMatch)
    return null;
  const dots = dotMatch[1].length;
  const modulePart = dotMatch[2];
  let base = dir;
  for (let i = 1;i < dots; i++) {
    base = dirname4(base);
  }
  if (!modulePart) {
    return null;
  }
  const parts = modulePart.split(".");
  const candidate = join3(base, ...parts);
  if (existsSync9(`${candidate}.py`))
    return `${candidate}.py`;
  if (existsSync9(join3(candidate, "__init__.py")))
    return join3(candidate, "__init__.py");
  return null;
}
function resolveRustImport(specifier, fromFile, scanRoot) {
  const dir = dirname4(fromFile);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const asFile = join3(dir, `${name}.rs`);
    if (existsSync9(asFile))
      return asFile;
    const asDir = join3(dir, name, "mod.rs");
    if (existsSync9(asDir))
      return asDir;
  } else if (specifier.startsWith("crate:")) {
    const name = specifier.slice(6);
    const srcDir = join3(scanRoot, "src");
    const asFile = join3(srcDir, `${name}.rs`);
    if (existsSync9(asFile))
      return asFile;
    const asDir = join3(srcDir, name, "mod.rs");
    if (existsSync9(asDir))
      return asDir;
  }
  return null;
}
var _goModuleCache;
function getGoModulePath(scanRoot) {
  if (_goModuleCache !== undefined)
    return _goModuleCache;
  try {
    const goMod = readFileSync8(join3(scanRoot, "go.mod"), "utf-8");
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
  const dir = join3(scanRoot, relPath);
  if (existsSync9(dir) && statSync2(dir).isDirectory())
    return dir;
  return null;
}
function resolveImportPath(specifier, fromFile, scanRoot) {
  const fileExt = extname7(fromFile).toLowerCase();
  if (fileExt === ".py") {
    return resolvePythonImport(specifier, fromFile);
  }
  if (fileExt === ".rs" && scanRoot) {
    return resolveRustImport(specifier, fromFile, scanRoot);
  }
  if (fileExt === ".go" && scanRoot) {
    return resolveGoImport(specifier, scanRoot);
  }
  const dir = dirname4(fromFile);
  const raw = resolve3(dir, specifier);
  if (existsSync9(raw) && statSync2(raw).isFile())
    return raw;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const withExt = `${raw}${ext}`;
    if (existsSync9(withExt))
      return withExt;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const index = join3(raw, `index${ext}`);
    if (existsSync9(index))
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
      entries = readdirSync2(current);
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
      const full = join3(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink())
          continue;
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile() && SCAN_EXTS.has(extname7(full))) {
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
  if (!existsSync9(scanRoot))
    return [];
  const clampedDepth = Math.min(Math.max(depth, 1), 3);
  const files = collectFiles(scanRoot);
  const visited = new Set;
  const allImporters = [];
  function findDirectImporters(targetAbs) {
    const direct = [];
    const targetDir = dirname4(targetAbs);
    const targetExt = extname7(targetAbs).toLowerCase();
    for (const file of files) {
      const fileAbs = resolve3(file);
      if (fileAbs === targetAbs)
        continue;
      if (targetExt === ".go" && extname7(file).toLowerCase() === ".go" && dirname4(fileAbs) === targetDir) {
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
          if (extname7(file).toLowerCase() === ".go") {
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
        if (extname7(file).toLowerCase() !== ".py")
          continue;
        try {
          const content = readFileSync8(file, "utf-8");
          const bareImport = new RegExp(`from\\s+\\.\\s+import\\s+(?:.*\\b${targetName}\\b)`, "m");
          if (bareImport.test(content) && dirname4(fileAbs) === targetDir) {
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

// src/hooks/detectors/spec-trace-check.ts
import { existsSync as existsSync10, readFileSync as readFileSync9 } from "fs";
import { basename as basename5, dirname as dirname5, relative } from "path";
function validateTestCoversImpl(testFile, _testFunction, implFile, _projectRoot) {
  if (!existsSync10(testFile))
    return false;
  try {
    const content = readFileSync9(testFile, "utf-8");
    const implBasename = basename5(implFile).replace(/\.[^.]+$/, "");
    const implRelative = relative(dirname5(testFile), implFile).replace(/\\/g, "/").replace(/\.[^.]+$/, "");
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
    db.prepare("INSERT INTO audit_log (project_id, session_id, action, gate_name, reason) VALUES (?, ?, ?, ?, ?)").run(projectId, null, entry.action, entry.gate_name ?? null, entry.reason);
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
    "coverage",
    "dep-vuln-check",
    "hallucinated-package-check",
    "dataflow-check",
    "complexity-check",
    "mutation-test"
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
    description: "Compute a 0-10 health score for a file by aggregating findings from computational detectors (security, semantic, duplication, dead-imports, export-breaking, complexity, test-quality). 10 = no issues, 0 = critical. Returns score and per-detector breakdown.",
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
    name: "apply_flywheel_recommendations",
    description: "Apply flywheel recommendations: safe (raise) recommendations are auto-applied to global_configs, lower recommendations are deferred for manual review.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "transfer_knowledge",
    description: "Cross-project session analysis. Detects common patterns across 3+ projects and writes shared thresholds to global_configs. Returns patterns found and rule templates.",
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
  },
  {
    name: "get_impact_analysis",
    description: "Analyze the impact of changes to a file. Returns a list of consumer files (importers) that may be affected, using the import graph. When LSP is available, also includes findReferences results for changed symbols.",
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
  },
  {
    name: "generate_sbom",
    description: "Generate a Software Bill of Materials (SBOM) for the project in CycloneDX JSON format. Uses osv-scanner or syft. Slower than other tools (up to 30s).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_dependency_summary",
    description: "Get a summary of project dependencies: package count by ecosystem and known vulnerability count. Uses osv-scanner.",
    inputSchema: { type: "object", properties: {} }
  }
];
function handleTool(name, cwd, args) {
  setProjectPath(cwd);
  const db = getDb();
  const pid = getProjectId();
  switch (name) {
    case "get_pending_fixes": {
      const rows = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?").all(pid);
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
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
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
      const disabled = db.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?").all(pid);
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
      db.prepare("INSERT OR REPLACE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)").run(pid, gateName, reason);
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
      db.prepare("DELETE FROM disabled_gates WHERE project_id = ? AND gate_name = ?").run(pid, gateName);
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
      db.prepare("DELETE FROM pending_fixes WHERE project_id = ?").run(pid);
      appendAuditLog({
        action: "clear_pending_fixes",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
    }
    case "get_detector_summary": {
      const session = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
      const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?").all(pid);
      const lines = [];
      if (session) {
        const counters = [
          "security_warning_count",
          "dead_import_warning_count",
          "drift_warning_count",
          "test_quality_warning_count",
          "duplication_warning_count",
          "semantic_warning_count"
        ];
        for (const key of counters) {
          const val = typeof session[key] === "number" ? session[key] : 0;
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
      db.prepare("UPDATE projects SET review_completed_at = ? WHERE id = ?").run(new Date().toISOString(), pid);
      const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
      const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
      return { content: [{ type: "text", text: msg }] };
    }
    case "record_test_pass": {
      const cmd = typeof args?.command === "string" ? args.command : null;
      if (!cmd) {
        return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
      }
      db.prepare("UPDATE projects SET test_passed_at = ?, test_command = ? WHERE id = ?").run(new Date().toISOString(), cmd, pid);
      return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
    }
    case "record_human_approval": {
      const session = db.prepare("SELECT review_completed_at FROM projects WHERE id = ?").get(pid);
      if (!session?.review_completed_at) {
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
      db.prepare("UPDATE projects SET human_review_approved_at = ? WHERE id = ?").run(new Date().toISOString(), pid);
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
      const insertScore = db.prepare("INSERT OR REPLACE INTO review_stage_scores (project_id, stage, dimension, score) VALUES (?, ?, ?, ?)");
      for (const [dim, score] of Object.entries(scores)) {
        insertScore.run(pid, stage, dim, score);
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
        const session = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
        const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?").all(pid);
        const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE project_id = ?").all(pid);
        const disabledGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?").all(pid);
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
                testPassed: !!session?.test_passed_at,
                reviewDone: !!session?.review_completed_at,
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
    case "apply_flywheel_recommendations": {
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
        const result = applyFlywheelRecommendations(recs, config);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "No flywheel data available yet." }] };
      }
    }
    case "transfer_knowledge": {
      try {
        const result = transferKnowledge();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ patterns: [], templates: [] }) }]
        };
      }
    }
    case "record_finish_started": {
      db.prepare("INSERT OR REPLACE INTO ran_gates (project_id, gate_name, ran_at) VALUES (?, ?, ?)").run(pid, "__finish_started__", new Date().toISOString());
      return { content: [{ type: "text", text: "Finish started recorded." }] };
    }
    case "archive_plan": {
      const planPath = typeof args?.plan_path === "string" ? args.plan_path : null;
      if (!planPath) {
        return { content: [{ type: "text", text: "Error: plan_path is required." }] };
      }
      const resolvedPath = resolve4(cwd, planPath);
      const allowedBases = [
        resolve4(join4(cwd, ".claude", "plans")),
        resolve4(join4(homedir3(), ".claude", "plans"))
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
      if (!existsSync11(resolvedPath)) {
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
      db.prepare(`UPDATE projects SET
				security_warning_count = 0,
				test_quality_warning_count = 0,
				drift_warning_count = 0,
				dead_import_warning_count = 0,
				duplication_warning_count = 0,
				semantic_warning_count = 0
				WHERE id = ?`).run(pid);
      appendAuditLog({
        action: "reset_escalation_counters",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All escalation counters reset to zero." }] };
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
    case "generate_sbom": {
      try {
        const output = runOsvScanner(["--format", "cyclonedx-1-5", "-r", "."], cwd, 30000);
        if (output) {
          return { content: [{ type: "text", text: output }] };
        }
        try {
          const syftOutput = execFileSync2("syft", [".", "-o", "cyclonedx-json"], {
            cwd,
            timeout: 30000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"]
          });
          return {
            content: [
              {
                type: "text",
                text: typeof syftOutput === "string" ? syftOutput : String(syftOutput)
              }
            ]
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Neither osv-scanner nor syft is installed. Install one: `brew install osv-scanner` or `brew install syft`."
              }
            ]
          };
        }
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to generate SBOM." }]
        };
      }
    }
    case "get_dependency_summary": {
      try {
        const raw = runOsvScanner(["--format", "json", "-r", "."], cwd, 15000);
        if (!raw) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "osv-scanner is not installed. Install: `brew install osv-scanner`."
              }
            ]
          };
        }
        const data = JSON.parse(raw);
        const ecosystems = {};
        for (const result of data.results ?? []) {
          for (const pkg of result.packages ?? []) {
            const eco = pkg.package?.ecosystem ?? "unknown";
            if (!ecosystems[eco])
              ecosystems[eco] = { packages: 0, vulns: 0 };
            ecosystems[eco].packages++;
            ecosystems[eco].vulns += (pkg.vulnerabilities ?? []).length;
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ecosystems, total_sources: (data.results ?? []).length })
            }
          ]
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to get dependency summary." }]
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
            "- If review.require_human_approval is enabled, call record_human_approval after the architect has reviewed and approved the changes.",
            "",
            "## Impact Analysis",
            "- After modifying types or exported interfaces, call get_impact_analysis to check which consumer files are affected.",
            "- Use get_call_coverage to verify that test files actually import and exercise the implementation under test."
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
