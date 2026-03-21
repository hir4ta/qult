import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// ── Git User Cache ──

const GIT_USER_CACHE = ".alfred/.state/git-user.json";

export function getGitUserName(projectPath: string): string {
	const cachePath = join(projectPath, GIT_USER_CACHE);
	try {
		if (existsSync(cachePath)) {
			const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as { name?: string };
			if (cached.name) return cached.name;
		}
	} catch { /* cache miss */ }

	// Fallback to git config
	try {
		const name = execFileSync("git", ["config", "user.name"], {
			cwd: projectPath,
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
		if (name) {
			writeGitUserCache(projectPath, name);
			return name;
		}
	} catch { /* git not configured */ }

	process.stderr.write("warning: git user.name not set, using 'unknown'\n");
	return "unknown";
}

export function refreshGitUserCache(projectPath: string): void {
	try {
		const name = execFileSync("git", ["config", "user.name"], {
			cwd: projectPath,
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
		if (name) writeGitUserCache(projectPath, name);
	} catch { /* ignore */ }
}

function writeGitUserCache(projectPath: string, name: string): void {
	const cachePath = join(projectPath, GIT_USER_CACHE);
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify({ name, updatedAt: new Date().toISOString() }), "utf-8");
	} catch { /* non-critical */ }
}

// ── Team Config ──

export interface TeamConfig {
	team: {
		name: string;
		spec_tracking: boolean;
		review_required: number;
		knowledge_sharing: boolean;
		activity_sharing: boolean;
		cross_project_search: boolean;
	};
}

const TEAM_YAML_PATH = ".alfred/team.yaml";

const DEFAULTS: TeamConfig["team"] = {
	name: "",
	spec_tracking: false,
	review_required: 1,
	knowledge_sharing: true,
	activity_sharing: false,
	cross_project_search: false,
};

export function loadTeamConfig(projectPath: string): TeamConfig | undefined {
	const filePath = join(projectPath, TEAM_YAML_PATH);
	if (!existsSync(filePath)) return undefined;

	try {
		// Dynamic import to avoid bundling yaml at top level
		const content = readFileSync(filePath, "utf-8");
		// Simple YAML parser for team.yaml (key: value format)
		const team = { ...DEFAULTS };
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("#") || !trimmed.includes(":")) continue;
			const [key, ...rest] = trimmed.split(":");
			const value = rest.join(":").trim();
			const k = key?.trim();
			if (k === "name") team.name = value.replace(/^["']|["']$/g, "");
			else if (k === "spec_tracking") team.spec_tracking = value === "true";
			else if (k === "review_required") team.review_required = Math.max(1, parseInt(value, 10) || 1);
			else if (k === "knowledge_sharing") team.knowledge_sharing = value !== "false";
			else if (k === "activity_sharing") team.activity_sharing = value === "true";
			else if (k === "cross_project_search") team.cross_project_search = value === "true";
		}
		return { team };
	} catch (err) {
		process.stderr.write(`warning: failed to parse team.yaml: ${err}\n`);
		return undefined;
	}
}

export function initTeamConfig(projectPath: string, opts?: Partial<TeamConfig["team"]>): void {
	const team = { ...DEFAULTS, ...opts };
	const filePath = join(projectPath, TEAM_YAML_PATH);
	mkdirSync(dirname(filePath), { recursive: true });

	const yaml = `# Alfred Team Configuration
team:
  name: "${team.name}"
  spec_tracking: ${team.spec_tracking}
  review_required: ${team.review_required}
  knowledge_sharing: ${team.knowledge_sharing}
  activity_sharing: ${team.activity_sharing}
  cross_project_search: ${team.cross_project_search}
`;
	writeFileSync(filePath, yaml, "utf-8");
}

export interface ResolvedConfig {
	specTracking: boolean;
	reviewRequired: number;
	knowledgeSharing: boolean;
	activitySharing: boolean;
	crossProjectSearch: boolean;
}

export function resolveConfig(projectPath: string): ResolvedConfig {
	const teamConfig = loadTeamConfig(projectPath);
	const team = teamConfig?.team ?? DEFAULTS;

	return {
		specTracking: envBool("ALFRED_SPEC_TRACKING") ?? team.spec_tracking,
		reviewRequired: envInt("ALFRED_REVIEW_REQUIRED") ?? team.review_required,
		knowledgeSharing: envBool("ALFRED_KNOWLEDGE_SHARING") ?? team.knowledge_sharing,
		activitySharing: envBool("ALFRED_ACTIVITY_SHARING") ?? team.activity_sharing,
		crossProjectSearch: envBool("ALFRED_CROSS_PROJECT_SEARCH") ?? team.cross_project_search,
	};
}

function envBool(key: string): boolean | undefined {
	const v = process.env[key];
	if (v === undefined) return undefined;
	return v === "true" || v === "1";
}

function envInt(key: string): number | undefined {
	const v = process.env[key];
	if (v === undefined) return undefined;
	const n = parseInt(v, 10);
	return Number.isNaN(n) ? undefined : Math.max(1, n);
}
