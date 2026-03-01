package hookhandler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
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
		fmt.Fprintf(os.Stderr, "[alfred] PostToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Lightweight mode: skip all analysis for agent sessions.
	// Agent sessions have their own sessiondb and don't benefit from monitoring.
	if isAgent, _ := sdb.GetContext("is_agent_session"); isAgent == "true" {
		return nil, nil
	}

	// Open alfred.db for direct knowledge writes (phases, files, sequences).
	// Nil-safe: callers check st != nil before use.
	st, _ := store.OpenDefaultCached()

	// Cache task_type and velocity for contextual Thompson Sampling.
	SetDeliveryContext(sdb)

	isWrite := writeTools[in.ToolName]
	inputHash := hashInput(in.ToolName, in.ToolInput)

	if err := sdb.RecordEvent(in.ToolName, inputHash, isWrite); err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] PostToolUse: record event: %v\n", err)
		return nil, nil
	}

	// Track file reads for Read, Grep, Glob.
	// Also record file last read sequence for stale-read detection.
	switch in.ToolName {
	case "Read":
		var ri struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ri) == nil && ri.FilePath != "" {
			_ = sdb.IncrementFileRead(ri.FilePath)
			if seq, err := sdb.CurrentEventSeq(); err == nil {
				_ = sdb.RecordFileLastRead(ri.FilePath, seq)
			}
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
	case "AskUserQuestion":
		_ = sdb.SetContext("awaiting_question_followup", "true")
	}

	// Track Claude Code feature usage for preference learning.
	recordFeaturePreference(sdb, in.ToolName)

	// Track test and build command execution for workflow guidance.
	if in.ToolName == "Bash" {
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &bi) == nil {
			resp := string(in.ToolResponse)

			// Use command-specific detection instead of generic containsError.
			// Generic detection produces false positives from log messages
			// (e.g., seed pattern logs containing "undefined" or "error").
			if testCmdPattern.MatchString(bi.Command) {
				_ = sdb.SetContext("has_test_run", "true")

				testFailed := isGoTestFailure(resp)
				prevTestPassed, _ := sdb.GetContext("last_test_passed")
				if testFailed {
					_ = sdb.SetContext("last_test_passed", "false")
					if prevTestPassed == "true" {
						ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
						_ = sdb.RecordStructuredEvent("error", "test regression: previously passing tests now fail", string(ctxJSON))
					}
				} else {
					_ = sdb.SetContext("last_test_passed", "true")
					if prevTestPassed == "false" {
						ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
						_ = sdb.RecordStructuredEvent("fix", "tests now passing after previous failure", string(ctxJSON))
					}
				}

				}

			// Track build/compile success with precise detection.
			if isCompileCommand(bi.Command) {
				if isBuildFailure(resp) {
					_ = sdb.SetContext("last_build_passed", "false")
				} else {
					_ = sdb.SetContext("last_build_passed", "true")
				}
			}
		}
	}

	// Lightweight mode: skip heavy analysis during subagent activity.
	// Basic event recording, file tracking, and context tracking above are retained.
	if sdb.ActiveSubagentCount() > 0 {
		return nil, nil
	}

	// Update EWMA flow metrics (velocity, error rate).
	updateFlowMetrics(sdb, false)

	// Track success streak for FlowState classification.
	streak := getInt(sdb, "success_streak")
	_ = sdb.SetContext("success_streak", strconv.Itoa(streak+1))

	// Record health snapshot every 10 tool calls for trend prediction.
	recordHealthSnapshot(sdb)

	// Wall detection: clear flag (data only, no output).
	if IsWallDetected(sdb) {
		ClearWallDetected(sdb)
	}

	// Record workflow phase for adaptive learning.
	recordPhase(sdb, in.ToolName, in.ToolInput)

	// Persist phase to alfred.db for cross-session learning.
	if st != nil {
		if phase := classifyPhase(in.ToolName, in.ToolInput); phase != "" {
			_ = st.RecordLivePhase(in.SessionID, phase, in.ToolName)
		}
	}

	// Record tool outcome for prediction intelligence.
	filePath := extractFilePath(in.ToolInput)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, true) // success path

	// Record tool sequence for bigram prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, in.ToolName, "success")
		if st != nil {
			_ = st.IncrementToolSequence(prevTool, in.ToolName)
		}
	}

	// Record trigram for 3-tool sequence prediction.
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	if prevPrevTool != "" && prevTool != "" {
		_ = sdb.RecordTrigram(prevPrevTool, prevTool, in.ToolName, "success")
		if st != nil {
			_ = st.IncrementToolTrigram(prevPrevTool, prevTool, in.ToolName)
		}
	}
	_ = sdb.SetContext("prev_prev_tool", prevTool)
	_ = sdb.SetContext("prev_tool", in.ToolName)

	// Track files being edited in working set.
	if isWrite {
		if filePath != "" {
			_ = sdb.AddWorkingSetFile(filePath)
			if st != nil {
				_ = st.RecordLiveFile(in.SessionID, filePath)
				// Incremental co-change: record pairs with all files already in this session.
				if files, ferr := st.LiveSessionFiles(in.SessionID); ferr == nil && len(files) >= 2 {
					_ = st.RecordCoChanges(files)
				}
			}
			// Record structured event for LLM extraction.
			summary := fmt.Sprintf("%s %s", in.ToolName, filepath.Base(filePath))
			ctxJSON, _ := json.Marshal(map[string]string{"tool": in.ToolName, "file": filePath})
			_ = sdb.RecordStructuredEvent("decision", summary, string(ctxJSON))
		}
	}

	// Failure→solution pipeline: record fix when Edit/Write succeeds after a failure.
	if isWrite && filePath != "" {
		recordFailureSolution(sdb, in.SessionID, filePath, in.ToolInput)
	}

	// Solution chain tracking: append tool to chain sequence and finalize on success.
	trackSolutionChain(sdb, in.SessionID, in.ToolName, isWrite && filePath != "")

	// File change tracking for oscillation/revert detection.
	if isWrite && filePath != "" {
		trackFileChange(sdb, filePath, in.CWD)
	}

	// Record Bash failures for PreToolUse past-failure warning.
	if in.ToolName == "Bash" && len(in.ToolResponse) > 0 {
		resp := string(in.ToolResponse)
		var bi struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(in.ToolInput, &bi)

		if containsError(resp) && bi.Command != "" {
			sig := extractCmdSignature(bi.Command)
			errSummary := extractErrorSignature(resp)
			if sig != "" {
				_ = sdb.RecordBashFailure(sig, errSummary)
			}
			if errSummary != "" {
				ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
				_ = sdb.RecordStructuredEvent("error", errSummary, string(ctxJSON))
			}
		}
	}

	// Enrich MCP tool output with session context for alfred tools.
	if strings.HasPrefix(in.ToolName, "mcp__claude-alfred__") {
		if enrichment := buildMCPEnrichment(sdb); enrichment != "" {
			return &HookOutput{
				HookSpecificOutput: map[string]any{
					"hookEventName":         "PostToolUse",
					"updatedMCPToolOutput":  string(in.ToolResponse) + "\n\n" + enrichment,
				},
			}, nil
		}
	}

	return nil, nil
}

// buildMCPEnrichment builds session context to append to MCP tool output.
func buildMCPEnrichment(sdb *sessiondb.SessionDB) string {
	var parts []string

	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		parts = append(parts, "Current task: "+intent)
	}
	if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		parts = append(parts, "Task type: "+taskType)
	}
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, "Branch: "+branch)
	}
	tc, _, _, _ := sdb.BurstState()
	if tc > 0 {
		parts = append(parts, fmt.Sprintf("Tool calls this burst: %d", tc))
	}

	if len(parts) == 0 {
		return ""
	}
	return "[alfred session context] " + strings.Join(parts, " | ")
}


// recordFailureSolution checks if a recent failure exists for this file and records
// the current successful edit as a solution.
func recordFailureSolution(sdb *sessiondb.SessionDB, sessionID, filePath string, toolInput json.RawMessage) {
	failures, _ := sdb.RecentFailuresForFile(filePath, 1)
	if len(failures) == 0 {
		return
	}
	f := failures[0]
	if time.Since(f.Timestamp) > 15*time.Minute {
		return
	}

	// failure_solutions table removed in alfred v1 — data recording only via sessiondb.
	_ = sdb.SetContext("last_surfaced_solution_id", "")
}

// classifyPhase maps a tool call to a workflow phase string.
// Returns "" if the tool doesn't map to a recognized phase.
func classifyPhase(toolName string, toolInput json.RawMessage) string {
	switch toolName {
	case "Read", "Grep", "Glob":
		return "read"
	case "Edit", "Write", "NotebookEdit":
		return "write"
	case "EnterPlanMode":
		return "plan"
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && bi.Command != "" {
			if testCmdPattern.MatchString(bi.Command) {
				return "test"
			}
			if isCompileCommand(bi.Command) {
				return "compile"
			}
		}
	}
	return ""
}

// recordPhase maps a tool call to a workflow phase and records it in sessiondb.
// It also detects phase transitions and sets the at_workflow_boundary flag.
func recordPhase(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) {
	// Detect workflow boundaries from task/git events.
	switch toolName {
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && isGitCommitCommand(bi.Command) {
			_ = sdb.SetContext("at_workflow_boundary", "true")
		}
	case "TaskCreate", "TaskUpdate":
		_ = sdb.SetContext("at_workflow_boundary", "true")
	}

	phase := classifyPhase(toolName, toolInput)
	if phase == "" {
		return
	}

	// Detect phase transition: compare with previous recorded phase.
	prevPhase, _ := sdb.GetContext("prev_phase")
	if prevPhase != "" && prevPhase != phase {
		_ = sdb.SetContext("at_workflow_boundary", "true")
		_ = sdb.SetContext("coaching_phase_changed", "true")
	}
	_ = sdb.SetContext("prev_phase", phase)

	_ = sdb.RecordPhase(phase, toolName)
}

// isGitCommitCommand detects git commit commands in Bash input.
func isGitCommitCommand(cmd string) bool {
	return strings.Contains(cmd, "git commit") || strings.Contains(cmd, "git merge")
}

// trackSolutionChain appends the current tool to the active chain sequence.
// When a write succeeds (potential fix), the chain is finalized and persisted.
func trackSolutionChain(sdb *sessiondb.SessionDB, sessionID, toolName string, isSuccessfulWrite bool) {
	chainSig, _ := sdb.GetContext("chain_failure_sig")
	if chainSig == "" {
		return
	}

	// Append tool to sequence.
	seq, _ := sdb.GetContext("chain_tool_seq")
	if seq != "" {
		seq += "," + toolName
	} else {
		seq = toolName
	}
	_ = sdb.SetContext("chain_tool_seq", seq)

	stepStr, _ := sdb.GetContext("chain_step_count")
	step := 0
	if stepStr != "" {
		fmt.Sscanf(stepStr, "%d", &step)
	}
	step++
	_ = sdb.SetContext("chain_step_count", fmt.Sprintf("%d", step))

	// Finalize chain when a write succeeds (likely fix) or after 20 steps (abandon).
	if isSuccessfulWrite || step >= 20 {
		// solution_chains table removed in alfred v1.
		_ = step
		// Clear chain state.
		_ = sdb.SetContext("chain_failure_sig", "")
		_ = sdb.SetContext("chain_tool_seq", "")
		_ = sdb.SetContext("chain_step_count", "")
	}
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

// recordFeaturePreference increments a per-session counter for Claude Code
// feature usage. Collected counters are persisted to the store at SessionEnd.
func recordFeaturePreference(sdb *sessiondb.SessionDB, toolName string) {
	var key string
	switch toolName {
	case "EnterPlanMode":
		key = "plan_mode"
	case "EnterWorktree":
		key = "worktree"
	case "Agent":
		key = "agent"
	case "Skill":
		key = "skill"
	case "TeamCreate":
		key = "team"
	default:
		return
	}
	cur, _ := sdb.GetContext("pref:" + key + "_count")
	n, _ := strconv.Atoi(cur)
	_ = sdb.SetContext("pref:"+key+"_count", strconv.Itoa(n+1))
}
