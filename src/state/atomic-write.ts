import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Atomic JSON write: write to temp file, then rename.
 * rename() is atomic on POSIX when src and dst are on the same filesystem.
 * Prevents partial writes and read-during-write corruption.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
	const dir = join(filePath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, filePath);
}
