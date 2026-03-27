import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";

const KEEP_ON_HISTORY = ["gate-history.json", "metrics.json"];

export function runReset(
	keepHistory: boolean,
	dryRun = false,
): { deleted: string[]; kept: string[] } {
	const stateDir = join(process.cwd(), ".qult", ".state");
	if (!existsSync(stateDir)) return { deleted: [], kept: [] };

	const files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const deleted: string[] = [];
	const kept: string[] = [];

	for (const file of files) {
		if (keepHistory && KEEP_ON_HISTORY.includes(file)) {
			kept.push(file);
			continue;
		}
		if (!dryRun) {
			rmSync(join(stateDir, file), { force: true });
		}
		deleted.push(file);
	}

	return { deleted, kept };
}

export const resetCommand = defineCommand({
	meta: { description: "Reset qult state" },
	args: {
		keepHistory: {
			type: "boolean",
			alias: "keep-history",
			description: "Keep gate-history and metrics",
			default: false,
		},
		dryRun: {
			type: "boolean",
			alias: "dry-run",
			description: "Show what would be deleted without deleting",
			default: false,
		},
	},
	async run({ args }) {
		const result = runReset(args.keepHistory, args.dryRun);
		const prefix = args.dryRun ? "[dry-run] " : "";
		if (result.deleted.length > 0) {
			console.log(`${prefix}Deleted: ${result.deleted.join(", ")}`);
		}
		if (result.kept.length > 0) {
			console.log(`${prefix}Kept: ${result.kept.join(", ")}`);
		}
		if (result.deleted.length === 0 && result.kept.length === 0) {
			console.log(`${prefix}No state files found.`);
		}
	},
});
