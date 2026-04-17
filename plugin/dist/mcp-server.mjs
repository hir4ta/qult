// @bun
// src/mcp-server.ts
import { existsSync as existsSync9 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join4, resolve as resolve3 } from "path";
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

// src/hooks/detectors/health-score.ts
import { existsSync as existsSync6 } from "fs";

// src/hooks/detectors/dead-import-check.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { extname } from "path";

// src/state/plan-status.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, renameSync, statSync } from "fs";
import { basename, dirname, join as join2 } from "path";
var _planCache = null;
var _planCachePath = null;
var _planCacheMtime = null;
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

// src/hooks/detectors/export-check.ts
import { execSync } from "child_process";
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
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
  const newContent = readFileSync3(file, "utf-8");
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
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { basename as basename2, extname as extname3 } from "path";
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
    content = readFileSync4(file, "utf-8");
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
        if (suppressFile?.test(basename2(file)))
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
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "fs";
import { basename as basename3, dirname as dirname2, extname as extname4, resolve } from "path";
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
  const cwd = resolve(process.cwd());
  const absPath = resolve(cwd, file);
  if (!absPath.startsWith(cwd))
    return null;
  if (!existsSync5(absPath))
    return null;
  let content;
  try {
    content = readFileSync5(absPath, "utf-8");
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
    const snapFile = `${snapDir}${basename3(absPath)}.snap`;
    if (existsSync5(snapFile)) {
      const snapContent = readFileSync5(snapFile, "utf-8");
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
          const implContent = readFileSync5(implFile, "utf-8");
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
    const base = basename3(testPath);
    const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    const sameDirPath = resolve(dir, implName);
    if (existsSync5(sameDirPath))
      return sameDirPath;
    const parentDir = dirname2(dir);
    const parentPath = resolve(parentDir, implName);
    if (existsSync5(parentPath))
      return parentPath;
    const srcPath = resolve(parentDir, "src", implName);
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
import { existsSync as existsSync7, lstatSync, readdirSync as readdirSync2, readFileSync as readFileSync6, statSync as statSync2 } from "fs";
import { dirname as dirname3, extname as extname5, join as join3, resolve as resolve2 } from "path";
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
  const candidate = join3(base, ...parts);
  if (existsSync7(`${candidate}.py`))
    return `${candidate}.py`;
  if (existsSync7(join3(candidate, "__init__.py")))
    return join3(candidate, "__init__.py");
  return null;
}
function resolveRustImport(specifier, fromFile, scanRoot) {
  const dir = dirname3(fromFile);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const asFile = join3(dir, `${name}.rs`);
    if (existsSync7(asFile))
      return asFile;
    const asDir = join3(dir, name, "mod.rs");
    if (existsSync7(asDir))
      return asDir;
  } else if (specifier.startsWith("crate:")) {
    const name = specifier.slice(6);
    const srcDir = join3(scanRoot, "src");
    const asFile = join3(srcDir, `${name}.rs`);
    if (existsSync7(asFile))
      return asFile;
    const asDir = join3(srcDir, name, "mod.rs");
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
    const goMod = readFileSync6(join3(scanRoot, "go.mod"), "utf-8");
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
  if (existsSync7(dir) && statSync2(dir).isDirectory())
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
  const raw = resolve2(dir, specifier);
  if (existsSync7(raw) && statSync2(raw).isFile())
    return raw;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const withExt = `${raw}${ext}`;
    if (existsSync7(withExt))
      return withExt;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    const index = join3(raw, `index${ext}`);
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
      const fileAbs = resolve2(file);
      if (fileAbs === targetAbs)
        continue;
      if (targetExt === ".go" && extname5(file).toLowerCase() === ".go" && dirname3(fileAbs) === targetDir) {
        direct.push(file);
        continue;
      }
      try {
        const content = readFileSync6(file, "utf-8");
        const specifiers = extractRelativeImports(content, file);
        for (const spec of specifiers) {
          const resolved = resolveImportPath(spec, file, scanRoot);
          if (!resolved)
            continue;
          if (extname5(file).toLowerCase() === ".go") {
            if (resolve2(resolved) === targetDir) {
              direct.push(file);
              break;
            }
          } else if (resolve2(resolved) === targetAbs) {
            direct.push(file);
            break;
          }
        }
      } catch {}
    }
    if (targetExt === ".py") {
      const targetName = targetAbs.replace(/\.py$/, "").split("/").pop();
      for (const file of files) {
        const fileAbs = resolve2(file);
        if (fileAbs === targetAbs || direct.includes(file))
          continue;
        if (extname5(file).toLowerCase() !== ".py")
          continue;
        try {
          const content = readFileSync6(file, "utf-8");
          const bareImport = new RegExp(`from\\s+\\.\\s+import\\s+(?:.*\\b${targetName}\\b)`, "m");
          if (bareImport.test(content) && dirname3(fileAbs) === targetDir) {
            direct.push(file);
          }
        } catch {}
      }
    }
    return direct;
  }
  let currentTargets = [resolve2(targetFile)];
  for (let d = 0;d < clampedDepth; d++) {
    const nextTargets = [];
    for (const target of currentTargets) {
      if (visited.has(target))
        continue;
      visited.add(target);
      const direct = findDirectImporters(target);
      for (const imp of direct) {
        const impAbs = resolve2(imp);
        if (!visited.has(impAbs) && impAbs !== resolve2(targetFile)) {
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
import { existsSync as existsSync8, readFileSync as readFileSync7 } from "fs";
import { basename as basename4, dirname as dirname4, relative } from "path";
function validateTestCoversImpl(testFile, _testFunction, implFile, _projectRoot) {
  if (!existsSync8(testFile))
    return false;
  try {
    const content = readFileSync7(testFile, "utf-8");
    const implBasename = basename4(implFile).replace(/\.[^.]+$/, "");
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

// src/state/audit-log.ts
var MAX_ENTRIES = 200;
function appendAuditLog(entry) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    db.prepare("INSERT INTO audit_log (project_id, session_id, action, gate_name, reason) VALUES (?, ?, ?, ?, ?)").run(projectId, null, entry.action, entry.gate_name ?? null, entry.reason);
    db.prepare(`DELETE FROM audit_log WHERE project_id = ? AND id NOT IN (
				SELECT id FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`).run(projectId, projectId, MAX_ENTRIES);
  } catch {}
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
    "semgrep-required",
    "test-quality-check",
    "coverage",
    "dep-vuln-check",
    "hallucinated-package-check"
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
    description: "Set a qult config value. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, review.models.{spec|quality|security|adversarial}, plan_eval.score_threshold, plan_eval.max_iterations, plan_eval.models.{generator|evaluator}, review.require_human_approval.",
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
      const ALLOWED_BOOLEAN_KEYS = ["review.require_human_approval"];
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
      const resolvedHealth = resolve3(filePath);
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
    case "record_finish_started": {
      db.prepare("INSERT OR REPLACE INTO ran_gates (project_id, gate_name, ran_at) VALUES (?, ?, ?)").run(pid, "__finish_started__", new Date().toISOString());
      return { content: [{ type: "text", text: "Finish started recorded." }] };
    }
    case "archive_plan": {
      const planPath = typeof args?.plan_path === "string" ? args.plan_path : null;
      if (!planPath) {
        return { content: [{ type: "text", text: "Error: plan_path is required." }] };
      }
      const resolvedPath = resolve3(cwd, planPath);
      const allowedBases = [
        resolve3(join4(cwd, ".claude", "plans")),
        resolve3(join4(homedir2(), ".claude", "plans"))
      ];
      const envPlansDir = process.env.CLAUDE_PLANS_DIR;
      if (envPlansDir)
        allowedBases.push(resolve3(envPlansDir));
      const isAllowed = allowedBases.some((base) => resolvedPath.startsWith(`${base}/`)) && resolvedPath.endsWith(".md");
      if (!isAllowed) {
        return {
          content: [
            { type: "text", text: "Error: plan_path must be a .md file under .claude/plans/" }
          ]
        };
      }
      if (!existsSync9(resolvedPath)) {
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
            "If gates are not configured, run /qult:init.",
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
            "- Before committing: call get_session_status to verify test/review gates.",
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
