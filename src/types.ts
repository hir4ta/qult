/** Hook event from Claude Code (stdin JSON) */
export interface HookEvent {
	// Common fields (all events)
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	permission_mode?: string;
	stop_hook_active?: boolean;
	// PostToolUse / PreToolUse
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	tool_use_id?: string;
	/** @deprecated Use tool_response instead */
	tool_output?: string;
	// UserPromptSubmit
	prompt?: string;
	// PermissionRequest
	tool?: { name: string };
	// TaskCompleted
	task_id?: string;
	task_subject?: string;
	task_description?: string;
	// SubagentStop
	agent_type?: string;
	agent_transcript_path?: string;
	last_assistant_message?: string;
	// SessionStart
	source?: string;
	// Legacy compat
	hook_type?: string;
}

/**
 * Hook response schema (legacy — stdout output removed for plugin compatibility).
 * deny() and block() now use stderr + exit 2 only, bypassing #16538.
 * State communication is handled via MCP server tools.
 */

/** Pending fix entry stored in the pending_fixes DB table */
export interface PendingFix {
	file: string;
	errors: string[];
	gate: string;
}
