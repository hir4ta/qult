import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BugfixFile, SpecFile, SpecSize, SpecType, TasksFile, TestSpecsFile } from "./types.js";
import { filesForSize } from "./types.js";

// English templates
import enRequirements from "./templates/en/requirements.tmpl";
import enBugfix from "./templates/en/bugfix.tmpl";
import enDesign from "./templates/en/design.tmpl";
import enTasks from "./templates/en/tasks.tmpl";
import enTestSpecs from "./templates/en/test-specs.tmpl";
import enResearch from "./templates/en/research.tmpl";

// Japanese templates
import jaRequirements from "./templates/ja/requirements.tmpl";
import jaBugfix from "./templates/ja/bugfix.tmpl";
import jaDesign from "./templates/ja/design.tmpl";
import jaTasks from "./templates/ja/tasks.tmpl";
import jaTestSpecs from "./templates/ja/test-specs.tmpl";
import jaResearch from "./templates/ja/research.tmpl";

export interface TemplateData {
	taskSlug: string;
	description: string;
	date: string;
	specType: string;
}

const EN_TEMPLATES: Record<string, string> = {
	"requirements.md": enRequirements,
	"bugfix.md": enBugfix,
	"design.md": enDesign,
	"tasks.md": enTasks,
	"test-specs.md": enTestSpecs,
	"research.md": enResearch,
};

const JA_TEMPLATES: Record<string, string> = {
	"requirements.md": jaRequirements,
	"bugfix.md": jaBugfix,
	"design.md": jaDesign,
	"tasks.md": jaTasks,
	"test-specs.md": jaTestSpecs,
	"research.md": jaResearch,
};

const DEFAULT_DESCRIPTIONS: Record<string, string> = {
	en: "No description provided.",
	ja: "説明なし",
};

export function renderForSize(
	size: SpecSize,
	specType: SpecType,
	data: TemplateData,
	projectPath?: string,
): Map<SpecFile, string> {
	const lang = (process.env.ALFRED_LANG || "en").toLowerCase();
	const files = filesForSize(size, specType);
	const rendered = new Map<SpecFile, string>();
	for (const f of files) {
		// JSON files: generate from TypeScript functions
		if (f.endsWith(".json")) {
			rendered.set(f, generateJsonTemplate(f, data, lang));
			continue;
		}
		// Markdown files: 2-layer resolution: custom template > built-in default
		const custom = projectPath ? tryReadCustomTemplate(projectPath, f) : undefined;
		if (custom) {
			rendered.set(f, applyTemplateVars(custom, data, lang));
		} else {
			rendered.set(f, renderTemplate(f, data, lang));
		}
	}
	return rendered;
}

function generateJsonTemplate(file: SpecFile, data: TemplateData, lang: string): string {
	switch (file) {
		case "tasks.json":
			return JSON.stringify(generateTasksTemplate(data, lang), null, 2) + "\n";
		case "test-specs.json":
			return JSON.stringify(generateTestSpecsTemplate(data, lang), null, 2) + "\n";
		case "bugfix.json":
			return JSON.stringify(generateBugfixTemplate(data, lang), null, 2) + "\n";
		default:
			return "{}\n";
	}
}

function generateTasksTemplate(data: TemplateData, lang: string): TasksFile {
	const isJa = lang === "ja";
	return {
		slug: data.taskSlug,
		waves: [
			{
				key: 1,
				title: isJa ? "[Wave 名]" : "[Wave Name]",
				tasks: [
					{
						id: "T-1.1",
						title: isJa ? "[タスクタイトル]" : "[Task Title]",
						size: "M",
						checked: false,
						requirements: ["FR-1"],
						files: [],
						verify: isJa ? "[完了条件]" : "[Done condition]",
					},
				],
			},
		],
		closing: {
			key: "closing",
			title: "Closing",
			tasks: [
				{ id: "T-C.1", title: isJa ? "最終セルフレビュー" : "Final self-review", checked: false },
				{ id: "T-C.2", title: isJa ? "CLAUDE.md / README 更新" : "Update CLAUDE.md / README if needed", checked: false },
				{ id: "T-C.3", title: isJa ? "テスト通過確認" : "Verify tests pass", checked: false },
				{ id: "T-C.4", title: isJa ? "ナレッジ保存" : "Save key learnings via ledger save", checked: false },
			],
		},
	};
}

function generateTestSpecsTemplate(data: TemplateData, lang: string): TestSpecsFile {
	const isJa = lang === "ja";
	return {
		specs: [
			{
				id: "TS-1.1",
				title: isJa ? "[テスト名]" : "[Test Name]",
				source: "FR-1",
				scenarios: [
					{
						name: isJa ? "[シナリオ名]" : "[Scenario Name]",
						steps: [
							isJa ? "Given [前提条件]" : "Given [precondition]",
							isJa ? "When [操作]" : "When [action]",
							isJa ? "Then [期待結果]" : "Then [expected result]",
						],
					},
				],
			},
		],
	};
}

function generateBugfixTemplate(data: TemplateData, lang: string): BugfixFile {
	const isJa = lang === "ja";
	return {
		summary: data.description || (isJa ? "[バグの概要]" : "[Bug Summary]"),
		severity: "P2",
		impact: isJa ? "[影響範囲]" : "[Impact]",
		reproduction_steps: [
			isJa ? "[手順1]" : "[Step 1]",
			isJa ? "[手順2]" : "[Step 2]",
		],
		root_cause: isJa ? "[根本原因]" : "[Root Cause]",
		five_whys: [
			isJa ? "なぜ？→" : "Why? →",
		],
		fix_strategy: isJa ? "[修正方針]" : "[Fix Strategy]",
		regression_prevention: isJa ? "[回帰防止策]" : "[Regression Prevention]",
	};
}

function tryReadCustomTemplate(projectPath: string, file: SpecFile): string | undefined {
	const customPath = join(projectPath, ".alfred", "templates", "specs", file);
	if (!existsSync(customPath)) return undefined;
	try {
		const content = readFileSync(customPath, "utf-8");
		if (!content.trim()) {
			process.stderr.write(`warning: custom template ${file} is empty, using default\n`);
			return undefined;
		}
		return content;
	} catch (err) {
		process.stderr.write(`warning: cannot read custom template ${file}: ${err}\n`);
		return undefined;
	}
}

function applyTemplateVars(tmpl: string, data: TemplateData, lang: string): string {
	const description = data.description || DEFAULT_DESCRIPTIONS[lang] || DEFAULT_DESCRIPTIONS.en!;
	return `${TEMPLATE_MARKER}\n${tmpl
		.replace(/\{\{taskSlug\}\}/g, data.taskSlug)
		.replace(/\{\{description\}\}/g, description)
		.replace(/\{\{date\}\}/g, data.date)
		.replace(/\{\{specType\}\}/g, data.specType)}`;
}

export const TEMPLATE_MARKER = "<!-- alfred:template -->";

function renderTemplate(file: SpecFile, data: TemplateData, lang: string): string {
	const templates = lang === "ja" ? JA_TEMPLATES : EN_TEMPLATES;
	const tmpl = templates[file];
	if (!tmpl) return `# ${file}\n`;

	const description = data.description || DEFAULT_DESCRIPTIONS[lang] || DEFAULT_DESCRIPTIONS.en!;

	const rendered = tmpl
		.replace(/\{\{taskSlug\}\}/g, data.taskSlug)
		.replace(/\{\{description\}\}/g, description)
		.replace(/\{\{date\}\}/g, data.date)
		.replace(/\{\{specType\}\}/g, data.specType);

	return `${TEMPLATE_MARKER}\n${rendered}`;
}

/**
 * Strip template content from a file if the marker is present.
 * Template content = everything from the marker line to the end of the file
 * (since templates are the initial file content from init).
 * If the file has been manually edited after the template (content added
 * before the marker somehow), only the marker and content after it are stripped.
 * In practice, the marker is always at line 1, so this returns "".
 */
export function stripTemplate(content: string): string {
	if (!content.includes(TEMPLATE_MARKER)) return content;
	// Marker is at the start (init places it at line 1). Return empty.
	return "";
}
