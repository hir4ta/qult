import { resolve } from "node:path";
import { effectiveStatus } from "../spec/types.js";
import type { HookEvent } from "./dispatcher.js";
import { isGateActive } from "./review-gate.js";
import {
	allowTool,
	denyTool,
	isActiveSpecMalformed,
	isSpecFilePath,
	tryReadActiveSpec,
} from "./spec-guard.js";
import { readStateJSON } from "./state.js";

const BLOCKABLE_TOOLS = new Set(["Edit", "Write"]);

/**
 * Check if a file path is outside the project directory or in a known non-code
 * location. These files should never be blocked by review/approval gates.
 * (#16: gate scope was too broad, blocking memory/docs/CLAUDE.md edits)
 */
function isGateExemptPath(cwd: string | undefined, filePath: string): boolean {
	if (!cwd || !filePath) return false;
	const resolved = resolve(cwd, filePath);
	const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`;

	// Files outside the project directory (e.g., ~/.claude/memory/)
	if (!resolved.startsWith(cwdPrefix) && resolved !== cwd) return true;

	// Relative path within project
	const rel = resolved.slice(cwdPrefix.length);

	// docs/ directory
	if (rel.startsWith("docs/")) return true;

	// Root-level markdown files (CLAUDE.md, README.md, etc.)
	if (!rel.includes("/") && rel.endsWith(".md")) return true;

	// .claude/ directory (rules, memory, settings — not .alfred/)
	if (rel.startsWith(".claude/")) return true;

	return false;
}

/**
 * PreToolUse handler: block Edit/Write on review-gate or unapproved spec.
 * Enforcement order: .alfred/ exempt → malformed check → review-gate → approval gate.
 * Uses allowTool() for: .alfred/ files, deferred/cancelled specs, and active specs with cleared gates.
 * Only falls through to prompt hook (LLM judge) when NO active spec exists.
 */
export async function preToolUse(ev: HookEvent): Promise<void> {
	const toolName = ev.tool_name ?? "";

	// Only block Edit/Write. Everything else passes through.
	if (!BLOCKABLE_TOOLS.has(toolName)) return;

	// .alfred/ edits are always allowed (spec creation/update).
	const toolInput = (ev.tool_input ?? {}) as Record<string, unknown>;
	const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
	if (filePath && isSpecFilePath(ev.cwd, filePath)) {
		allowTool("Spec file edit");
		return;
	}

	// Fail-closed: if _active.md exists but can't be parsed, deny rather than silently allowing.
	if (isActiveSpecMalformed(ev.cwd)) {
		denyTool(
			"Failed to read spec state (_active.md exists but could not be parsed). Fix or delete .alfred/specs/_active.md before editing source files.",
		);
		return;
	}

	const spec = tryReadActiveSpec(ev.cwd);

	// FR-20: Exempt deferred/cancelled tasks from all gates.
	if (spec) {
		const status = effectiveStatus(spec.status);
		if (status === "deferred" || status === "cancelled") {
			allowTool("Deferred/cancelled spec");
			return;
		}
	}

	// Gate-exempt paths: files outside project or in non-code locations (#16).
	// These should never be blocked by review/approval gates.
	if (filePath && isGateExemptPath(ev.cwd, filePath)) {
		allowTool("Gate-exempt path (non-code file)");
		return;
	}

	// Review gate: blocks source edits until spec/wave review is completed.
	const gate = isGateActive(ev.cwd);
	if (gate) {
		const gateLabel =
			gate.gate === "wave-review" ? `Wave ${gate.wave ?? "?"} review` : "Spec self-review";
		const reason = [
			`${gateLabel} required for spec '${gate.slug}'. Complete review, then run: dossier action=gate sub_action=clear reason="<review summary>"`,
			`- Gate reason: ${gate.reason}`,
			'- "I already reviewed mentally" → Run actual review (3-agent or /alfred:inspect), then clear the gate',
		].join("\n");
		denyTool(reason);
		return;
	}

	// No active spec → check for polish mode (recently completed spec allows edits)
	if (!spec) {
		const polish = readStateJSON<{ slug?: string }>(ev.cwd, "polish.json", {});
		if (polish.slug) {
			allowTool(`Polish mode (post-complete '${polish.slug}')`);
			return;
		}
		// No active spec, no polish mode → allow but warn via stderr.
		// Spec-first enforcement is handled by UserPromptSubmit DIRECTIVE (Stage 1).
		// PreToolUse no longer uses a prompt-type LLM judge (removed: parallel hook
		// execution causes allow/deny conflicts, see #19).
		process.stderr.write(
			"[alfred] No active spec. Consider creating one: dossier action=init\n",
		);
		allowTool("No active spec (advisory warning emitted)");
		return;
	}

	// M/L/XL with unapproved review → deny.
	if (["M", "L", "XL"].includes(spec.size) && spec.reviewStatus !== "approved") {
		const reason = [
			`Spec '${spec.slug}' (size ${spec.size}) is not approved. Submit review via \`alfred dashboard\` or run self-review before implementation.`,
			'- "I\'ll get the review after implementation" → The Stop hook will block you from finishing anyway',
			'- "This edit is trivial" → All M/L/XL edits are gated. Use dossier init size=S for trivial changes',
		].join("\n");
		denyTool(reason);
		return;
	}

	// Active spec + all gates passed → allow explicitly to skip prompt hook.
	allowTool(`Active spec '${spec.slug}' (${spec.size}), gates clear`);
}
