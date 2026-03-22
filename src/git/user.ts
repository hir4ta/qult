import { execFileSync } from "node:child_process";

/** Get git user.name for the given project path. Returns "unknown" if not configured. */
export function getGitUserName(projectPath: string): string {
	try {
		const name = execFileSync("git", ["config", "user.name"], {
			cwd: projectPath,
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
		return name || "unknown";
	} catch {
		return "unknown";
	}
}
