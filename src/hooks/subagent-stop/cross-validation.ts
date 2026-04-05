import { readPendingFixes } from "../../state/pending-fixes.ts";
import { getActivePlan } from "../../state/plan-status.ts";
import { readSessionState } from "../../state/session-state.ts";

export interface CrossValidationResult {
	contradictions: string[];
}

const NO_ISSUES_RE = /no issues found/i;
const ALL_COMPLETE_RE = /all tasks?\s+(?:complete|done|implemented)/i;

/** Cross-validate reviewer output against computational detector results.
 *  Returns contradictions found. Fail-open: returns empty on any error. */
export function crossValidate(output: string, stageName: string): CrossValidationResult {
	try {
		const contradictions: string[] = [];

		if (stageName === "Security") {
			checkSecurityContradiction(output, contradictions);
		} else if (stageName === "Spec") {
			checkSpecContradiction(output, contradictions);
		} else if (stageName === "Quality") {
			checkQualityContradiction(output, contradictions);
		}

		return { contradictions };
	} catch {
		// fail-open
		return { contradictions: [] };
	}
}

function checkSecurityContradiction(output: string, contradictions: string[]): void {
	if (!NO_ISSUES_RE.test(output)) return;

	const fixes = readPendingFixes().filter((f) => f.gate === "security-check");
	if (fixes.length > 0) {
		const files = fixes.map((f) => f.file).join(", ");
		contradictions.push(
			`Security reviewer declared "No issues found" but security-check detector found ${fixes.length} issue(s) in: ${files}`,
		);
	}
}

function checkSpecContradiction(output: string, contradictions: string[]): void {
	if (!ALL_COMPLETE_RE.test(output)) return;

	const plan = getActivePlan();
	if (plan) {
		const pending = plan.tasks.filter((t) => t.status === "pending" || t.status === "in-progress");
		if (pending.length > 0) {
			const names = pending.map((t) => t.name).join(", ");
			contradictions.push(
				`Spec reviewer claims all tasks complete but plan has ${pending.length} pending task(s): ${names}`,
			);
		}
	}

	// Check gate failures: repeated failures (3+) indicate unresolved issues
	try {
		const state = readSessionState();
		const failures = state.gate_failure_counts ?? {};
		const repeatedFailures = Object.entries(failures).filter(([, count]) => count >= 3);
		if (repeatedFailures.length > 0) {
			const files = repeatedFailures.map(([key]) => key).join(", ");
			contradictions.push(
				`Spec reviewer claims all tasks complete but ${repeatedFailures.length} gate failure(s) with 3+ repeats: ${files}`,
			);
		}
	} catch {
		/* fail-open */
	}
}

function checkQualityContradiction(output: string, contradictions: string[]): void {
	if (!NO_ISSUES_RE.test(output)) return;

	try {
		const state = readSessionState();
		const deadImports = state.dead_import_warning_count ?? 0;
		const driftWarnings = state.drift_warning_count ?? 0;

		if (deadImports >= 3) {
			contradictions.push(
				`Quality reviewer declared "No issues found" but session has ${deadImports} dead-import warnings`,
			);
		}
		if (driftWarnings >= 3) {
			contradictions.push(
				`Quality reviewer declared "No issues found" but session has ${driftWarnings} convention drift warnings`,
			);
		}

		const testQuality = state.test_quality_warning_count ?? 0;
		if (testQuality >= 3) {
			contradictions.push(
				`Quality reviewer declared "No issues found" but session has ${testQuality} test quality warnings`,
			);
		}

		const duplication = state.duplication_warning_count ?? 0;
		if (duplication >= 3) {
			contradictions.push(
				`Quality reviewer declared "No issues found" but session has ${duplication} duplication warnings`,
			);
		}
	} catch {
		/* fail-open */
	}
}
