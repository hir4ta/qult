import { detectDeadImports } from "../hooks/detectors/dead-import-check.ts";
import type { LspManager } from "./manager.ts";

/**
 * Find unused imports in a file, using LSP when available, regex fallback otherwise.
 * @param file - Absolute file path
 * @param manager - LSP manager instance, or null to use fallback
 * @returns Array of unused import names (advisory strings)
 */
export async function findUnusedImportsWithFallback(
	file: string,
	manager: LspManager | null,
): Promise<string[]> {
	// Try LSP if manager is available
	if (manager) {
		const client = manager.getClientSync(file);
		if (client) {
			try {
				// TODO: Implement LSP-based unused import detection
				// 1. textDocument/documentSymbol to get all symbols
				// 2. Filter for import symbols
				// 3. textDocument/references for each import symbol
				// 4. If references === 1 (only the import itself), it's unused
				// For now, fall through to regex-based detection
			} catch {
				// fail-open: fall through to regex
			}
		}
	}

	// Fallback: use existing regex-based detection
	return detectDeadImports(file);
}
