/**
 * Convention rule engine — regex-based violation detection.
 * Only rules with a `check` field are mechanically enforced.
 * Rules without `check` remain as soft CONTEXT (injected at SessionStart).
 */

export interface ConventionRule {
	pattern: string;
	category: string;
	check?: {
		type: "regex";
		match: string;
		filePattern?: string;
	};
}

export interface ConventionViolation {
	rule: string;
	category: string;
	line?: number;
	detail: string;
}

/**
 * Check file content against convention rules with `check` field.
 * Returns violations (capped at 10).
 */
export function checkConventions(
	filePath: string,
	fileContent: string,
	rules: ConventionRule[],
): ConventionViolation[] {
	const violations: ConventionViolation[] = [];
	const lines = fileContent.split("\n");

	for (const rule of rules) {
		if (!rule.check || rule.check.type !== "regex") continue;

		// File pattern matching (simple glob: *.ts, *.go)
		if (rule.check.filePattern) {
			const ext = rule.check.filePattern.replace("*", "");
			if (!filePath.endsWith(ext)) continue;
		}

		const re = new RegExp(rule.check.match);
		for (let i = 0; i < lines.length; i++) {
			if (re.test(lines[i]!)) {
				violations.push({
					rule: rule.pattern,
					category: rule.category,
					line: i + 1,
					detail: lines[i]!.trim().slice(0, 100),
				});
			}
			if (violations.length >= 10) break;
		}
		if (violations.length >= 10) break;
	}

	return violations;
}
