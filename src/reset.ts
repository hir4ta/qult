import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";

export function runReset(dryRun = false): { deleted: string[] } {
	const stateDir = join(process.cwd(), ".qult", ".state");
	if (!existsSync(stateDir)) return { deleted: [] };

	const files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
	const deleted: string[] = [];

	for (const file of files) {
		if (!dryRun) {
			rmSync(join(stateDir, file), { force: true });
		}
		deleted.push(file);
	}

	return { deleted };
}

export const resetCommand = defineCommand({
	meta: { description: "Reset qult state" },
	args: {
		dryRun: {
			type: "boolean",
			alias: "dry-run",
			description: "Show what would be deleted without deleting",
			default: false,
		},
	},
	async run({ args }) {
		const result = runReset(args.dryRun);
		const prefix = args.dryRun ? "[dry-run] " : "";
		if (result.deleted.length > 0) {
			console.log(`${prefix}Deleted: ${result.deleted.join(", ")}`);
		} else {
			console.log(`${prefix}No state files found.`);
		}
	},
});
