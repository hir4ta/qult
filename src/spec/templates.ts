import type { SpecFile, SpecSize, SpecType } from "./types.js";
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
): Map<SpecFile, string> {
	const lang = (process.env.ALFRED_LANG || "en").toLowerCase();
	const files = filesForSize(size, specType);
	const rendered = new Map<SpecFile, string>();
	for (const f of files) {
		rendered.set(f, renderTemplate(f, data, lang));
	}
	return rendered;
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
