import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Atomic JSON write: write to temp file, then rename.
 * rename() is atomic on POSIX when src and dst are on the same filesystem.
 * Prevents partial writes and read-during-write corruption.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, filePath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// tmp may not exist if writeFileSync failed
		}
		throw err;
	}
}
