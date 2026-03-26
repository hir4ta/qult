import { emitAdditionalContext } from "./dispatcher.js";

export type DirectiveLevel = "DIRECTIVE" | "WARNING" | "CONTEXT";

export interface DirectiveItem {
	level: DirectiveLevel;
	message: string;
	/** Counter-arguments to common LLM rationalizations (DIRECTIVE level only, opt-in). */
	rationalizations?: string[];
	/** Append "spirit vs letter" anti-rationalization sentence (DIRECTIVE level only, opt-in). */
	spiritVsLetter?: boolean;
}

const LEVEL_ORDER: Record<DirectiveLevel, number> = {
	DIRECTIVE: 0,
	WARNING: 1,
	CONTEXT: 2,
};

const MAX_DIRECTIVES = 3;
const MAX_DIRECTIVE_BLOCK_CHARS = 500;
const SPIRIT_VS_LETTER =
	"Adapting or shortcutting these steps violates the rule, even if you believe the spirit is preserved.";

/**
 * Build a single additionalContext string from directive items.
 * Order: DIRECTIVE → WARNING → CONTEXT.
 * Max 3 DIRECTIVE items (NFR-5). Excess DIRECTIVEs downgraded to WARNING.
 */
export function buildDirectiveOutput(items: DirectiveItem[]): string {
	if (items.length === 0) return "";

	// Enforce max DIRECTIVE count.
	let directiveCount = 0;
	const normalized = items.map((item) => {
		if (item.level === "DIRECTIVE") {
			directiveCount++;
			if (directiveCount > MAX_DIRECTIVES) {
				return { level: "WARNING" as DirectiveLevel, message: item.message };
			}
		}
		return item;
	});

	// Sort by level order, stable.
	const sorted = normalized.slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

	return sorted
		.map((item) => {
			let block = `[${item.level}] ${item.message}`;
			// Append rationalizations + Spirit vs Letter for DIRECTIVE level only (opt-in).
			if (item.level === "DIRECTIVE") {
				const rats = (item.rationalizations ?? []).slice();
				const suffix = item.spiritVsLetter ? `\n${SPIRIT_VS_LETTER}` : "";

				// NFR-1: Fit within budget. Drop rationalizations from the end first to protect Spirit vs Letter.
				while (rats.length > 0) {
					const candidate = `${block}\n${rats.map((r) => `- ${r}`).join("\n")}${suffix}`;
					if (candidate.length <= MAX_DIRECTIVE_BLOCK_CHARS) break;
					rats.pop();
				}

				if (rats.length > 0) {
					block += `\n${rats.map((r) => `- ${r}`).join("\n")}`;
				}
				block += suffix;

				// Final safety: if message + suffix still exceeds limit, drop suffix and hard truncate.
				if (block.length > MAX_DIRECTIVE_BLOCK_CHARS) {
					const messageOnly = `[${item.level}] ${item.message}`;
					if (messageOnly.length > MAX_DIRECTIVE_BLOCK_CHARS) {
						block = `${messageOnly.slice(0, MAX_DIRECTIVE_BLOCK_CHARS - 3)}...`;
					} else {
						block = messageOnly;
					}
				}
			}
			return block;
		})
		.join("\n");
}

/**
 * Emit directives via single emitAdditionalContext call (NFR-4).
 * When cwd is provided, applies budget management (fail-open).
 */
export function emitDirectives(eventName: string, items: DirectiveItem[], cwd?: string): void {
	let finalItems = items;
	if (cwd) {
		try {
			const { trimToBudget, readBudgetLedger, recordInjection, writeBudgetLedger } =
				require("./budget.js") as typeof import("./budget.js");
			const ledger = readBudgetLedger(cwd);
			finalItems = trimToBudget(eventName, items, ledger);
			recordInjection(ledger, eventName, finalItems);
			writeBudgetLedger(cwd, ledger);
		} catch {
			/* fail-open: use original items */
		}
	}
	const output = buildDirectiveOutput(finalItems);
	if (output) {
		emitAdditionalContext(eventName, output);
	}
}
