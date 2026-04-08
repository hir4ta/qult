// @bun
// src/mcp-server.ts
import { createInterface } from "readline";

// src/state/db.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var DB_DIR = join(homedir(), ".qult");
var DB_PATH = join(DB_DIR, "qult.db");
var DEFAULT_SESSION_ID = "__default__";
var _db = null;
function getDb() {
  if (_db)
    return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  configurePragmas(_db);
  ensureSchema(_db);
  return _db;
}
function configurePragmas(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}
function ensureSchema(db) {
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
			duplication_warning_count   INTEGER NOT NULL DEFAULT 0
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
			id                     INTEGER PRIMARY KEY,
			session_id             TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			project_id             INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count     INTEGER NOT NULL DEFAULT 0,
			security_warning_count INTEGER NOT NULL DEFAULT 0,
			review_aggregate       REAL,
			files_changed          INTEGER NOT NULL DEFAULT 0,
			recorded_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_metrics_project ON session_metrics(project_id);

		CREATE TABLE IF NOT EXISTS calibration (
			id          INTEGER PRIMARY KEY,
			project_id  INTEGER NOT NULL REFERENCES projects(id),
			session_id  TEXT    NOT NULL,
			aggregate   REAL    NOT NULL,
			stages      TEXT    NOT NULL,
			recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_calibration_project ON calibration(project_id);

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
  if (!/^[\w.\-:]+$/.test(sessionId))
    return;
  _sessionId = sessionId;
}
function getSessionId() {
  return _sessionId;
}
function findLatestSessionId() {
  const db = getDb();
  const projectId = getProjectId();
  const row = db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(projectId);
  return row?.id ?? null;
}

// src/config.ts
var DEFAULTS = {
  review: {
    score_threshold: 30,
    max_iterations: 3,
    required_changed_files: 5,
    dimension_floor: 4,
    require_human_approval: false
  },
  plan_eval: {
    score_threshold: 12,
    max_iterations: 2,
    registry_files: []
  },
  gates: {
    output_max_chars: 3500,
    default_timeout: 1e4,
    test_on_edit: false,
    test_on_edit_timeout: 15000,
    extra_path: []
  },
  escalation: {
    security_threshold: 10,
    drift_threshold: 8,
    test_quality_threshold: 8,
    duplication_threshold: 8
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
  }
}
function kvRowsToRaw(rows) {
  const raw = {};
  for (const row of rows) {
    const [section, field] = row.key.split(".");
    if (!section || !field)
      continue;
    if (!raw[section])
      raw[section] = {};
    try {
      raw[section][field] = JSON.parse(row.value);
    } catch {
      raw[section][field] = row.value;
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
  _cache = config;
  return config;
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
      if (row.timeout)
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

// src/harness-report.ts
var MIN_TREND_SESSIONS = 3;
var IDLE_GATE_THRESHOLD = 10;
function generateHarnessReport(metrics, auditLog) {
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
  return {
    totalSessions: metrics.length,
    gateFailureSessions,
    securityWarningSessions,
    averageReviewScore,
    reviewTrend,
    gateDisableCount: disableEntries.length,
    disablesByGate,
    recommendations
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
var MAX_ENTRIES = 200;
function appendAuditLog(_cwd, entry) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const sid = getSessionId();
    db.prepare("INSERT INTO audit_log (project_id, session_id, action, gate_name, reason) VALUES (?, ?, ?, ?, ?)").run(projectId, sid, entry.action, entry.gate_name ?? null, entry.reason);
    db.prepare(`DELETE FROM audit_log WHERE project_id = ? AND id NOT IN (
				SELECT id FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`).run(projectId, projectId, MAX_ENTRIES);
  } catch {}
}
function readAuditLog(_cwd) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare("SELECT action, reason, gate_name, created_at FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, MAX_ENTRIES);
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

// src/state/metrics.ts
var MAX_ENTRIES2 = 50;
function readMetricsHistory(_cwd) {
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare(`SELECT session_id, recorded_at, gate_failure_count, security_warning_count, review_aggregate, files_changed
				 FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?`).all(projectId, MAX_ENTRIES2);
    return rows.map((r) => ({
      session_id: r.session_id,
      timestamp: r.recorded_at,
      gate_failures: r.gate_failure_count,
      security_warnings: r.security_warning_count,
      review_score: r.review_aggregate,
      files_changed: r.files_changed
    }));
  } catch {
    return [];
  }
}

// src/state/plan-status.ts
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
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
function hasPlanFile() {
  try {
    const planDir = join2(process.cwd(), ".claude", "plans");
    if (!existsSync(planDir))
      return false;
    return readdirSync(planDir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
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
        command: { type: "string", description: "The test command that was run (e.g. 'bun vitest run')" }
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
        stage: { type: "string", description: "Stage name: 'Spec', 'Quality', 'Security', or 'Adversarial'" },
        scores: { type: "object", description: "Dimension scores (e.g. {completeness: 5, accuracy: 4})" }
      },
      required: ["stage", "scores"]
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
  }
];
function handleTool(name, cwd, args) {
  resolveSession(cwd);
  const db = getDb();
  const sid = getSessionId();
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
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
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
          content: [{ type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." }]
        };
      }
      if (!isValidGateName(gateName)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown gate '${gateName}'. Valid: ${getValidGateNames().join(", ")}` }]
        };
      }
      const disabled = db.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?").all(sid);
      if (!disabled.some((d) => d.gate_name === gateName) && disabled.length >= 2) {
        return {
          isError: true,
          content: [{ type: "text", text: `Maximum 2 gates disabled. Currently: ${disabled.map((d) => d.gate_name).join(", ")}` }]
        };
      }
      db.prepare("INSERT OR REPLACE INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(sid, gateName, reason);
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
      db.prepare("DELETE FROM disabled_gates WHERE session_id = ? AND gate_name = ?").run(sid, gateName);
      return { content: [{ type: "text", text: `Gate '${gateName}' re-enabled.` }] };
    }
    case "set_config": {
      const key = typeof args?.key === "string" ? args.key : null;
      const value = typeof args?.value === "number" ? args.value : null;
      if (!key || value === null) {
        return { isError: true, content: [{ type: "text", text: "Missing key or value parameter." }] };
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
        return { isError: true, content: [{ type: "text", text: `Invalid key. Allowed: ${ALLOWED_KEYS.join(", ")}` }] };
      }
      if (key === "review.dimension_floor" && (value < 1 || value > 5)) {
        return { isError: true, content: [{ type: "text", text: "dimension_floor must be 1-5." }] };
      }
      const projectId = getProjectId();
      db.prepare("INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)").run(projectId, key, JSON.stringify(value));
      return { content: [{ type: "text", text: `Config set: ${key} = ${value}` }] };
    }
    case "clear_pending_fixes": {
      const reason = typeof args?.reason === "string" ? args.reason : null;
      if (!reason || reason.length < 10 || new Set(reason).size < 5) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." }]
        };
      }
      db.prepare("DELETE FROM pending_fixes WHERE session_id = ?").run(sid);
      appendAuditLog(cwd, {
        action: "clear_pending_fixes",
        reason,
        timestamp: new Date().toISOString()
      });
      return { content: [{ type: "text", text: "All pending fixes cleared." }] };
    }
    case "get_detector_summary": {
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
      const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?").all(sid);
      const lines = [];
      if (session) {
        const counters = [
          "security_warning_count",
          "dead_import_warning_count",
          "drift_warning_count",
          "test_quality_warning_count",
          "duplication_warning_count"
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
    case "record_review": {
      try {
        const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE session_id = ?").all(sid);
        const threshold = loadConfig().review.required_changed_files;
        if (changedFiles.length >= threshold && !hasPlanFile()) {
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot record review: ${changedFiles.length} files changed without a plan.` }]
          };
        }
      } catch {}
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
      const session = db.prepare("SELECT review_completed_at FROM sessions WHERE id = ?").get(sid);
      if (!session?.review_completed_at) {
        return {
          isError: true,
          content: [{ type: "text", text: "Cannot record approval: no review completed. Run /qult:review first." }]
        };
      }
      db.prepare("UPDATE sessions SET human_review_approved_at = ? WHERE id = ?").run(new Date().toISOString(), sid);
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
        return { isError: true, content: [{ type: "text", text: "Missing stage or scores parameter." }] };
      }
      const validStages = ["Spec", "Quality", "Security", "Adversarial"];
      if (!validStages.includes(stage)) {
        return { isError: true, content: [{ type: "text", text: `Invalid stage. Must be: ${validStages.join(", ")}` }] };
      }
      const insertScore = db.prepare("INSERT OR REPLACE INTO review_stage_scores (session_id, stage, dimension, score) VALUES (?, ?, ?, ?)");
      for (const [dim, score] of Object.entries(scores)) {
        insertScore.run(sid, stage, dim, score);
      }
      return {
        content: [{ type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` }]
      };
    }
    case "get_harness_report": {
      try {
        const metrics = readMetricsHistory(cwd);
        const auditLog = readAuditLog(cwd);
        const report = generateHarnessReport(metrics, auditLog);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "No harness data available yet." }] };
      }
    }
    case "get_handoff_document": {
      try {
        const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
        const fixes = db.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?").all(sid);
        const changedFiles = db.prepare("SELECT file_path FROM changed_files WHERE session_id = ?").all(sid);
        const disabledGates = db.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?").all(sid);
        const plan = getActivePlan();
        return {
          content: [{
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
          }]
        };
      } catch {
        return { content: [{ type: "text", text: "No active session data to hand off." }] };
      }
    }
    case "get_metrics_dashboard": {
      try {
        const metrics = readMetricsHistory(cwd);
        return { content: [{ type: "text", text: generateMetricsDashboard(metrics) }] };
      } catch {
        return { content: [{ type: "text", text: "No metrics data available yet." }] };
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
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${parsed.method}` } };
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
