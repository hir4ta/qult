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
	// Legacy compat
	hook_type?: string;
}

/** Hook response written to stdout.
 *
 * Schema varies by event:
 * - PostToolUse / UserPromptSubmit / SessionStart / SubagentStart / PostToolUseFailure:
 *     hookSpecificOutput.additionalContext
 * - PreToolUse:
 *     hookSpecificOutput.permissionDecision + permissionDecisionReason
 * - Stop / UserPromptSubmit (block):
 *     top-level decision + reason (NOT inside hookSpecificOutput)
 *
 * See: https://code.claude.com/docs/en/hooks
 */
export type HookResponse =
	| {
			hookSpecificOutput: {
				additionalContext: string;
			};
	  }
	| {
			hookSpecificOutput: {
				permissionDecision: "allow" | "deny" | "ask";
				permissionDecisionReason?: string;
			};
	  }
	| {
			decision: "block";
			reason: string;
	  };

/** Pending fix entry stored in .alfred/.state/pending-fixes.json */
export interface PendingFix {
	file: string;
	errors: string[];
	gate: string;
}

/** Gate configuration in .alfred/gates.json */
export interface GatesConfig {
	on_write?: Record<string, GateDefinition>;
	on_commit?: Record<string, GateDefinition>;
}

export interface GateDefinition {
	command: string;
	timeout?: number;
	run_once_per_batch?: boolean;
}
