import { appendAudit } from "../spec/audit.js";
import { SpecDir } from "../spec/types.js";
import type { Store } from "../store/index.js";
import { upsertKnowledge } from "../store/knowledge.js";
import { detectProject } from "../store/project.js";
import type { DecisionEntry, KnowledgeRow, PatternEntry } from "../types.js";
import { truncate } from "./helpers.js";
import { writeKnowledgeFile } from "./ledger.js";

// --- Decision extraction from decisions.md content ---

export function extractDecisions(content: string, taskSlug: string, lang: string): DecisionEntry[] {
	const entries: DecisionEntry[] = [];
	const now = new Date().toISOString();

	const sections = content.split(/\n## DEC-\d+/);
	for (let i = 1; i < sections.length; i++) {
		const section = sections[i]!;
		const titleMatch = section.match(/^:\s*(.+)/);
		const title = titleMatch ? titleMatch[1]!.trim() : `Decision ${i}`;
		const statusMatch = section.match(/(?:- |\*\*)?Status:?\*?\*?\s*(\w+)/i);
		if (!statusMatch || statusMatch[1]!.toLowerCase() !== "accepted") continue;

		const decisionMatch = section.match(/\*\*Decision:\*\*\s*(.+)/i);
		const reasoningMatch =
			section.match(/\*\*Rationale:\*\*\s*(.+)/i) ??
			section.match(/\*\*Reasoning:\*\*\s*(.+)/i);
		const alternativesMatch = section.match(/\*\*Alternatives rejected:\*\*\s*(.+)/i);

		entries.push({
			id: `dec-spec-${taskSlug}-${i}`,
			title,
			context: (section.match(/\*\*Context:\*\*\s*(.+)/i)?.[1] ?? "").trim(),
			decision: (decisionMatch?.[1] ?? "").trim(),
			reasoning: (reasoningMatch?.[1] ?? "").trim(),
			alternatives: alternativesMatch
				? alternativesMatch[1]!
						.split(/[;,]/)
						.map((a) => a.trim())
						.filter(Boolean)
				: [],
			tags: [taskSlug],
			createdAt: now,
			status: "approved",
			lang,
		});
	}
	return entries;
}

// --- Review findings extraction from tool_response text ---

const SEVERITY_PATTERNS = [
	/\[CRITICAL\]/gi,
	/\[critical\]/g,
	/severity:\s*"?critical"?/gi,
	/\[HIGH\]/gi,
	/\[high\]/g,
	/severity:\s*"?high"?/gi,
];

const MAX_FINDINGS_PER_EXTRACTION = 3;

export function extractReviewFindings(
	toolResponse: unknown,
	taskSlug: string,
	lang: string,
): PatternEntry[] {
	const text = stringifyResponse(toolResponse);
	if (!text || text.length < 50) return [];

	const entries: PatternEntry[] = [];
	const now = new Date().toISOString();
	const lines = text.split("\n");

	for (let i = 0; i < lines.length && entries.length < MAX_FINDINGS_PER_EXTRACTION; i++) {
		const line = lines[i]!;
		const isCriticalOrHigh = SEVERITY_PATTERNS.some((p) => {
			p.lastIndex = 0; // reset global regex
			return p.test(line);
		});
		if (!isCriticalOrHigh) continue;

		// Extract description: the line itself + next few lines for context.
		const description = lines
			.slice(i, Math.min(i + 3, lines.length))
			.join(" ")
			.replace(/\[CRITICAL\]|\[HIGH\]|\[critical\]|\[high\]/gi, "")
			.replace(/severity:\s*"?(critical|high)"?/gi, "")
			.trim();

		if (description.length < 10) continue;

		const id = `pat-review-${taskSlug}-${entries.length + 1}`;
		entries.push({
			id,
			type: "bad",
			title: truncate(description, 100),
			context: `Review finding from task ${taskSlug}`,
			pattern: truncate(description, 500),
			applicationConditions: "When similar code patterns are encountered",
			expectedOutcomes: "Avoid repeating this anti-pattern",
			tags: ["review", taskSlug],
			createdAt: now,
			status: "draft", // Not auto-approved — needs human review via ledger reflect
			lang,
		});
	}
	return entries;
}

function stringifyResponse(response: unknown): string {
	if (typeof response === "string") return response;
	if (response == null) return "";
	try {
		return JSON.stringify(response);
	} catch {
		return "";
	}
}

// --- Shared save function ---

export function saveKnowledgeEntries(
	store: Store,
	projectPath: string,
	entries: Array<DecisionEntry | PatternEntry>,
	subType: "decision" | "pattern",
): number {
	const proj = detectProject(projectPath);
	let saved = 0;

	for (const entry of entries) {
		try {
			const filePath = writeKnowledgeFile(projectPath, subType, entry.id, entry);
			const row: KnowledgeRow = {
				id: 0,
				filePath,
				contentHash: "",
				title: entry.title,
				content: JSON.stringify(entry),
				subType,
				projectRemote: proj.remote,
				projectPath: proj.path,
				projectName: proj.name,
				branch: proj.branch,
				createdAt: "",
				updatedAt: "",
				hitCount: 0,
				lastAccessed: "",
				enabled: true,
			};
			const result = upsertKnowledge(store, row);
			if (result.changed) saved++;
		} catch {
			/* fail-open: individual entry save failure doesn't stop batch */
		}
	}

	if (saved > 0) {
		try {
			appendAudit(projectPath, {
				action: "knowledge.auto-extract",
				target: subType,
				detail: `${saved} ${subType}(s) extracted`,
				user: "mcp",
			});
		} catch {
			/* audit failure is non-critical */
		}
	}

	return saved;
}
