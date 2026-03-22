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

function extractIDs(content: string, pattern: RegExp): string[] {
	return [...new Set(content.match(pattern) ?? [])];
}

// --- Gherkin validation ---

function validateGherkin(content: string): { valid: boolean; issues: string[] } {
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

export interface ValidateOptions {
	/** When true, promote all "warn" results to "fail". Use at completion time. */
	strict?: boolean;
}

export function validateSpec(
	projectPath: string,
	taskSlug: string,
	size: SpecSize,
	specType: SpecType,
	opts?: ValidateOptions,
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
	const primaryFile: SpecFile = specType === "bugfix" ? "bugfix.md" : "requirements.md";
	const primaryContent = readFile(primaryFile) ?? "";
	const tasksContent = readFile("tasks.md") ?? "";
	const designContent = readFile("design.md") ?? "";
	const testSpecsContent = readFile("test-specs.md") ?? "";
	const researchContent = readFile("research.md") ?? "";

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
		const minCount = size === "S" ? 1 : size === "M" ? 3 : 5; // L default 5
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
		// Check each task has FR reference in one of three formats:
		//   ### T-1.1 header + "- Requirements: FR-N" line
		//   - [ ] T-1.1 checkbox + "_Requirements: FR-N_" italic line
		//   - [ ] T-1.1 (FR-1, FR-2): inline FR reference on the task line itself
		const taskLines = tasksContent.split("\n");
		const tasksWithFR: Set<string> = new Set();
		let currentTask = "";
		for (const line of taskLines) {
			const taskMatch = line.match(/(?:###\s+|[-*]\s+\[[ xX]\]\s+)(T-\d+\.\d+)/);
			if (taskMatch) {
				currentTask = taskMatch[1]!;
				// Inline FR reference on the same line: T-1.1 (FR-1, FR-2): ...
				const inlineFRs = extractIDs(line, ID.FR);
				if (inlineFRs.length > 0) tasksWithFR.add(currentTask);
			}
			if (currentTask && /(?:^[-\s]*|_)Requirements:\s*(?:FR-|NFR-|全|all\b)/i.test(line)) {
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
		let currentTSList: string[] = [];
		for (const line of lines) {
			// Single TS header: ### TS-1.1: ...
			const tsSingle = line.match(/#{2,3}\s+(TS-\d+\.\d+)(?:\s|:)/);
			// Range TS header: ### TS-3.2 - TS-3.5: ...
			const tsRange = line.match(/#{2,3}\s+TS-(\d+)\.(\d+)\s*[-–]\s*TS-\d+\.(\d+)/);
			if (tsRange) {
				const wave = tsRange[1]!;
				const from = parseInt(tsRange[2]!, 10);
				const to = parseInt(tsRange[3]!, 10);
				currentTSList = [];
				for (let i = from; i <= to; i++) currentTSList.push(`TS-${wave}.${i}`);
			} else if (tsSingle) {
				currentTSList = [tsSingle[1]!];
			}
			if (
				currentTSList.length > 0 &&
				(/^-\s*Source:\s*(FR-\d+|NFR-\d+)/i.test(line) ||
					/<!--\s*source:\s*(FR-\d+|NFR-\d+)/i.test(line))
			) {
				for (const ts of currentTSList) tsWithSource.add(ts);
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
		const hasClosing = /## (?:Wave:\s*)?[Cc]losing(?:\s+[Ww]ave)?/i.test(tasksContent);
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

	// ---- L only checks ----
	if (size === "L") {
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

	// ---- 22. grounding_coverage (L opt-in) ----
	if (size === "L" && primaryContent.includes("grounding:")) {
		const groundingMatches = primaryContent.match(/grounding:\s*(\w+)/g) ?? [];
		const speculative = groundingMatches.filter((g) => /speculative/i.test(g)).length;
		const ratio = groundingMatches.length > 0 ? speculative / groundingMatches.length : 0;
		checks.push(
			ratio <= 0.3
				? { name: "grounding_coverage", status: "pass", message: `${Math.round(ratio * 100)}% speculative` }
				: { name: "grounding_coverage", status: "fail", message: `${Math.round(ratio * 100)}% speculative (max: 30%)` },
		);
	}

	return buildResult(checks, opts);
}

function buildResult(checks: ValidationCheck[], opts?: ValidateOptions): ValidationResult {
	// Strict mode: promote all warnings to failures (used at completion time).
	if (opts?.strict) {
		for (const c of checks) {
			if (c.status === "warn") c.status = "fail";
		}
	}
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
