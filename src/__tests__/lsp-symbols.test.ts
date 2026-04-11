import { describe, expect, it } from "vitest";
import { findUnusedImportsWithFallback } from "../lsp/symbols.ts";

describe("LSP symbols", () => {
	it("falls back to regex when LSP unavailable", async () => {
		// Pass null manager → should fall back to regex-based detection
		const result = await findUnusedImportsWithFallback("/nonexistent/file.ts", null);
		// With nonexistent file, regex fallback returns empty
		expect(result).toEqual([]);
	});
});
