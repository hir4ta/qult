/**
 * Template loader.
 *
 * bun build --compile: templates-bundle.ts が `import ... with { type: "text" }` で
 * テンプレートをバンドルに埋め込む (Bun 公式の text loader)。
 * require() で読み込み、失敗時はファイルシステムにフォールバック。
 *
 * dev/test (vitest): Vite は `with { type: "text" }` を処理できないため、
 * require() が失敗し、ファイルシステムから直接読む。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let embedded: Record<string, string> | null = null;
try {
	embedded = require("./templates-bundle.ts").TEMPLATES;
} catch {
	// Expected in vitest/dev — filesystem fallback below
}

export function getTemplate(name: string): string {
	if (embedded?.[name]) return embedded[name];

	const candidates = [
		join(import.meta.dirname, name),
		join(import.meta.dirname, "..", "templates", name),
		join(import.meta.dirname, "..", "..", "src", "templates", name),
	];
	for (const path of candidates) {
		if (existsSync(path)) return readFileSync(path, "utf-8");
	}
	throw new Error(`Template not found: ${name}`);
}
