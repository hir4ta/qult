package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type preToolUseInput struct {
	CommonInput
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
}

func handlePreToolUse(input []byte) (*HookOutput, error) {
	var in preToolUseInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Destructive command gate for Bash.
	if in.ToolName == "Bash" {
		var toolInput struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(in.ToolInput, &toolInput); err == nil && toolInput.Command != "" {
			obs, sugg, matched := analyzer.MatchDestructiveCommand(toolInput.Command)
			if matched {
				reason := fmt.Sprintf("[buddy] %s\n→ %s", obs, sugg)
				return makeDenyOutput(reason), nil
			}
		}
	}

	// Safety check: inject -i for bare rm commands, warn for git stash drop.
	var safetyWarning string
	if in.ToolName == "Bash" {
		if sr := checkBashSafety(in.ToolInput); sr != nil {
			if sr.UpdatedInput != nil {
				return makeUpdatedInputOutput(sr.UpdatedInput, sr.Warning), nil
			}
			safetyWarning = sr.Warning
		}
	}

	// Open session DB for context-aware checks and nudge delivery.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PreToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// --- JARVIS advisor: present alternatives before action ---
	var signals []string
	if safetyWarning != "" {
		signals = append(signals, safetyWarning)
	}

	if alts := presentAlternatives(sdb, in.ToolName, in.ToolInput); alts != "" {
		signals = append(signals, alts)
	}

	// High-failure-rate gate: ask user for confirmation on Edit/Write when
	// the tool+file combination has historically high failure probability.
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		var fi struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &fi) == nil && fi.FilePath != "" {
			prob, total, _ := sdb.FailureProbability(in.ToolName, fi.FilePath)
			if prob >= 0.8 && total >= 5 {
				reason := fmt.Sprintf("[buddy] High failure rate (%.0f%% over %d attempts) for %s on %s. Consider reading the file first to verify current content.",
					prob*100, total, in.ToolName, filepath.Base(fi.FilePath))
				return makeAskOutput(reason), nil
			}
		}
	}

	// Impact preview for Edit/Write (shows importers, test files).
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		var ei struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ei) == nil && ei.FilePath != "" {
			impactKey := "impact:" + filepath.Base(ei.FilePath)
			on, _ := sdb.IsOnCooldown(impactKey)
			if !on {
				if info := analyzeImpact(sdb, ei.FilePath, in.CWD); info != nil {
					if text := formatImpact(info); text != "" {
						_ = sdb.SetCooldown(impactKey, 15*time.Minute)
						signals = append(signals, fmt.Sprintf("[buddy] Impact: %s", text))
					}
				}
			}
		}
	}

	// Dequeue pending nudges as additionalContext.
	nudges, _ := sdb.DequeueNudges(1)
	if len(nudges) == 0 && len(signals) == 0 {
		return nil, nil
	}

	// Record delivery for effectiveness tracking.
	recordNudgeDelivery(sdb, in.SessionID, nudges)

	// Combine advisor signals and nudges into a single context string.
	var parts []string
	parts = append(parts, signals...)

	for _, n := range nudges {
		parts = append(parts, fmt.Sprintf("[buddy] %s (%s): %s\n→ %s",
			n.Pattern, n.Level, n.Observation, n.Suggestion))
	}

	return makeOutput("PreToolUse", strings.Join(parts, "\n")), nil
}

// extractCmdSignature extracts the base command pattern from a Bash command.
// "go test ./internal/store/..." → "go test"
// "npm install lodash" → "npm install"
func extractCmdSignature(command string) string {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return ""
	}
	if len(parts) >= 2 {
		return parts[0] + " " + parts[1]
	}
	return parts[0]
}

var compileCmdPattern = regexp.MustCompile(`\b(go build|go install|make|gcc|g\+\+|cargo build|npm run build|tsc)\b`)

func isCompileCommand(cmd string) bool {
	return compileCmdPattern.MatchString(cmd)
}

