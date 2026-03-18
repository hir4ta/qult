import { SpecDir, filesForSize } from "./types.js";
import type { SpecFile, SpecSize, SpecType } from "./types.js";

export interface ValidationCheck {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
}

export interface ValidationResult {
	checks: ValidationCheck[];
	passed: number;
	failed: number;
	warned: number;
	summary: string;
}

// --- ID extraction patterns ---

const ID = {
	FR: /FR-\d+/g,
	NFR: /NFR-\d+/g,
	T: /T-\d+\.\d+/g,
	TS: /TS-\d+\.\d+/g,
	DEC: /DEC-\d+/g,
	CHG: /CHG-\d+/g,
};

export function extractIDs(content: string, pattern: RegExp): string[] {
	return [...new Set(content.match(pattern) ?? [])];
}

// --- Gherkin validation ---

export function validateGherkin(content: string): { valid: boolean; issues: string[] } {
	const issues: string[] = [];
	// Find gherkin blocks (inside ```gherkin ... ```)
	const gherkinBlocks = content.match(/```gherkin\n([\s\S]*?)```/g);
	if (!gherkinBlocks || gherkinBlocks.length === 0) {
		return { valid: true, issues: [] }; // No gherkin blocks = skip
	}

	for (const block of gherkinBlocks) {
		const body = block.replace(/^```gherkin\n/, "").replace(/```$/, "").trim();
		if (!body) continue;
		const hasGiven = /\bGiven\b/i.test(body);
		const hasWhen = /\bWhen\b/i.test(body);
		const hasThen = /\bThen\b/i.test(body);
		if (!hasGiven && !hasWhen && !hasThen) {
			issues.push("Gherkin block missing Given/When/Then keywords");
		} else if (!hasThen) {
			issues.push("Gherkin block missing Then (expected result)");
		}
	}
	return { valid: issues.length === 0, issues };
}

// --- Placeholder detection ---

const PLACEHOLDER_PATTERNS = [
	/\[TODO\]/gi,
	/\[FIXME\]/gi,
	/\[Your text here\]/gi,
	/\[add description\]/gi,
	/\[TBD\]/gi,
];

function countPlaceholders(content: string): number {
	let count = 0;
	for (const pat of PLACEHOLDER_PATTERNS) {
		count += (content.match(pat) ?? []).length;
	}
	return count;
}

// --- Main validation ---

export function validateSpec(
	projectPath: string,
	taskSlug: string,
	size: SpecSize,
	specType: SpecType,
): ValidationResult {
	const sd = new SpecDir(projectPath, taskSlug);
	const expectedFiles = filesForSize(size, specType);
	const checks: ValidationCheck[] = [];

	// Helper to read file safely
	function readFile(f: SpecFile): string | null {
		try {
			return sd.readFile(f);
		} catch {
			return null;
		}
	}

	// ---- 1. required_sections ----
	for (const f of expectedFiles) {
		const content = readFile(f);
		if (content !== null) {
			checks.push({ name: `required_sections:${f}`, status: "pass", message: `${f} exists` });
		} else {
			checks.push({ name: `required_sections:${f}`, status: "fail", message: `${f} missing` });
		}
	}

	// Read primary file content
	const primaryFile: SpecFile = specType === "bugfix" ? "bugfix.md" : specType === "delta" ? "delta.md" : "requirements.md";
	const primaryContent = readFile(primaryFile) ?? "";
	const tasksContent = readFile("tasks.md") ?? "";
	const designContent = readFile("design.md") ?? "";
	const testSpecsContent = readFile("test-specs.md") ?? "";
	const researchContent = readFile("research.md") ?? "";

	// ---- Delta-specific checks (D only) ----
	if (size === "D") {
		const deltaContent = readFile("delta.md") ?? "";

		// 19. delta_sections_present
		// Check for required sections in both EN and JA templates.
		const requiredSectionsEN = ["Change Summary", "Files Affected", "Rationale", "Impact Scope", "Test Plan", "Rollback Strategy"];
		const requiredSectionsJA = ["変更概要", "影響ファイル", "変更理由", "影響範囲", "テスト計画", "ロールバック手順"];
		const enCount = requiredSectionsEN.filter((s) => deltaContent.includes(`## ${s}`)).length;
		const jaCount = requiredSectionsJA.filter((s) => deltaContent.includes(`## ${s}`)).length;
		const bestCount = Math.max(enCount, jaCount);
		checks.push(
			bestCount >= 6
				? { name: "delta_sections_present", status: "pass", message: "All delta sections present" }
				: { name: "delta_sections_present", status: "fail", message: `Only ${bestCount}/6 delta sections found` },
		);

		// 20. delta_change_ids
		const chgIDs = extractIDs(deltaContent, ID.CHG);
		checks.push(
			chgIDs.length > 0
				? { name: "delta_change_ids", status: "pass", message: `${chgIDs.length} CHG-N IDs found` }
				: { name: "delta_change_ids", status: "fail", message: "No CHG-N IDs found in delta.md" },
		);

		// 21. delta_before_after
		const hasBeforeAfter = /\bBefore:\s*/i.test(deltaContent) && /\bAfter:\s*/i.test(deltaContent);
		checks.push(
			hasBeforeAfter
				? { name: "delta_before_after", status: "pass", message: "Before/After blocks found" }
				: { name: "delta_before_after", status: "fail", message: "Missing Before/After blocks in delta.md" },
		);

		return buildResult(checks);
	}

	// ---- Non-delta checks ----

	// ---- 2. min_fr_count ----
	if (specType === "bugfix") {
		// Substantive content check for bugfix
		checks.push(
			primaryContent.length > 200
				? { name: "min_fr_count", status: "pass", message: "Bugfix has substantive content" }
				: { name: "min_fr_count", status: "warn", message: "Bugfix content may be insufficient" },
		);
	} else {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const minCount = size === "S" ? 1 : size === "M" ? 3 : size === "XL" ? 8 : 5; // L default 5
		// Template defaults start with 1 FR — warn instead of fail to allow incremental authoring (DEC-4/NFR-3).
		const status = frIDs.length >= minCount ? "pass" : frIDs.length > 0 ? "warn" : "fail";
		checks.push({
			name: "min_fr_count",
			status: status as "pass" | "fail" | "warn",
			message: `${frIDs.length} FR-N found (required: ≥${minCount} for ${size})`,
		});
	}

	// ---- 3. content_placeholder ----
	let totalPlaceholders = 0;
	for (const f of expectedFiles) {
		const c = readFile(f);
		if (c) totalPlaceholders += countPlaceholders(c);
	}
	checks.push(
		totalPlaceholders === 0
			? { name: "content_placeholder", status: "pass", message: "No placeholder text found" }
			: { name: "content_placeholder", status: "warn", message: `${totalPlaceholders} placeholder(s) found ([TODO], [FIXME], etc.)` },
	);

	// ---- 4. fr_to_task ----
	if (expectedFiles.includes("tasks.md") && specType !== "bugfix") {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const taskFRs = extractIDs(tasksContent, ID.FR);
		const unreferenced = frIDs.filter((fr) => !taskFRs.includes(fr));
		checks.push(
			unreferenced.length === 0
				? { name: "fr_to_task", status: "pass", message: "All FR-N referenced in tasks.md" }
				: { name: "fr_to_task", status: "fail", message: `FR not referenced in tasks.md: ${unreferenced.join(", ")}` },
		);
	}

	// ---- 5. task_to_fr ----
	if (expectedFiles.includes("tasks.md") && specType !== "bugfix") {
		const taskIDs = extractIDs(tasksContent, ID.T);
		// Check each task has Requirements: line with FR reference
		const taskLines = tasksContent.split("\n");
		const tasksWithFR: Set<string> = new Set();
		let currentTask = "";
		for (const line of taskLines) {
			const taskMatch = line.match(/###\s+(T-\d+\.\d+)/);
			if (taskMatch) currentTask = taskMatch[1]!;
			if (currentTask && /^-\s*Requirements:\s*FR-/i.test(line)) {
				tasksWithFR.add(currentTask);
			}
		}
		const orphanTasks = taskIDs.filter((t) => !tasksWithFR.has(t));
		checks.push(
			orphanTasks.length === 0
				? { name: "task_to_fr", status: "pass", message: "All T-N.N have Requirements: FR-N" }
				: { name: "task_to_fr", status: "warn", message: `Tasks without FR reference: ${orphanTasks.join(", ")}` },
		);
	}

	// ---- 6. design_fr_references ----
	if (expectedFiles.includes("design.md") && specType !== "bugfix") {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const designFRs = extractIDs(designContent, ID.FR);
		const unreferenced = frIDs.filter((fr) => !designFRs.includes(fr));
		checks.push(
			unreferenced.length === 0
				? { name: "design_fr_references", status: "pass", message: "All FR-N referenced in design.md" }
				: { name: "design_fr_references", status: "warn", message: `FR not in design.md: ${unreferenced.join(", ")}` },
		);
	}

	// ---- 7. testspec_fr_references ----
	if (expectedFiles.includes("test-specs.md")) {
		const tsIDs = extractIDs(testSpecsContent, ID.TS);
		// Check each TS has Source: FR-N
		const tsWithSource: Set<string> = new Set();
		const lines = testSpecsContent.split("\n");
		let currentTS = "";
		for (const line of lines) {
			const tsMatch = line.match(/##\s+(TS-\d+\.\d+)/);
			if (tsMatch) currentTS = tsMatch[1]!;
			if (currentTS && /^-\s*Source:\s*(FR-\d+|NFR-\d+)/i.test(line)) {
				tsWithSource.add(currentTS);
			}
		}
		const noSource = tsIDs.filter((ts) => !tsWithSource.has(ts));
		checks.push(
			noSource.length === 0
				? { name: "testspec_fr_references", status: "pass", message: "All TS-N.N have Source: FR/NFR reference" }
				: { name: "testspec_fr_references", status: "warn", message: `TS without Source: ${noSource.join(", ")}` },
		);
	}

	// ---- 8. closing_wave ----
	if (expectedFiles.includes("tasks.md")) {
		const hasClosing = /## Wave:\s*[Cc]losing/i.test(tasksContent);
		checks.push(
			hasClosing
				? { name: "closing_wave", status: "pass", message: "Closing wave found in tasks.md" }
				: { name: "closing_wave", status: "fail", message: "No Closing wave in tasks.md" },
		);
	}

	// ---- 9. gherkin_syntax ----
	if (expectedFiles.includes("test-specs.md")) {
		const gherkin = validateGherkin(testSpecsContent);
		checks.push(
			gherkin.valid
				? { name: "gherkin_syntax", status: "pass", message: "Gherkin syntax valid" }
				: { name: "gherkin_syntax", status: "warn", message: `Gherkin issues: ${gherkin.issues.join("; ")}` },
		);
	}

	// ---- 10. orphan_tests ----
	if (expectedFiles.includes("test-specs.md") && specType !== "bugfix") {
		const frIDs = new Set(extractIDs(primaryContent, ID.FR));
		const nfrIDs = new Set(extractIDs(primaryContent, ID.NFR));
		const lines = testSpecsContent.split("\n");
		const orphans: string[] = [];
		let currentTS = "";
		for (const line of lines) {
			const tsMatch = line.match(/##\s+(TS-\d+\.\d+)/);
			if (tsMatch) currentTS = tsMatch[1]!;
			if (currentTS && /^-\s*Source:/i.test(line)) {
				const refs = extractIDs(line, ID.FR).concat(extractIDs(line, ID.NFR));
				if (refs.length === 0 || !refs.some((r) => frIDs.has(r) || nfrIDs.has(r))) {
					orphans.push(currentTS);
				}
				currentTS = "";
			}
		}
		checks.push(
			orphans.length === 0
				? { name: "orphan_tests", status: "pass", message: "No orphan tests" }
				: { name: "orphan_tests", status: "warn", message: `Tests with no matching FR/NFR: ${orphans.join(", ")}` },
		);
	}

	// ---- 11. orphan_tasks ----
	if (expectedFiles.includes("tasks.md") && specType !== "bugfix") {
		const frIDs = new Set(extractIDs(primaryContent, ID.FR));
		const taskLines = tasksContent.split("\n");
		const orphans: string[] = [];
		let currentTask = "";
		for (const line of taskLines) {
			const taskMatch = line.match(/###\s+(T-\d+\.\d+)/);
			if (taskMatch) currentTask = taskMatch[1]!;
			if (currentTask && /^-\s*Requirements:/i.test(line)) {
				const refs = extractIDs(line, ID.FR);
				if (refs.length === 0 || !refs.some((r) => frIDs.has(r))) {
					orphans.push(currentTask);
				}
				currentTask = "";
			}
		}
		checks.push(
			orphans.length === 0
				? { name: "orphan_tasks", status: "pass", message: "No orphan tasks" }
				: { name: "orphan_tasks", status: "warn", message: `Tasks with no matching FR: ${orphans.join(", ")}` },
		);
	}

	// ---- 12. confidence_annotations ----
	if (specType !== "bugfix") {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const confidenceCount = (primaryContent.match(/<!--\s*confidence:/g) ?? []).length;
		checks.push(
			confidenceCount >= frIDs.length || frIDs.length === 0
				? { name: "confidence_annotations", status: "pass", message: `${confidenceCount} confidence annotations for ${frIDs.length} FRs` }
				: { name: "confidence_annotations", status: "warn", message: `${confidenceCount}/${frIDs.length} FRs have confidence annotations` },
		);
	}

	// ---- L/XL only checks ----
	if (size === "L" || size === "XL") {
		// 13. nfr_traceability
		const nfrIDs = extractIDs(primaryContent, ID.NFR);
		const taskNFRs = extractIDs(tasksContent, ID.NFR);
		const unreferencedNFR = nfrIDs.filter((n) => !taskNFRs.includes(n));
		checks.push(
			unreferencedNFR.length === 0 || nfrIDs.length === 0
				? { name: "nfr_traceability", status: "pass", message: "NFR-N traceability OK" }
				: { name: "nfr_traceability", status: "warn", message: `NFR not in tasks.md: ${unreferencedNFR.join(", ")}` },
		);

		// 14. (decisions_completeness removed — decisions saved via ledger directly)

		// 15. research_completeness
		const researchLen = researchContent.replace(/^#.*$/gm, "").replace(/<!--.*?-->/gs, "").trim().length;
		checks.push(
			researchLen > 100
				? { name: "research_completeness", status: "pass", message: "Research has substantive content" }
				: { name: "research_completeness", status: "warn", message: "Research content may be insufficient" },
		);
	}

	// ---- XL only checks ----
	if (size === "XL") {
		// 16. confidence_coverage
		const frIDs = extractIDs(primaryContent, ID.FR);
		const confidenceCount = (primaryContent.match(/<!--\s*confidence:/g) ?? []).length;
		const coverage = frIDs.length > 0 ? confidenceCount / frIDs.length : 1;
		checks.push(
			coverage >= 0.8
				? { name: "confidence_coverage", status: "pass", message: `${Math.round(coverage * 100)}% confidence coverage` }
				: { name: "confidence_coverage", status: "fail", message: `${Math.round(coverage * 100)}% confidence coverage (required: ≥80%)` },
		);

		// 17. xl_wave_count
		const waveHeaders = tasksContent.match(/## Wave\s+\d+/g) ?? [];
		checks.push(
			waveHeaders.length >= 4
				? { name: "xl_wave_count", status: "pass", message: `${waveHeaders.length} waves found` }
				: { name: "xl_wave_count", status: "fail", message: `${waveHeaders.length} waves found (required: ≥4 for XL)` },
		);

		// 18. xl_nfr_required
		const nfrIDs = extractIDs(primaryContent, ID.NFR);
		checks.push(
			nfrIDs.length > 0
				? { name: "xl_nfr_required", status: "pass", message: `${nfrIDs.length} NFR-N found` }
				: { name: "xl_nfr_required", status: "fail", message: "No NFR-N found (required for XL)" },
		);
	}

	// ---- 22. grounding_coverage (L/XL opt-in) ----
	if ((size === "L" || size === "XL") && primaryContent.includes("grounding:")) {
		const groundingMatches = primaryContent.match(/grounding:\s*(\w+)/g) ?? [];
		const speculative = groundingMatches.filter((g) => /speculative/i.test(g)).length;
		const ratio = groundingMatches.length > 0 ? speculative / groundingMatches.length : 0;
		checks.push(
			ratio <= 0.3
				? { name: "grounding_coverage", status: "pass", message: `${Math.round(ratio * 100)}% speculative` }
				: { name: "grounding_coverage", status: "fail", message: `${Math.round(ratio * 100)}% speculative (max: 30%)` },
		);
	}

	return buildResult(checks);
}

function buildResult(checks: ValidationCheck[]): ValidationResult {
	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	return {
		checks,
		passed,
		failed,
		warned,
		summary: `${passed}/${checks.length} passed, ${failed} failed, ${warned} warnings`,
	};
}
