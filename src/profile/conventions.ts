/**
 * Generate language/framework-specific base conventions from project profile.
 * Deep project-specific conventions are handled by /alfred:conventions skill.
 */
import type { ProjectProfile } from "./detect.js";

export interface Convention {
	pattern: string;
	category: string;
}

export function generateBaseConventions(profile: ProjectProfile): Convention[] {
	const conventions: Convention[] = [];

	// ── Common ──
	conventions.push(
		{ pattern: "Prefer early return over deeply nested if/else", category: "style" },
		{ pattern: "Remove unused imports — do not leave dead code", category: "imports" },
	);

	// ── Linter ──
	if (profile.linter !== "unknown") {
		conventions.push({
			pattern: `Follow ${profile.linter} rules for formatting and lint — do not override or disable rules without justification`,
			category: "style",
		});
	}

	// ── Test framework ──
	if (profile.testFramework !== "unknown") {
		const naming = getTestNaming(profile);
		if (naming) {
			conventions.push({
				pattern: `Test files use ${naming} naming convention`,
				category: "testing",
			});
		}
		conventions.push({
			pattern: "Each test must have at least 2 meaningful assertions",
			category: "testing",
		});
	}

	// ── Language-specific ──
	for (const lang of profile.languages) {
		conventions.push(...getLanguageConventions(lang, profile));
	}

	return conventions;
}

function getTestNaming(profile: ProjectProfile): string | null {
	if (profile.testPattern) return profile.testPattern;
	for (const lang of profile.languages) {
		switch (lang) {
			case "typescript":
			case "javascript":
				return "*.test.ts / *.test.js";
			case "python":
				return "test_*.py";
			case "go":
				return "*_test.go";
			case "rust":
				return "#[cfg(test)] module or tests/ directory";
		}
	}
	return null;
}

function getLanguageConventions(lang: string, _profile: ProjectProfile): Convention[] {
	switch (lang) {
		case "typescript":
			return [
				{
					pattern:
						"Use strict TypeScript — avoid `any` type, prefer explicit types at module boundaries",
					category: "style",
				},
				{ pattern: "Use `import type` for type-only imports", category: "imports" },
			];
		case "javascript":
			return [
				{
					pattern: "Use const by default, let only when reassignment is needed",
					category: "style",
				},
			];
		case "python":
			return [
				{ pattern: "Use type hints for function signatures", category: "style" },
				{ pattern: "Use pathlib.Path over os.path for path operations", category: "style" },
			];
		case "go":
			return [
				{
					pattern: "Handle errors explicitly — never use _ for error returns",
					category: "error-handling",
				},
				{ pattern: "Use table-driven tests", category: "testing" },
			];
		case "rust":
			return [
				{
					pattern: "Use Result<T, E> for recoverable errors, panic only for unrecoverable",
					category: "error-handling",
				},
				{ pattern: "Prefer &str over String for function parameters", category: "style" },
			];
		default:
			return [];
	}
}
