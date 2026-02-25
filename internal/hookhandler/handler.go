package hookhandler

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// CommonInput is the shared fields all hook events receive on stdin.
type CommonInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	CWD            string `json:"cwd"`
	PermissionMode string `json:"permission_mode"`
	HookEventName  string `json:"hook_event_name"`
}

// HookOutput is the top-level JSON response written to stdout.
type HookOutput struct {
	Continue           *bool          `json:"continue,omitempty"`
	StopReason         string         `json:"stopReason,omitempty"`
	SuppressOutput     *bool          `json:"suppressOutput,omitempty"`
	SystemMessage      string         `json:"systemMessage,omitempty"`
	AdditionalContext  string         `json:"additionalContext,omitempty"`
	Decision           string         `json:"decision,omitempty"`
	Reason             string         `json:"reason,omitempty"`
	HookSpecificOutput map[string]any `json:"hookSpecificOutput,omitempty"`
}

// Run reads hook JSON from stdin, dispatches to the appropriate handler,
// and writes the response JSON to stdout.
func Run(eventName string) error {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("hookhandler: read stdin: %w", err)
	}

	var output *HookOutput
	switch eventName {
	case "SessionStart":
		output, err = handleSessionStart(input)
	case "PreToolUse":
		output, err = handlePreToolUse(input)
	case "PostToolUse":
		output, err = handlePostToolUse(input)
	case "UserPromptSubmit":
		output, err = handleUserPromptSubmit(input)
	case "PreCompact":
		output, err = handlePreCompact(input)
	case "SessionEnd":
		output, err = handleSessionEnd(input)
	case "PostToolUseFailure":
		output, err = handlePostToolUseFailure(input)
	case "Stop":
		output, err = handleStop(input)
	default:
		// Unknown event: no-op.
		return nil
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] %s error: %v\n", eventName, err)
		return nil // Don't block Claude on errors.
	}

	if output == nil {
		return nil
	}

	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(output)
}

// makeOutput creates a HookOutput with additionalContext.
func makeOutput(eventName, context string) *HookOutput {
	if context == "" {
		return nil
	}
	return &HookOutput{
		HookSpecificOutput: map[string]any{
			"hookEventName":     eventName,
			"additionalContext": context,
		},
	}
}

// makeDenyOutput creates a PreToolUse deny response.
func makeDenyOutput(reason string) *HookOutput {
	return &HookOutput{
		HookSpecificOutput: map[string]any{
			"hookEventName":          "PreToolUse",
			"permissionDecision":     "deny",
			"permissionDecisionReason": reason,
		},
	}
}

// makeAsyncContextOutput returns output with top-level additionalContext for async hooks.
// The context is delivered to Claude on the next conversation turn.
func makeAsyncContextOutput(context string) *HookOutput {
	if context == "" {
		return nil
	}
	return &HookOutput{AdditionalContext: context}
}

// makeBlockStopOutput returns output that prevents Claude from stopping.
func makeBlockStopOutput(reason string) *HookOutput {
	return &HookOutput{Decision: "block", Reason: reason}
}

// formatNudges formats nudges into a compact text string for additionalContext.
func formatNudges(nudges []nudgeEntry) string {
	if len(nudges) == 0 {
		return ""
	}
	var b strings.Builder
	for i, n := range nudges {
		if i > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(&b, "[buddy] %s (%s): %s\n→ %s", n.Pattern, n.Level, n.Observation, n.Suggestion)
	}
	return b.String()
}

type nudgeEntry struct {
	Pattern     string
	Level       string
	Observation string
	Suggestion  string
}
