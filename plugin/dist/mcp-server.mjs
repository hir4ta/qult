// @bun
// src/mcp-server.ts
import { createInterface } from "readline";

// src/state/db.ts
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var SCHEMA_VERSION = 3;
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
function findLatestSessionId() {
  const db = getDb();
  const projectId = getProjectId();
  const row = db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(projectId);
  return row?.id ?? null;
}

// src/gates/load.ts
var _cache;
function loadGates() {
  if (_cache !== undefined)
    return _cache;
  try {
    const db = getDb();
    const projectId = getProjectId();
    const rows = db.prepare("SELECT phase, gate_name, command, timeout, run_once_per_batch, extensions FROM gate_configs WHERE project_id = ?").all(projectId);
    if (rows.length === 0) {
      _cache = null;
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
    _cache = config;
    return config;
  } catch {
    _cache = null;
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
  _cache = undefined;
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
function appendAuditLog(entry) {
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
function readAuditLog() {
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
function readMetricsHistory() {
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
    "semantic-check"
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
  "reset_escalation_counters"
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
      const value = typeof args?.value === "number" ? args.value : null;
      if (!key || value === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing key or value parameter." }]
        };
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
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid key. Allowed: ${ALLOWED_KEYS.join(", ")}` }]
        };
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
        const report = generateHarnessReport(metrics, auditLog);
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
