/**
 * Shared utilities for MCP tool handlers.
 *
 * Input validators (spec_name, wave_num, file paths) and the common
 * `ToolResult` shape used across all tools.
 */

import {
	assertConfinedToQult,
	assertValidSpecName,
	assertValidWaveNum,
} from "../../state/paths.ts";

/** Standard MCP tool result shape. */
export interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

/** JSON-serializable result wrapped as a text content block. */
export function jsonResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Plain text result (one block). */
export function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

/** Error result. */
export function errorResult(text: string): ToolResult {
	return { isError: true, content: [{ type: "text", text }] };
}

/** Validate spec_name argument; returns parsed value or throws an Error suitable for `errorResult`. */
export function requireSpecName(
	args: Record<string, unknown> | undefined,
	key = "spec_name",
): string {
	const v = args?.[key];
	if (typeof v !== "string") {
		throw new Error(`missing or non-string ${key}`);
	}
	assertValidSpecName(v);
	return v;
}

/** Validate wave_num argument as an integer in [1, 99]. */
export function requireWaveNum(
	args: Record<string, unknown> | undefined,
	key = "wave_num",
): number {
	const v = args?.[key];
	if (typeof v !== "number") {
		throw new Error(`missing or non-number ${key}`);
	}
	assertValidWaveNum(v);
	return v;
}

/** Optional spec_name argument; null when absent or empty. */
export function optionalSpecName(
	args: Record<string, unknown> | undefined,
	key = "spec_name",
): string | null {
	const v = args?.[key];
	if (v === undefined || v === null) return null;
	if (typeof v !== "string") {
		throw new Error(`non-string ${key}`);
	}
	assertValidSpecName(v);
	return v;
}

/** Wrap a handler so thrown Errors become {isError, text}. */
export function wrapHandler(
	fn: () => ToolResult | Promise<ToolResult>,
): ToolResult | Promise<ToolResult> {
	try {
		return fn();
	} catch (err) {
		return errorResult(`error: ${(err as Error).message}`);
	}
}

/** Re-export for convenience to handlers that want to call confinement directly. */
export { assertConfinedToQult };
