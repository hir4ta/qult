package hookhandler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type postToolUseInput struct {
	CommonInput
	ToolName     string          `json:"tool_name"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
	ToolUseID    string          `json:"tool_use_id"`
}

// Write tools that indicate file modification.
var writeTools = map[string]bool{
	"Write": true, "Edit": true, "NotebookEdit": true,
}

func handlePostToolUse(input []byte) (*HookOutput, error) {
	var in postToolUseInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PostToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	isWrite := writeTools[in.ToolName]
	inputHash := hashInput(in.ToolName, in.ToolInput)

	if err := sdb.RecordEvent(in.ToolName, inputHash, isWrite); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PostToolUse: record event: %v\n", err)
		return nil, nil
	}

	// Track file reads for Read, Grep, Glob.
	switch in.ToolName {
	case "Read":
		var ri struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ri) == nil && ri.FilePath != "" {
			_ = sdb.IncrementFileRead(ri.FilePath)
		}
	case "Grep":
		var gi struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(in.ToolInput, &gi) == nil && gi.Path != "" {
			_ = sdb.IncrementFileRead(gi.Path)
		}
	}

	// Update session context for mode tracking.
	switch in.ToolName {
	case "EnterPlanMode":
		_ = sdb.SetContext("plan_mode", "active")
	case "ExitPlanMode":
		_ = sdb.SetContext("plan_mode", "")
	case "Task":
		_ = sdb.SetContext("subagent_active", "true")
	}

	// Run lightweight signal detection → deliver via additionalContext.
	det := &HookDetector{sdb: sdb}
	if signal := det.Detect(); signal != "" {
		return makeAsyncContextOutput(signal), nil
	}

	// Search for past error solutions when Bash fails.
	if in.ToolName == "Bash" && len(in.ToolResponse) > 0 {
		matchPastErrorSolutions(sdb, string(in.ToolResponse))
	}

	return nil, nil
}

// matchPastErrorSolutions checks Bash output for errors and searches past solutions.
func matchPastErrorSolutions(sdb *sessiondb.SessionDB, response string) {
	if !containsError(response) {
		return
	}

	on, _ := sdb.IsOnCooldown("past_solution")
	if on {
		return
	}

	sig := extractErrorSignature(response)
	solutions := searchErrorSolutions(sdb, sig)
	if len(solutions) == 0 {
		return
	}

	_ = sdb.EnqueueNudge(
		"past-solution", "info",
		"Similar error found in past sessions",
		formatSolution(solutions[0]),
	)
	_ = sdb.SetCooldown("past_solution", 5*time.Minute)
}

func hashInput(toolName string, toolInput json.RawMessage) uint64 {
	h := fnv.New64a()
	h.Write([]byte(toolName))
	h.Write([]byte(":"))
	var buf bytes.Buffer
	if err := json.Compact(&buf, toolInput); err == nil {
		h.Write(buf.Bytes())
	} else {
		h.Write(toolInput)
	}
	return h.Sum64()
}
