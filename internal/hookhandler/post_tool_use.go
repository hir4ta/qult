package hookhandler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"

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

	// Track file reads.
	if in.ToolName == "Read" {
		var ri struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ri) == nil && ri.FilePath != "" {
			_ = sdb.IncrementFileRead(ri.FilePath)
		}
	}

	// Run lightweight detectors and enqueue nudges.
	det := &HookDetector{sdb: sdb}
	det.Detect()

	return nil, nil
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
