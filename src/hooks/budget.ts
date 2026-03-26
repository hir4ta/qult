/**
 * Context budget management — prevents alfred from polluting Claude's context.
 *
 * Tracks cumulative injection tokens per session, enforces per-hook limits,
 * and trims lower-priority items when budget is tight.
 */
import type { DirectiveItem, DirectiveLevel } from "./directives.js";
import { readStateJSON, writeStateJSON } from "./state.js";

// ===== Budget constants =====

const CHARS_PER_TOKEN = 4;
const SESSION_BUDGET_TOKENS = 15_000;

const PER_HOOK_TOKENS: Record<string, number> = {
	SessionStart: 2_000,
	UserPromptSubmit: 4_000,
	PostToolUse: 2_000,
	PreToolUse: 500,
	Stop: 1_000,
	PreCompact: 1_000,
};

const CUMULATIVE_POST_TOOL_TOKENS = 8_000;
const DEDUP_THRESHOLD = 3;

// ===== Types =====

export interface BudgetLedger {
	totalSpent: number; // cumulative tokens this session
	perHook: Record<string, number>;
	postToolCumulative: number; // separate tracking for PostToolUse
	injectionCount: number;
	/** Recent directive message hashes and their count for dedup */
	directiveHashes: Record<string, number>;
}

const EMPTY_LEDGER: BudgetLedger = {
	totalSpent: 0,
	perHook: {},
	postToolCumulative: 0,
	injectionCount: 0,
	directiveHashes: {},
};

const FILE_NAME = "budget-ledger.json";

// ===== Read/Write =====

export function readBudgetLedger(cwd: string): BudgetLedger {
	return readStateJSON<BudgetLedger>(cwd, FILE_NAME, {
		...EMPTY_LEDGER,
		perHook: {},
		directiveHashes: {},
	});
}

export function writeBudgetLedger(cwd: string, ledger: BudgetLedger): void {
	writeStateJSON(cwd, FILE_NAME, ledger);
}

// ===== Core: trim to budget =====

function simpleHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const LEVEL_PRIORITY: Record<DirectiveLevel, number> = {
	DIRECTIVE: 0,
	WARNING: 1,
	CONTEXT: 2,
};

/**
 * Trim items to fit within the remaining hook + session budget.
 * Priority: DIRECTIVE (never cut) > WARNING (cut at 80%) > CONTEXT (cut at 60%).
 * Dedup: identical DIRECTIVE messages seen 3+ times are dropped.
 */
export function trimToBudget(
	hookName: string,
	items: DirectiveItem[],
	ledger: BudgetLedger,
): DirectiveItem[] {
	if (items.length === 0) return items;

	const hookLimit = PER_HOOK_TOKENS[hookName] ?? 2_000;
	const sessionRemaining = SESSION_BUDGET_TOKENS - ledger.totalSpent;

	// PostToolUse has a separate cumulative cap
	let available: number;
	if (hookName === "PostToolUse") {
		const postRemaining = CUMULATIVE_POST_TOOL_TOKENS - ledger.postToolCumulative;
		available = Math.min(hookLimit, sessionRemaining, postRemaining);
	} else {
		available = Math.min(hookLimit, sessionRemaining);
	}

	// If budget fully exhausted, only keep DIRECTIVEs
	if (available <= 0) {
		return items.filter((i) => i.level === "DIRECTIVE");
	}

	const budgetRatio = ledger.totalSpent / SESSION_BUDGET_TOKENS;

	// Sort by priority (DIRECTIVE first)
	const sorted = items.slice().sort((a, b) => LEVEL_PRIORITY[a.level] - LEVEL_PRIORITY[b.level]);

	const result: DirectiveItem[] = [];
	let spent = 0;

	for (const item of sorted) {
		const cost = estimateTokens(`[${item.level}] ${item.message}`);

		// Budget-based priority cutting
		if (item.level === "CONTEXT" && budgetRatio >= 0.6) continue;
		if (item.level === "WARNING" && budgetRatio >= 0.8) continue;

		// Dedup: skip DIRECTIVE messages seen 3+ times
		if (item.level === "DIRECTIVE") {
			const hash = simpleHash(item.message);
			const count = ledger.directiveHashes[hash] ?? 0;
			if (count >= DEDUP_THRESHOLD) continue;
		}

		// Check if this item fits
		if (spent + cost > available && item.level !== "DIRECTIVE") continue;

		result.push(item);
		spent += cost;
	}

	return result;
}

/**
 * Record an injection in the ledger.
 * Estimates tokens from items directly (no double buildDirectiveOutput needed).
 */
export function recordInjection(
	ledger: BudgetLedger,
	hookName: string,
	items: DirectiveItem[],
): void {
	const totalChars = items.reduce((sum, i) => sum + `[${i.level}] ${i.message}`.length + 1, 0);
	const tokens = estimateTokens(" ".repeat(totalChars));
	ledger.totalSpent += tokens;
	ledger.perHook[hookName] = (ledger.perHook[hookName] ?? 0) + tokens;
	ledger.injectionCount++;

	if (hookName === "PostToolUse") {
		ledger.postToolCumulative += tokens;
	}

	// Track directive hashes for dedup
	for (const item of items) {
		if (item.level === "DIRECTIVE") {
			const hash = simpleHash(item.message);
			ledger.directiveHashes[hash] = (ledger.directiveHashes[hash] ?? 0) + 1;
		}
	}
}
