import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Security note: .qult/ is gitignored by `qult init`, so this file is user-local.
// Commands in this file run on session start — only trusted configs should be placed here.
const CONFIG_FILE = ".qult/context-providers.json";

export interface ContextProvider {
	command: string;
	timeout?: number;
	inject_on: string;
}

/** Load context providers from .qult/context-providers.json. Returns null if not found. */
export function loadContextProviders(): Record<string, ContextProvider> | null {
	try {
		const path = join(process.cwd(), CONFIG_FILE);
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Run all providers matching the given trigger and return their outputs. Fail-open per provider. */
export function runProviders(trigger: string): string[] {
	const providers = loadContextProviders();
	if (!providers) return [];

	const results: string[] = [];
	for (const [name, provider] of Object.entries(providers)) {
		if (provider.inject_on !== trigger) continue;
		try {
			const output = execSync(provider.command, {
				encoding: "utf-8",
				timeout: provider.timeout ?? 5000,
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (output) {
				results.push(`[${name}] ${output}`);
			}
		} catch {
			// fail-open: skip this provider
		}
	}
	return results;
}
