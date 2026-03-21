import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { initTeamConfig, loadTeamConfig } from "./config.js";

export interface InitResult {
	teamYaml: boolean;
	gitattributes: boolean;
	mergeDriver: boolean;
	gitignore: boolean;
	templatesDir: boolean;
}

export interface JoinResult {
	mergeDriver: boolean;
	knowledgeSync: boolean;
	summary: string;
}

const MERGE_DRIVER_CMD = "alfred merge-driver %O %A %B";
const GITATTRIBUTES_LINE = ".alfred/knowledge/**/*.json merge=alfred-knowledge";
const SPECS_GITIGNORE_PATTERNS = [
	/^\.alfred\/specs\/?$/,
	/^\.alfred\/specs\/\*$/,
	/^\/\.alfred\/specs\/?$/,
	/^\/\.alfred\/specs\/\*$/,
];

/**
 * alfred team init — create team config and set up git integration.
 */
export function teamInit(projectPath: string, opts?: { name?: string }): InitResult {
	const result: InitResult = {
		teamYaml: false,
		gitattributes: false,
		mergeDriver: false,
		gitignore: false,
		templatesDir: false,
	};

	// 1. Create .alfred/team.yaml
	if (!loadTeamConfig(projectPath)) {
		initTeamConfig(projectPath, { name: opts?.name ?? "" });
		result.teamYaml = true;
	}

	// 2. .gitattributes — add merge driver
	const gitattributesPath = join(projectPath, ".gitattributes");
	let gitattributes = "";
	try {
		gitattributes = readFileSync(gitattributesPath, "utf-8");
	} catch { /* file may not exist */ }

	if (!gitattributes.includes("merge=alfred-knowledge")) {
		const newContent = gitattributes
			? `${gitattributes.trimEnd()}\n${GITATTRIBUTES_LINE}\n`
			: `${GITATTRIBUTES_LINE}\n`;
		writeFileSync(gitattributesPath, newContent, "utf-8");
		result.gitattributes = true;
	}

	// 3. git config — register merge driver
	try {
		execFileSync("git", ["config", "merge.alfred-knowledge.driver", MERGE_DRIVER_CMD], {
			cwd: projectPath,
			timeout: 5000,
		});
		result.mergeDriver = true;
	} catch {
		process.stderr.write("warning: failed to register git merge driver\n");
	}

	// 4. .gitignore — adjust for spec tracking
	const config = loadTeamConfig(projectPath);
	if (config?.team.spec_tracking) {
		result.gitignore = adjustGitignoreForSpecs(projectPath);
	}

	// 5. Create templates directory
	const templatesDir = join(projectPath, ".alfred", "templates", "specs");
	if (!existsSync(templatesDir)) {
		mkdirSync(templatesDir, { recursive: true });
		result.templatesDir = true;
	}

	return result;
}

/**
 * alfred team join — apply team config to local environment.
 */
export function teamJoin(projectPath: string): JoinResult {
	const config = loadTeamConfig(projectPath);
	if (!config) {
		throw new Error("team.yaml not found. Run 'alfred team init' first.");
	}

	const result: JoinResult = {
		mergeDriver: false,
		knowledgeSync: false,
		summary: "",
	};

	// 1. Register merge driver locally
	try {
		execFileSync("git", ["config", "merge.alfred-knowledge.driver", MERGE_DRIVER_CMD], {
			cwd: projectPath,
			timeout: 5000,
		});
		result.mergeDriver = true;
	} catch {
		process.stderr.write("warning: failed to register git merge driver\n");
	}

	// 2. Knowledge sync will happen on next SessionStart
	result.knowledgeSync = true;

	const parts: string[] = [];
	parts.push(`Team: ${config.team.name || "(unnamed)"}`);
	if (result.mergeDriver) parts.push("Merge driver: configured");
	parts.push("Knowledge: will sync on next session start");
	if (config.team.spec_tracking) parts.push("Spec tracking: enabled");
	if (config.team.cross_project_search) parts.push("Cross-project search: enabled");
	result.summary = parts.join("\n");

	return result;
}

function adjustGitignoreForSpecs(projectPath: string): boolean {
	const gitignorePath = join(projectPath, ".gitignore");
	if (!existsSync(gitignorePath)) return false;

	let content: string;
	try {
		content = readFileSync(gitignorePath, "utf-8");
	} catch {
		return false;
	}

	const lines = content.split("\n");
	let changed = false;
	const filtered = lines.filter((line) => {
		const trimmed = line.trim();
		// Skip comments and negations
		if (trimmed.startsWith("#") || trimmed.startsWith("!")) return true;
		// Check against known specs patterns
		for (const pattern of SPECS_GITIGNORE_PATTERNS) {
			if (pattern.test(trimmed)) {
				changed = true;
				return false;
			}
		}
		return true;
	});

	if (changed) {
		writeFileSync(gitignorePath, filtered.join("\n"), "utf-8");
	}
	return changed;
}
