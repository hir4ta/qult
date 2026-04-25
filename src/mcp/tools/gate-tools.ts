/**
 * Gate / Config category MCP tool handlers (3 tools):
 * disable_gate, enable_gate, set_config.
 */

import { resetConfigCache, setConfigKey } from "../../config.ts";
import { appendAuditLog } from "../../state/audit-log.ts";
import {
	disableGate as disableGateFs,
	enableGate as enableGateFs,
	listDisabledGateNames,
} from "../../state/gate-state.ts";
import { errorResult, type ToolResult, textResult } from "./shared.ts";

const VALID_DETECTOR_GATES = [
	"review",
	"security-check",
	"semgrep-required",
	"test-quality-check",
	"dep-vuln-check",
	"hallucinated-package-check",
];

const ALLOWED_NUMBER_KEYS = [
	"review.score_threshold",
	"review.max_iterations",
	"review.required_changed_files",
	"review.dimension_floor",
	"plan_eval.score_threshold",
	"plan_eval.max_iterations",
];
const ALLOWED_MODEL_KEYS = [
	"review.models.spec",
	"review.models.quality",
	"review.models.security",
	"review.models.adversarial",
	"plan_eval.models.generator",
	"plan_eval.models.evaluator",
];
const ALLOWED_BOOLEAN_KEYS = ["review.require_human_approval", "review.low_only_passes"];
const VALID_MODELS = ["sonnet", "opus", "haiku", "inherit"];

export function handleDisableGate(args: Record<string, unknown> | undefined): ToolResult {
	const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
	const reason = typeof args?.reason === "string" ? args.reason : null;
	if (!gateName) return errorResult("Missing gate_name parameter.");
	if (!reason || reason.length < 10 || new Set(reason).size < 5) {
		return errorResult("Missing or insufficient reason (min 10 chars, min 5 unique).");
	}
	if (!VALID_DETECTOR_GATES.includes(gateName)) {
		return errorResult(`Unknown gate '${gateName}'. Valid: ${VALID_DETECTOR_GATES.join(", ")}`);
	}
	const disabled = listDisabledGateNames();
	if (!disabled.includes(gateName) && disabled.length >= 2) {
		return errorResult(`Maximum 2 gates disabled. Currently: ${disabled.join(", ")}`);
	}
	disableGateFs(gateName, reason);
	appendAuditLog({
		action: "disable_gate",
		reason,
		gate_name: gateName,
		timestamp: new Date().toISOString(),
	});
	return textResult(`Gate '${gateName}' disabled for this session.`);
}

export function handleEnableGate(args: Record<string, unknown> | undefined): ToolResult {
	const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
	if (!gateName) return errorResult("Missing gate_name parameter.");
	enableGateFs(gateName);
	return textResult(`Gate '${gateName}' re-enabled.`);
}

export function handleSetConfig(args: Record<string, unknown> | undefined): ToolResult {
	const key = typeof args?.key === "string" ? args.key : null;
	const rawValue = args?.value;
	const value =
		typeof rawValue === "number"
			? rawValue
			: typeof rawValue === "string"
				? rawValue
				: typeof rawValue === "boolean"
					? rawValue
					: null;
	if (!key || value === null) return errorResult("Missing key or value parameter.");
	const ALL_ALLOWED = [...ALLOWED_NUMBER_KEYS, ...ALLOWED_MODEL_KEYS, ...ALLOWED_BOOLEAN_KEYS];
	if (!ALL_ALLOWED.includes(key)) {
		return errorResult(`Invalid key. Allowed: ${ALL_ALLOWED.join(", ")}`);
	}
	if (ALLOWED_NUMBER_KEYS.includes(key) && typeof value !== "number") {
		return errorResult(`Key '${key}' requires a number value.`);
	}
	if (ALLOWED_MODEL_KEYS.includes(key)) {
		if (typeof value !== "string" || !VALID_MODELS.includes(value)) {
			return errorResult(`Model must be one of: ${VALID_MODELS.join(", ")}`);
		}
	}
	if (ALLOWED_BOOLEAN_KEYS.includes(key) && typeof value !== "boolean") {
		return errorResult(`Key '${key}' requires a boolean value.`);
	}
	if (key === "review.dimension_floor" && typeof value === "number" && (value < 1 || value > 5)) {
		return errorResult("dimension_floor must be 1-5.");
	}
	setConfigKey(key, value);
	resetConfigCache();
	return textResult(`Config set: ${key} = ${value}`);
}
