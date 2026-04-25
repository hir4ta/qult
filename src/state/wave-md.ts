/**
 * Parser & writer for `.qult/specs/<name>/waves/wave-NN.md`.
 *
 * wave-NN.md holds Wave-level metadata only — it does NOT duplicate the task
 * list from tasks.md. Schema:
 *
 * ```markdown
 * # Wave 2: <title>
 *
 * **Goal**: ...
 * **Verify**: ...
 * **Started at**: 2026-04-25T15:00:00Z
 * **Completed at**: 2026-04-25T16:30:00Z
 * **Scaffold**: false
 * **Fixes**: wave-MM            (review-fix Wave only)
 * **Superseded by**: wave-LL    (only set when a later Wave fixed this one)
 *
 * ## Commits
 * - abc1234: feat: ...
 * - def5678: test: ...
 *
 * **Range**: abc1234..def5678
 *
 * ## Notes
 * <free-form>
 * ```
 *
 * Empty / unset metadata stays as `**Key**:` (trailing space optional). The
 * writer round-trips every field; unknown lines under `## Notes` are
 * preserved verbatim.
 */

/** Parsed wave-NN.md. */
export interface WaveDoc {
	num: number;
	title: string;
	goal: string | null;
	verify: string | null;
	scaffold: boolean;
	startedAt: string | null;
	completedAt: string | null;
	fixes: number | null;
	supersededBy: number | null;
	commits: WaveCommit[];
	range: string | null;
	notes: string;
}

/** Single commit entry under `## Commits`. */
export interface WaveCommit {
	sha: string;
	subject: string;
}

const TITLE_RE = /^# Wave (\d+):\s*(.*)$/;
const META_RE = /^\*\*([A-Za-z][A-Za-z ]*?)\*\*:\s*(.*)$/;
const COMMIT_LINE_RE = /^- ([0-9a-f]{4,40}):\s*(.+)$/;
const WAVE_REF_RE = /^wave-(\d+)$/i;

/** Parse wave-NN.md text. Tolerant of missing optional sections. */
export function parseWaveMd(content: string): WaveDoc {
	const lines = content.split("\n");
	const doc: WaveDoc = {
		num: 0,
		title: "",
		goal: null,
		verify: null,
		scaffold: false,
		startedAt: null,
		completedAt: null,
		fixes: null,
		supersededBy: null,
		commits: [],
		range: null,
		notes: "",
	};
	let section: "header" | "commits" | "notes" = "header";
	const noteLines: string[] = [];

	for (const line of lines) {
		if (section === "header") {
			const tm = TITLE_RE.exec(line);
			if (tm) {
				doc.num = Number.parseInt(tm[1] ?? "0", 10);
				doc.title = (tm[2] ?? "").trim();
				continue;
			}
			if (line === "## Commits") {
				section = "commits";
				continue;
			}
			if (line === "## Notes") {
				section = "notes";
				continue;
			}
			const mm = META_RE.exec(line);
			if (mm) {
				assignMeta(doc, (mm[1] ?? "").trim().toLowerCase(), (mm[2] ?? "").trim());
			}
			continue;
		}

		if (section === "commits") {
			if (line === "## Notes") {
				section = "notes";
				continue;
			}
			const mm = META_RE.exec(line);
			if (mm) {
				assignMeta(doc, (mm[1] ?? "").trim().toLowerCase(), (mm[2] ?? "").trim());
				continue;
			}
			const cm = COMMIT_LINE_RE.exec(line);
			if (cm?.[1] && cm[2]) {
				doc.commits.push({ sha: cm[1], subject: cm[2] });
			}
			continue;
		}

		// notes section: keep raw lines, trim trailing blanks at the end later
		noteLines.push(line);
	}

	doc.notes = trimBlankLines(noteLines).join("\n");
	if (doc.num === 0 || !doc.title) {
		throw new Error("malformed wave-NN.md: missing or invalid '# Wave N: <title>' header");
	}
	return doc;
}

function assignMeta(doc: WaveDoc, key: string, value: string): void {
	switch (key) {
		case "goal":
			doc.goal = value || null;
			break;
		case "verify":
			doc.verify = value || null;
			break;
		case "scaffold":
			doc.scaffold = /^true$/i.test(value);
			break;
		case "started at":
			doc.startedAt = value || null;
			break;
		case "completed at":
			doc.completedAt = value || null;
			break;
		case "fixes":
			doc.fixes = parseWaveRef(value);
			break;
		case "superseded by":
			doc.supersededBy = parseWaveRef(value);
			break;
		case "range":
			doc.range = value || null;
			break;
	}
}

function parseWaveRef(value: string): number | null {
	const m = WAVE_REF_RE.exec(value.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "0", 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

/** Render a {@link WaveDoc} back to canonical markdown. */
export function writeWaveMd(doc: WaveDoc): string {
	const out: string[] = [];
	out.push(`# Wave ${doc.num}: ${doc.title}`);
	out.push("");
	out.push(`**Goal**: ${doc.goal ?? ""}`);
	out.push(`**Verify**: ${doc.verify ?? ""}`);
	out.push(`**Started at**: ${doc.startedAt ?? ""}`);
	out.push(`**Completed at**: ${doc.completedAt ?? ""}`);
	out.push(`**Scaffold**: ${doc.scaffold ? "true" : "false"}`);
	if (doc.fixes !== null) {
		out.push(`**Fixes**: wave-${pad(doc.fixes)}`);
	}
	if (doc.supersededBy !== null) {
		out.push(`**Superseded by**: wave-${pad(doc.supersededBy)}`);
	}
	out.push("");
	out.push("## Commits");
	if (doc.commits.length === 0) {
		out.push("");
		out.push("(populated on /qult:wave-complete)");
	} else {
		for (const c of doc.commits) {
			out.push(`- ${c.sha}: ${c.subject}`);
		}
	}
	out.push("");
	out.push(`**Range**: ${doc.range ?? ""}`);
	out.push("");
	out.push("## Notes");
	out.push("");
	if (doc.notes.trim()) {
		out.push(doc.notes);
		out.push("");
	}
	return `${out.join("\n").replace(/\n+$/u, "")}\n`;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Convenience: build a fresh wave-NN.md skeleton (used by /qult:wave-start). */
export function newWaveDoc(opts: {
	num: number;
	title: string;
	goal: string;
	verify: string;
	scaffold?: boolean;
	startedAt: string;
	fixes?: number | null;
}): WaveDoc {
	return {
		num: opts.num,
		title: opts.title,
		goal: opts.goal,
		verify: opts.verify,
		scaffold: opts.scaffold ?? false,
		startedAt: opts.startedAt,
		completedAt: null,
		fixes: opts.fixes ?? null,
		supersededBy: null,
		commits: [],
		range: null,
		notes: "",
	};
}
