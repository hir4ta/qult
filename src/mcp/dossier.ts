import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Embedder } from "../embedder/index.js";
import { syncTaskStatus, unlinkTaskFromAllEpics } from "../epic/index.js";
import { clearReviewGate, readReviewGate, writeReviewGate } from "../hooks/review-gate.js";
import { readWaveProgress, writeWaveProgress } from "../hooks/state.js";
import { appendAudit } from "../spec/audit.js";
import { initSpec } from "../spec/init.js";
import { updateTaskStatus } from "../spec/status.js";
import type { SpecFile, SpecSize, SpecType } from "../spec/types.js";
import { validateSpec } from "../spec/validate.js";
import {
	completeTask,
	effectiveStatus,
	filesForSize,
	readActive,
	readActiveState,
	removeTask,
	reviewStatusFor,
	SpecDir,
	switchActive,
	verifyReviewFile,
	writeActiveState,
} from "../spec/types.js";
import { searchKnowledgeFTS, subTypeBoost } from "../store/fts.js";
import type { Store } from "../store/index.js";
import { getKnowledgeByIDs, upsertKnowledge } from "../store/knowledge.js";
import { detectProject } from "../store/project.js";
import { vectorSearchKnowledge } from "../store/vectors.js";
import { truncate } from "./helpers.js";

/** Truncate at the last newline before maxLen to avoid mid-line cuts. */
function truncateAtNewline(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	const lastNewline = s.lastIndexOf("\n", maxLen);
	return lastNewline > 0 ? s.slice(0, lastNewline) : s.slice(0, maxLen);
}

interface DossierParams {
	action: string;
	project_path?: string;
	task_slug?: string;
	task_id?: string;
	description?: string;
	file?: string;
	content?: string;
	mode?: string;
	size?: string;
	spec_type?: string;
	version?: string;
	confirm?: boolean;
	// Gate action params
	sub_action?: string;
	gate_type?: string;
	wave?: number;
	reason?: string;
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
		isError: true as const,
	};
}

function resolveProjectPath(raw?: string): string {
	if (!raw) return process.cwd();
	const cleaned = resolve(raw);
	return cleaned;
}

export async function handleDossier(store: Store, emb: Embedder | null, params: DossierParams) {
	const projectPath = resolveProjectPath(params.project_path);

	switch (params.action) {
		case "init":
			return dossierInit(projectPath, store, emb, params);
		case "update":
			return dossierUpdate(projectPath, store, params);
		case "status":
			return dossierStatus(projectPath);
		case "switch":
			return dossierSwitch(projectPath, params);
		case "complete":
			return dossierComplete(projectPath, store, params);
		case "delete":
			return dossierDelete(projectPath, params);
		case "history":
			return dossierHistory(projectPath, params);
		case "rollback":
			return dossierRollback(projectPath, params);
		case "review":
			return dossierReview(projectPath, params);
		case "validate":
			return dossierValidate(projectPath, params);
		case "gate":
			return dossierGate(projectPath, params);
		case "check":
			return dossierCheck(projectPath, params);
		case "defer":
			return dossierDefer(projectPath, params);
		case "cancel":
			return dossierCancel(projectPath, params);
		default:
			return errorResult(`unknown action: ${params.action}`);
	}
}

async function dossierInit(
	projectPath: string,
	store: Store,
	emb: Embedder | null,
	params: DossierParams,
) {
	if (!params.task_slug) return errorResult("task_slug is required for init");

	const sizeOpt = params.size ? (params.size.toUpperCase() as SpecSize) : undefined;
	const specTypeOpt = params.spec_type ? (params.spec_type.toLowerCase() as SpecType) : undefined;

	let initResult;
	try {
		initResult = initSpec(projectPath, params.task_slug, params.description ?? "", {
			size: sizeOpt,
			specType: specTypeOpt,
		});
	} catch (err) {
		return errorResult(`init failed: ${err}`);
	}

	appendAudit(projectPath, {
		action: "spec.init",
		target: params.task_slug,
		detail: params.description,
		user: "mcp",
	});

	const result: Record<string, unknown> = {
		task_slug: params.task_slug,
		spec_dir: initResult.specDir.dir(),
		size: initResult.size,
		spec_type: initResult.specType,
		files: initResult.files,
	};

	// Search related knowledge.
	if (params.description && emb) {
		const suggestions = await searchRelatedKnowledge(store, emb, params.description, 5);
		if (suggestions.length > 0) result.suggested_knowledge = suggestions;
	}

	// Steering context — inject all 3 steering docs for spec creation context.
	const steeringDir = join(projectPath, ".alfred", "steering");
	const steeringFiles = ["product.md", "structure.md", "tech.md"];
	const steeringParts: string[] = [];
	for (const sf of steeringFiles) {
		const sfPath = join(steeringDir, sf);
		if (existsSync(sfPath)) {
			try {
				steeringParts.push(truncateAtNewline(readFileSync(sfPath, "utf-8"), 3000));
			} catch { /* ignore */ }
		}
	}
	if (steeringParts.length > 0) {
		result.steering_context = steeringParts.join("\n\n---\n\n");
	} else {
		result.steering_hint =
			"project steering docs not found — run `/alfred:init` to set up project context";
	}

	if (params.description) {
		result.suggested_search = `Before writing specs, search past experience: ledger action=search query="${truncate(params.description, 80)}"`;
	}

	// Language directive — tell Claude which language to write spec content in.
	const lang = process.env.ALFRED_LANG || "en";
	result.lang = lang;
	if (lang !== "en") {
		result.lang_directive = `Write ALL spec content in ${lang === "ja" ? "Japanese (日本語)" : lang}. Technical terms and IDs (FR-N, T-N.N, etc.) stay in English.`;
	}

	// Auto-set spec-review gate (FR-2/FR-6: all sizes, including S/D).
	try {
		writeReviewGate(projectPath, {
			gate: "spec-review",
			slug: params.task_slug,
			reason: "Spec created. Run thorough self-review before requesting approval.",
		});
		result.review_gate = "spec-review";
	} catch {
		/* fail-open: gate write failure doesn't block init */
	}

	return jsonResult(result);
}

async function searchRelatedKnowledge(
	store: Store,
	emb: Embedder,
	description: string,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	try {
		const vec = await emb.embedForSearch(description);
		const matches = vectorSearchKnowledge(store, vec, limit * 3);
		if (matches.length > 0) {
			const ids = matches.map((m) => m.sourceId);
			const scores = new Map(matches.map((m) => [m.sourceId, m.score]));
			const docs = getKnowledgeByIDs(store, ids);
			return docs
				.map((d) => ({
					label: d.title,
					source: d.subType,
					sub_type: d.subType,
					content: truncate(d.content, 500),
					relevance_score:
						Math.round((scores.get(d.id) ?? 0) * subTypeBoost(d.subType) * 100) / 100,
				}))
				.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
				.slice(0, limit);
		}
	} catch {
		/* vector search failed, try FTS */
	}

	try {
		const docs = searchKnowledgeFTS(store, description, limit);
		return docs.map((d, i) => ({
			label: d.title,
			source: d.subType,
			sub_type: d.subType,
			content: truncate(d.content, 500),
			relevance_score: Math.round((1.0 / (i + 1)) * subTypeBoost(d.subType) * 100) / 100,
		}));
	} catch {
		return [];
	}
}

function dossierUpdate(projectPath: string, store: Store, params: DossierParams) {
	if (!params.file) return errorResult("file is required for update");
	if (!params.content) return errorResult("content is required for update");
	const mode = params.mode ?? "append";

	// Resolve task slug.
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

	const file = params.file as SpecFile;
	try {
		if (mode === "replace") {
			sd.writeFile(file, params.content);
		} else {
			sd.appendFile(file, params.content);
		}
	} catch (err) {
		return errorResult(`${mode} failed: ${err}`);
	}

	const result: Record<string, unknown> = { task_slug: taskSlug, file: params.file, mode };

	// design.md pattern auto-extraction removed (FR-6).
	// Knowledge accumulation happens intentionally at Wave boundaries via ledger.

	// Language directive for consistent spec language.
	const lang = process.env.ALFRED_LANG || "en";
	if (lang !== "en") {
		result.lang = lang;
	}

	return jsonResult(result);
}

function dossierStatus(projectPath: string) {
	let state;
	try {
		state = readActiveState(projectPath);
	} catch {
		return jsonResult({ active: false });
	}

	const taskSlug = state.primary;
	if (!taskSlug) return jsonResult({ active: false });

	const task = state.tasks.find((t) => t.slug === taskSlug);
	const sd = new SpecDir(projectPath, taskSlug);

	const result: Record<string, unknown> = {
		active: true,
		task_slug: taskSlug,
		spec_dir: sd.dir(),
		lifecycle: effectiveStatus(task?.status),
		started_at: task?.started_at,
		size: task?.size ?? "L",
		spec_type: task?.spec_type ?? "feature",
		review_status: task?.review_status ?? "pending",
	};
	if (task?.completed_at) result.completed_at = task.completed_at;

	result.lang = process.env.ALFRED_LANG || "en";

	// Steering summary for context restoration after compaction.
	const steeringDir = join(projectPath, ".alfred", "steering");
	const steeringSummary: string[] = [];
	for (const sf of ["product.md", "structure.md", "tech.md"]) {
		const sfPath = join(steeringDir, sf);
		if (existsSync(sfPath)) {
			try {
				steeringSummary.push(truncateAtNewline(readFileSync(sfPath, "utf-8"), 800));
			} catch { /* ignore */ }
		}
	}
	if (steeringSummary.length > 0) {
		result.steering_summary = steeringSummary.join("\n---\n");
	}

	// Read all spec file contents.
	if (sd.exists()) {
		for (const section of sd.allSections()) {
			const key = section.file.replace(".md", "");
			result[key] = section.content;
		}
	}

	return jsonResult(result);
}

function dossierSwitch(projectPath: string, params: DossierParams) {
	if (!params.task_slug) return errorResult("task_slug is required for switch");
	try {
		switchActive(projectPath, params.task_slug);
	} catch (err) {
		return errorResult(`${err}`);
	}
	return jsonResult({ task_slug: params.task_slug, switched: true });
}

function dossierComplete(projectPath: string, store: Store, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	// Approval gate for M+ specs.
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (task) {
		const size = task.size ?? "L";
		if (["M", "L", "XL"].includes(size)) {
			const reviewStatus = reviewStatusFor(projectPath, taskSlug);
			if (reviewStatus !== "approved") {
				return errorResult(
					`completion requires review_status="approved" for ${size} specs (current: "${reviewStatus || "pending"}"). Review in alfred dashboard.`,
				);
			}
			// Verify review JSON file exists with approved status (FR-1).
			const verification = verifyReviewFile(projectPath, taskSlug);
			if (!verification.valid) {
				return errorResult(`approval gate: ${verification.reason}. Review in alfred dashboard.`);
			}
		}
	}

	// Validation gate: all sizes must pass validation (no fail checks).
	// Two failure modes: (1) validateSpec returns fails → block completion.
	// (2) validateSpec throws → fail-open, allow completion (NFR-2).
	try {
		const valSize = (task?.size ?? "L") as SpecSize;
		const valSpecType = (task?.spec_type ?? "feature") as SpecType;
		const valResult = validateSpec(projectPath, taskSlug, valSize, valSpecType);
		if (valResult.failed > 0) {
			const errors = valResult.checks.filter((c) => c.status === "fail").map((c) => c.message);
			return errorResult(
				`validation gate: ${valResult.failed} check(s) failed. Fix before completing.\n${errors.join("\n")}`,
			);
		}
	} catch {
		/* fail-open: validation errors don't block completion */
	}

	// Check closing wave completion.
	let closingWarning: string | undefined;
	try {
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksContent = sd.readFile("tasks.md");
		closingWarning = checkClosingWave(tasksContent);
	} catch {
		/* tasks.md may not exist for all sizes */
	}

	try {
		const currentStatus = effectiveStatus(task?.status);
		const newPrimary = completeTask(projectPath, taskSlug);
		appendAudit(projectPath, { action: "spec.complete", target: taskSlug, user: "mcp" });
		appendAudit(projectPath, {
			action: "task.status_change",
			target: taskSlug,
			detail: `${currentStatus} → done (dossier:complete)`,
		});
		syncTaskStatus(projectPath, taskSlug, "done");

		// design.md pattern auto-extraction removed (FR-6).
		// Knowledge accumulation happens intentionally at Wave boundaries via ledger.

		const result: Record<string, unknown> = {
			task_slug: taskSlug,
			completed: true,
			new_primary: newPrimary,
		};
		if (closingWarning) result.closing_wave_warning = closingWarning;

		// Prompt Claude to save additional patterns/rules via ledger.
		result.knowledge_prompt =
			"Task completed. Save reusable learnings via `ledger action=save sub_type=pattern`. " +
			"Consider: implementation approaches that worked, error patterns encountered, testing strategies, " +
			"architectural decisions that should become rules.";

		return jsonResult(result);
	} catch (err) {
		return errorResult(`${err}`);
	}
}

function dossierDelete(projectPath: string, params: DossierParams) {
	if (!params.task_slug) return errorResult("task_slug is required for delete");

	const sd = new SpecDir(projectPath, params.task_slug);

	if (!params.confirm) {
		// Dry-run preview.
		const sections = sd.exists() ? sd.allSections() : [];
		return jsonResult({
			task_slug: params.task_slug,
			exists: sd.exists(),
			file_count: sections.length,
			files: sections.map((s) => s.file),
			warning: "This will permanently remove the spec directory. Pass confirm=true to proceed.",
		});
	}

	try {
		const allRemoved = removeTask(projectPath, params.task_slug);
		unlinkTaskFromAllEpics(projectPath, params.task_slug);

		// FR-8: Clean up review gate if it belongs to the deleted spec.
		try {
			const gate = readReviewGate(projectPath);
			if (gate && gate.slug === params.task_slug) {
				clearReviewGate(projectPath);
			}
		} catch {
			/* fail-open */
		}

		appendAudit(projectPath, { action: "spec.delete", target: params.task_slug, user: "mcp" });
		return jsonResult({
			task_slug: params.task_slug,
			deleted: true,
			active_md_removed: allRemoved,
		});
	} catch (err) {
		return errorResult(`${err}`);
	}
}

function dossierHistory(projectPath: string, params: DossierParams) {
	if (!params.file) return errorResult("file is required for history");

	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	const histDir = join(sd.dir(), ".history");
	const file = params.file;

	let versions: Array<{ timestamp: string; size: number }> = [];
	try {
		const entries = readdirSync(histDir)
			.filter((e) => e.startsWith(`${file}.`))
			.sort()
			.reverse();
		versions = entries.map((e) => {
			const ts = e.slice(file.length + 1);
			let size = 0;
			try {
				size = readFileSync(join(histDir, e), "utf-8").length;
			} catch {
				/* ignore */
			}
			return { timestamp: ts, size };
		});
	} catch {
		/* no history */
	}

	return jsonResult({ task_slug: taskSlug, file, versions, count: versions.length });
}

function dossierRollback(projectPath: string, params: DossierParams) {
	if (!params.file) return errorResult("file is required for rollback");
	if (!params.version)
		return errorResult("version is required for rollback (use history to list versions)");

	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	const histDir = join(sd.dir(), ".history");
	const histPath = join(histDir, `${params.file}.${params.version}`);

	let content: string;
	try {
		content = readFileSync(histPath, "utf-8");
	} catch {
		return errorResult(`version not found: ${params.version}`);
	}

	try {
		sd.writeFile(params.file as SpecFile, content);
	} catch (err) {
		return errorResult(`rollback failed: ${err}`);
	}

	return jsonResult({
		task_slug: taskSlug,
		file: params.file,
		version: params.version,
		rolled_back: true,
	});
}

function dossierReview(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const status = reviewStatusFor(projectPath, taskSlug);

	// Check for review files.
	const sd = new SpecDir(projectPath, taskSlug);
	const reviewsDir = join(sd.dir(), "reviews");
	let latestReview: unknown = null;
	let unresolvedCount = 0;

	try {
		const files = readdirSync(reviewsDir)
			.filter((f) => f.startsWith("review-"))
			.sort()
			.reverse();
		if (files[0]) {
			const reviewData = JSON.parse(readFileSync(join(reviewsDir, files[0]), "utf-8"));
			latestReview = reviewData;
			if (Array.isArray(reviewData.comments)) {
				unresolvedCount = reviewData.comments.filter(
					(c: { resolved?: boolean }) => !c.resolved,
				).length;
			}
		}
	} catch {
		/* no reviews */
	}

	return jsonResult({
		task_slug: taskSlug,
		review_status: status || "pending",
		latest_review: latestReview,
		unresolved_count: unresolvedCount,
	});
}

function dossierValidate(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (!sd.exists()) return errorResult(`spec dir not found: ${sd.dir()}`);

	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	const size = (task?.size ?? "L") as SpecSize;
	const specType = (task?.spec_type ?? "feature") as SpecType;

	const result = validateSpec(projectPath, taskSlug, size, specType);
	const blocking = result.checks.filter((c) => c.status === "fail");
	const warnings = result.checks.filter((c) => c.status === "warn");

	return jsonResult({
		task_slug: taskSlug,
		size,
		spec_type: specType,
		checks: result.checks,
		summary: result.summary,
		blocking_issues: blocking.map((c) => c.message),
		warnings: warnings.map((c) => c.message),
	});
}

function dossierGate(projectPath: string, params: DossierParams) {
	const subAction = params.sub_action;
	if (!subAction) return errorResult("sub_action is required for gate (set/clear/status)");

	switch (subAction) {
		case "set": {
			const gateType = params.gate_type;
			if (gateType !== "spec-review" && gateType !== "wave-review") {
				return errorResult('gate_type must be "spec-review" or "wave-review"');
			}
			if (gateType === "wave-review" && (params.wave == null || params.wave < 1)) {
				return errorResult("wave (number >= 1) is required for wave-review gate");
			}

			let taskSlug = params.task_slug;
			if (!taskSlug) {
				try {
					taskSlug = readActive(projectPath);
				} catch (err) {
					return errorResult(`no active spec: ${err}`);
				}
			}

			const gateReason =
				params.reason ??
				(gateType === "spec-review"
					? "Spec review required."
					: `Wave ${params.wave} review required.`);

			writeReviewGate(projectPath, {
				gate: gateType,
				slug: taskSlug,
				wave: gateType === "wave-review" ? params.wave : undefined,
				reason: gateReason,
			});

			appendAudit(projectPath, {
				action: "gate.set",
				target: taskSlug,
				detail: `${gateType}${params.wave ? ` wave=${params.wave}` : ""}`,
				user: "mcp",
			});

			return jsonResult({
				gate: gateType,
				slug: taskSlug,
				wave: params.wave,
				set: true,
			});
		}

		case "clear": {
			if (!params.reason || params.reason.trim() === "") {
				return errorResult(
					'reason is required for gate clear — describe what was reviewed (e.g., "3-agent review completed, 0 critical issues")',
				);
			}

			const gate = readReviewGate(projectPath);
			if (!gate) {
				return jsonResult({ cleared: false, reason: "no active review gate to clear" });
			}

			const reason = truncate(params.reason, 500);
			clearReviewGate(projectPath);

			// FR-15: Auto-transition review → in-progress on gate clear.
			if (gate.slug) {
				try {
					updateTaskStatus(projectPath, gate.slug, "in-progress", "auto:gate-clear");
				} catch { /* ignore: task may not be in review state */ }
			}

			// FR-1: Update wave-progress reviewed flag on wave-review gate clear.
			if (gate.gate === "wave-review" && gate.wave !== undefined) {
				try {
					const progress = readWaveProgress(projectPath);
					const waveKey = String(gate.wave);
					if (progress?.waves[waveKey]) {
						progress.waves[waveKey]!.reviewed = true;
						writeWaveProgress(projectPath, progress);
					}
				} catch { /* fail-open */ }
			}

			appendAudit(projectPath, {
				action: "gate.clear",
				target: gate.slug,
				detail: reason,
				user: "mcp",
			});

			return jsonResult({ cleared: true, reason });
		}

		case "status": {
			const gate = readReviewGate(projectPath);
			if (!gate) return jsonResult({ gate: null });
			return jsonResult(gate);
		}

		default:
			return errorResult(`unknown gate sub_action: ${subAction} (valid: set/clear/status)`);
	}
}

/**
 * FR-3: Check if Closing Wave has at least 1 checked item.
 * Returns warning message if not, undefined if ok.
 */
function checkClosingWave(tasksContent: string): string | undefined {
	const closingIdx = tasksContent.search(/## Wave:\s*[Cc]losing/);
	if (closingIdx === -1)
		return "No Closing Wave found in tasks.md. Add self-review, CLAUDE.md update, and test verification items.";

	const closingSection = tasksContent.slice(closingIdx);
	const nextSection = closingSection.indexOf("\n##", 1);
	const body = nextSection === -1 ? closingSection : closingSection.slice(0, nextSection);
	const checkedItems = body.match(/^- \[x\] .+$/gm);
	if (!checkedItems || checkedItems.length === 0) {
		return "Closing Wave has no checked items. Complete self-review, CLAUDE.md update, and test verification before finishing.";
	}

	return undefined;
}

// --- Check (task completion) ---

function dossierCheck(projectPath: string, params: DossierParams) {
	const taskId = params.task_id;
	if (!taskId) return errorResult("task_id is required for check (e.g. 'T-1.2')");

	let taskSlug: string;
	try {
		taskSlug = readActive(projectPath);
	} catch {
		return errorResult("no active spec");
	}

	const sd = new SpecDir(projectPath, taskSlug);
	let tasks: string;
	try {
		tasks = sd.readFile("tasks.md");
	} catch {
		return errorResult("tasks.md not found");
	}

	const lines = tasks.split("\n");
	let checked = false;
	const taskIdLower = taskId.toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Match unchecked task lines containing the task_id
		if (line.match(/^- \[ \] /) && line.toLowerCase().includes(taskIdLower)) {
			lines[i] = line.replace("- [ ]", "- [x]");
			checked = true;
			break; // Only check one task per call
		}
	}

	if (!checked) {
		// Check if it's already checked
		const alreadyChecked = lines.some(
			(l) => l.match(/^- \[x\] /) && l.toLowerCase().includes(taskIdLower),
		);
		if (alreadyChecked) {
			return jsonResult({ task_id: taskId, status: "already_checked" });
		}
		return errorResult(`task_id "${taskId}" not found in tasks.md`);
	}

	const updatedContent = lines.join("\n");
	sd.writeFile("tasks.md", updatedContent);

	// Sync session.md Next Steps: check matching task ID line.
	try {
		const session = sd.readFile("session.md");
		const sessionLines = session.split("\n");
		let modified = false;
		for (let i = 0; i < sessionLines.length; i++) {
			const sl = sessionLines[i]!;
			if (sl.match(/^- \[ \] /) && sl.toLowerCase().includes(taskIdLower)) {
				sessionLines[i] = sl.replace("- [ ]", "- [x]");
				modified = true;
				break;
			}
		}
		if (modified) {
			sd.writeFile("session.md", sessionLines.join("\n"));
		}
	} catch { /* session.md sync is best-effort */ }

	// Detect wave completion (reuse logic from post-tool).
	const waveMessages: string[] = [];
	try {
		const { detectWaveCompletion } = require("../hooks/post-tool.js");
		const waveItems = detectWaveCompletion(projectPath, taskSlug, updatedContent);
		for (const item of waveItems) {
			waveMessages.push(item.message);
		}
	} catch {
		/* wave detection is optional */
	}

	return jsonResult({
		task_id: taskId,
		status: "checked",
		task_slug: taskSlug,
		...(waveMessages.length > 0 ? { wave_completion: waveMessages } : {}),
	});
}

// --- Defer / Cancel ---

function dossierDefer(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) return errorResult(`task "${taskSlug}" not found`);

	const current = effectiveStatus(task.status);

	// Toggle: deferred → in-progress, otherwise → deferred
	if (current === "deferred") {
		try {
			updateTaskStatus(projectPath, taskSlug, "in-progress", "dossier:defer");
		} catch (err) {
			return errorResult(`${err}`);
		}
		return jsonResult({ task_slug: taskSlug, status: "in-progress", resumed: true });
	}

	try {
		updateTaskStatus(projectPath, taskSlug, "deferred", "dossier:defer");
	} catch (err) {
		return errorResult(`${err}`);
	}
	return jsonResult({ task_slug: taskSlug, status: "deferred", deferred: true });
}

function dossierCancel(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	try {
		updateTaskStatus(projectPath, taskSlug, "cancelled", "dossier:cancel");
	} catch (err) {
		return errorResult(`${err}`);
	}

	// Move primary to next non-terminal task.
	const state = readActiveState(projectPath);
	if (state.primary === taskSlug) {
		state.primary = state.tasks.find((t) => {
			const s = effectiveStatus(t.status);
			return s !== "done" && s !== "cancelled" && t.slug !== taskSlug;
		})?.slug ?? "";
		writeActiveState(projectPath, state);
	}

	return jsonResult({ task_slug: taskSlug, status: "cancelled", cancelled: true });
}

// Note: saveDecisionsAsKnowledge and savePatternsAsKnowledge extracted to knowledge-extractor.ts
