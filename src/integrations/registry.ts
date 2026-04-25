/**
 * Integration registry — the source of truth for which AI tool integrations
 * are built into qult. Custom integrations from `.qult/config.json`'s
 * `integrations.custom` would extend this list at runtime; the MVP exposes
 * the 4 built-ins.
 */

import type { IntegrationBase, IntegrationKey } from "./base.ts";
import { ClaudeIntegration } from "./claude.ts";
import { CodexIntegration } from "./codex.ts";
import { CursorIntegration } from "./cursor.ts";
import { GeminiIntegration } from "./gemini.ts";

const BUILTINS: readonly IntegrationBase[] = [
	ClaudeIntegration,
	CodexIntegration,
	CursorIntegration,
	GeminiIntegration,
];

/** Return all built-in integration definitions in canonical order. */
export function listIntegrations(): readonly IntegrationBase[] {
	return BUILTINS;
}

/** Resolve an integration by key, or return null if unknown. */
export function resolveIntegration(key: IntegrationKey): IntegrationBase | null {
	return BUILTINS.find((i) => i.key === key) ?? null;
}

/**
 * Auto-detect which integrations are present in `projectRoot`.
 * Returns the keys that match. Empty when the project has no AI tool markers.
 */
export function detectIntegrations(projectRoot: string): IntegrationKey[] {
	return BUILTINS.filter((i) => i.detect(projectRoot)).map((i) => i.key);
}

/** All known integration keys (for error messages and validation). */
export function listIntegrationKeys(): IntegrationKey[] {
	return BUILTINS.map((i) => i.key);
}
