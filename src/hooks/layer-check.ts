/**
 * Architecture layer enforcement — regex-based import boundary checking.
 *
 * Inspired by OpenAI's 1M-line experiment structural tests.
 * Zero dependencies, <10ms per file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface LayersConfig {
	layers: Array<{ name: string; pattern: string }>;
	rules: Array<{ from: string; deny: string[]; message?: string }>;
}

export interface LayerViolation {
	file: string;
	line: number;
	importPath: string;
	fromLayer: string;
	toLayer: string;
	message: string;
}

// Regex covers: import ... from "...", require("..."), import("...")
const IMPORT_RE =
	/(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\))/g;

export function loadLayersConfig(cwd: string): LayersConfig | null {
	try {
		const configPath = join(cwd, ".alfred", "layers.json");
		if (!existsSync(configPath)) return null;
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		if (!raw?.layers || !raw?.rules) return null;
		return raw as LayersConfig;
	} catch {
		return null;
	}
}

export function resolveLayer(filePath: string, layers: LayersConfig["layers"]): string | null {
	for (const layer of layers) {
		if (new RegExp(layer.pattern).test(filePath)) {
			return layer.name;
		}
	}
	return null;
}

export function extractImports(content: string): Array<{ path: string; line: number }> {
	const results: Array<{ path: string; line: number }> = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		IMPORT_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IMPORT_RE.exec(lines[i]!)) !== null) {
			const importPath = match[1] ?? match[2] ?? match[3] ?? "";
			if (importPath) {
				results.push({ path: importPath, line: i + 1 });
			}
		}
	}

	return results;
}

function resolveImportToProjectPath(filePath: string, importPath: string, cwd: string): string {
	if (!importPath.startsWith(".")) {
		// Absolute or package import — not relevant for layer checks
		return importPath;
	}

	const dir = dirname(filePath);
	const resolved = resolve(dir, importPath);
	return relative(cwd, resolved);
}

export function checkLayerViolations(
	cwd: string,
	filePath: string,
	fileContent: string,
	config: LayersConfig,
): LayerViolation[] {
	const relPath = relative(cwd, filePath);
	const fromLayer = resolveLayer(relPath, config.layers);
	if (!fromLayer) return [];

	const rule = config.rules.find((r) => r.from === fromLayer);
	if (!rule || rule.deny.length === 0) return [];

	const deniedLayers = new Map<string, RegExp>();
	for (const denyName of rule.deny) {
		const layer = config.layers.find((l) => l.name === denyName);
		if (layer) deniedLayers.set(denyName, new RegExp(layer.pattern));
	}

	const imports = extractImports(fileContent);
	const violations: LayerViolation[] = [];

	for (const imp of imports) {
		const resolved = resolveImportToProjectPath(filePath, imp.path, cwd);

		for (const [layerName, re] of deniedLayers) {
			if (re.test(resolved)) {
				violations.push({
					file: relPath,
					line: imp.line,
					importPath: imp.path,
					fromLayer,
					toLayer: layerName,
					message: rule.message ?? `${fromLayer} cannot import from ${layerName}`,
				});
				break;
			}
		}
	}

	return violations.slice(0, 10);
}
