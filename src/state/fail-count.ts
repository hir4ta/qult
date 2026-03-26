import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = ".alfred/.state";
const FAIL_FILE = "fail-count.json";

interface FailCount {
	signature: string;
	count: number;
}

function failPath(): string {
	return join(process.cwd(), STATE_DIR, FAIL_FILE);
}

/** Read current fail count. Returns null on error (fail-open). */
export function readFailCount(): FailCount | null {
	try {
		const path = failPath();
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Record a failure. Increments count if same signature, resets if different. */
export function recordFailure(signature: string): number {
	try {
		const current = readFailCount();
		const count = current?.signature === signature ? current.count + 1 : 1;
		const dir = join(process.cwd(), STATE_DIR);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(failPath(), JSON.stringify({ signature, count }));
		return count;
	} catch {
		return 1;
	}
}

/** Clear fail count (on success). */
export function clearFailCount(): void {
	try {
		const path = failPath();
		if (existsSync(path)) {
			writeFileSync(path, JSON.stringify({ signature: "", count: 0 }));
		}
	} catch {
		// fail-open
	}
}
