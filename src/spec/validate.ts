import { SpecDir, allTasks as getAllTasks, closingWave, filesForSize, parseTasksFile } from "./types.js";
import type { SpecFile, SpecSize, SpecType, TasksFile, TestSpecsFile } from "./types.js";
import { detectCyclicDeps } from "../mcp/dossier/lifecycle.js";

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

// --- ID extraction (for Markdown files only) ---

const ID = {
	FR: /FR-\d+/g,
	NFR: /NFR-\d+/g,
};

function extractIDs(content: string, pattern: RegExp): string[] {
	return [...new Set(content.match(pattern) ?? [])];
}

// --- Placeholder detection (Markdown files only) ---

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

// --- JSON file helpers ---

function readJsonFile<T>(sd: SpecDir, f: SpecFile): T | null {
	try {
		return JSON.parse(sd.readFile(f));
	} catch {
		return null;
	}
}

// --- Main validation ---

export interface ValidateOptions {
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

	// Read file contents
	const primaryFile: SpecFile = specType === "bugfix" ? "bugfix.json" : "requirements.md";
	const primaryContent = readFile(primaryFile) ?? "";
	const designContent = readFile("design.md") ?? "";
	const researchContent = readFile("research.md") ?? "";

	// JSON files
	let tasksData: TasksFile | null = null;
	try { tasksData = parseTasksFile(sd.readFile("tasks.json")); } catch { /* missing */ }
	const testSpecsData = readJsonFile<TestSpecsFile>(sd, "test-specs.json");

	// Collect all task requirements from JSON
	const allTasksList = tasksData ? getAllTasks(tasksData) : [];
	const allTaskFRs = new Set(allTasksList.flatMap(t => t.requirements ?? []));
	const allTaskIDs = allTasksList.map(t => t.id);

	// ---- 2. min_fr_count ----
	if (specType === "bugfix") {
		const bugfix = readJsonFile<{ summary?: string; fix_strategy?: string }>(sd, "bugfix.json");
		const hasContent = bugfix && bugfix.summary && bugfix.fix_strategy;
		checks.push(
			hasContent
				? { name: "min_fr_count", status: "pass", message: "Bugfix has substantive content" }
				: { name: "min_fr_count", status: "warn", message: "Bugfix content may be insufficient" },
		);
	} else {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const minCount = size === "S" ? 1 : size === "M" ? 3 : 5;
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
		if (f.endsWith(".md")) {
			const c = readFile(f);
			if (c) totalPlaceholders += countPlaceholders(c);
		}
		// JSON files don't have placeholders in the traditional sense
	}
	checks.push(
		totalPlaceholders === 0
			? { name: "content_placeholder", status: "pass", message: "No placeholder text found" }
			: { name: "content_placeholder", status: "warn", message: `${totalPlaceholders} placeholder(s) found ([TODO], [FIXME], etc.)` },
	);

	// ---- 4. fr_to_task ----
	if (expectedFiles.includes("tasks.json") && specType !== "bugfix") {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const unreferenced = frIDs.filter(fr => !allTaskFRs.has(fr));
		checks.push(
			unreferenced.length === 0
				? { name: "fr_to_task", status: "pass", message: "All FR-N referenced in tasks.json" }
				: { name: "fr_to_task", status: "fail", message: `FR not referenced in tasks.json: ${unreferenced.join(", ")}` },
		);
	}

	// ---- 5. task_to_fr ----
	if (expectedFiles.includes("tasks.json") && specType !== "bugfix") {
		const tasksWithFR = allTasksList.filter(t => !t.id.startsWith("T-C.") && !t.id.match(/T-\d+\.R/i));
		const orphanTasks = tasksWithFR.filter(t => !t.requirements || t.requirements.length === 0);
		checks.push(
			orphanTasks.length === 0
				? { name: "task_to_fr", status: "pass", message: "All T-N.N have requirements" }
				: { name: "task_to_fr", status: "warn", message: `Tasks without FR reference: ${orphanTasks.map(t => t.id).join(", ")}` },
		);
	}

	// ---- 6. design_fr_references ----
	if (expectedFiles.includes("design.md") && specType !== "bugfix") {
		const frIDs = extractIDs(primaryContent, ID.FR);
		const designFRs = extractIDs(designContent, ID.FR);
		const unreferenced = frIDs.filter(fr => !designFRs.includes(fr));
		checks.push(
			unreferenced.length === 0
				? { name: "design_fr_references", status: "pass", message: "All FR-N referenced in design.md" }
				: { name: "design_fr_references", status: "warn", message: `FR not in design.md: ${unreferenced.join(", ")}` },
		);
	}

	// ---- 7. testspec_fr_references ----
	if (expectedFiles.includes("test-specs.json") && testSpecsData) {
		const noSource = testSpecsData.specs.filter(ts => !ts.source);
		checks.push(
			noSource.length === 0
				? { name: "testspec_fr_references", status: "pass", message: "All TS have source reference" }
				: { name: "testspec_fr_references", status: "warn", message: `TS without Source: ${noSource.map(ts => ts.id).join(", ")}` },
		);
	}

	// ---- 8. closing_wave ----
	if (expectedFiles.includes("tasks.json")) {
		checks.push(
			tasksData && closingWave(tasksData)
				? { name: "closing_wave", status: "pass", message: "Closing wave found in tasks.json" }
				: { name: "closing_wave", status: "fail", message: "No closing wave in tasks.json" },
		);
	}

	// ---- 8b. cyclic_deps ----
	if (expectedFiles.includes("tasks.json") && tasksData) {
		const hasDeps = getAllTasks(tasksData).some((t) => t.depends && t.depends.length > 0);
		if (hasDeps) {
			const cyclic = detectCyclicDeps(tasksData);
			checks.push(
				cyclic.length === 0
					? { name: "cyclic_deps", status: "pass", message: "No circular dependencies" }
					: { name: "cyclic_deps", status: "fail", message: `Circular dependency: ${cyclic.join(", ")}` },
			);
		}
	}

	// ---- 9. gherkin_syntax ----
	if (expectedFiles.includes("test-specs.json") && testSpecsData) {
		const issues: string[] = [];
		for (const spec of testSpecsData.specs) {
			for (const scenario of spec.scenarios) {
				const hasGiven = scenario.steps.some(s => /^Given\b/i.test(s));
				const hasThen = scenario.steps.some(s => /^Then\b/i.test(s));
				if (!hasGiven && !hasThen) {
					issues.push(`${spec.id}/${scenario.name}: missing Given/Then`);
				} else if (!hasThen) {
					issues.push(`${spec.id}/${scenario.name}: missing Then`);
				}
			}
		}
		checks.push(
			issues.length === 0
				? { name: "gherkin_syntax", status: "pass", message: "Gherkin syntax valid" }
				: { name: "gherkin_syntax", status: "warn", message: `Gherkin issues: ${issues.join("; ")}` },
		);
	}

	// ---- 10. orphan_tests ----
	if (expectedFiles.includes("test-specs.json") && testSpecsData && specType !== "bugfix") {
		const frIDs = new Set(extractIDs(primaryContent, ID.FR));
		const nfrIDs = new Set(extractIDs(primaryContent, ID.NFR));
		const orphans = testSpecsData.specs.filter(ts => {
			if (!ts.source) return false;
			const refs = extractIDs(ts.source, ID.FR).concat(extractIDs(ts.source, ID.NFR));
			return refs.length > 0 && !refs.some(r => frIDs.has(r) || nfrIDs.has(r));
		});
		checks.push(
			orphans.length === 0
				? { name: "orphan_tests", status: "pass", message: "No orphan tests" }
				: { name: "orphan_tests", status: "warn", message: `Tests with no matching FR/NFR: ${orphans.map(t => t.id).join(", ")}` },
		);
	}

	// ---- 11. orphan_tasks ----
	if (expectedFiles.includes("tasks.json") && tasksData && specType !== "bugfix") {
		const frIDs = new Set(extractIDs(primaryContent, ID.FR));
		const orphans = allTasksList
			.filter(t => !t.id.startsWith("T-C.") && !t.id.match(/T-\d+\.R/i))
			.filter(t => {
				const refs = t.requirements ?? [];
				return refs.length > 0 && !refs.some(r => frIDs.has(r));
			});
		checks.push(
			orphans.length === 0
				? { name: "orphan_tasks", status: "pass", message: "No orphan tasks" }
				: { name: "orphan_tasks", status: "warn", message: `Tasks with no matching FR: ${orphans.map(t => t.id).join(", ")}` },
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
		if (specType !== "bugfix") {
			const nfrIDs = extractIDs(primaryContent, ID.NFR);
			const taskNFRs = new Set(allTasksList.flatMap(t => (t.requirements ?? []).filter(r => r.startsWith("NFR-"))));
			const unreferencedNFR = nfrIDs.filter(n => !taskNFRs.has(n));
			checks.push(
				unreferencedNFR.length === 0 || nfrIDs.length === 0
					? { name: "nfr_traceability", status: "pass", message: "NFR-N traceability OK" }
					: { name: "nfr_traceability", status: "warn", message: `NFR not in tasks.json: ${unreferencedNFR.join(", ")}` },
			);
		}

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
		const speculative = groundingMatches.filter(g => /speculative/i.test(g)).length;
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
	if (opts?.strict) {
		for (const c of checks) {
			if (c.status === "warn") c.status = "fail";
		}
	}
	const passed = checks.filter(c => c.status === "pass").length;
	const failed = checks.filter(c => c.status === "fail").length;
	const warned = checks.filter(c => c.status === "warn").length;
	return {
		checks,
		passed,
		failed,
		warned,
		summary: `${passed}/${checks.length} passed, ${failed} failed, ${warned} warnings`,
	};
}
