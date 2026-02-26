package hookhandler

import (
	"encoding/json"
	"regexp"
	"strings"
)

// rmPattern matches bare `rm` commands without the `-i` flag.
var rmPattern = regexp.MustCompile(`\brm\s`)

// rmForcePattern matches `rm` with `-f` (standalone or combined like -rf) or `--force`.
var rmForcePattern = regexp.MustCompile(`\brm\s+.*(-[^\s]*f|--force\b)`)

// rmInteractivePattern matches `rm` already with `-i` flag.
var rmInteractivePattern = regexp.MustCompile(`\brm\s+.*-[^\s]*i`)

// safetyResult holds the outcome of a safety check.
type safetyResult struct {
	// UpdatedInput is non-nil if the tool input should be replaced.
	UpdatedInput json.RawMessage
	// Warning is non-empty if a warning should be shown (without modifying input).
	Warning string
}

// checkBashSafety analyzes a Bash command for safety and returns
// an updated input or warning as appropriate. Returns nil if no action needed.
func checkBashSafety(toolInput json.RawMessage) *safetyResult {
	var bi struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(toolInput, &bi) != nil || bi.Command == "" {
		return nil
	}

	// rm without -f and without -i → inject -i for safety.
	if rmPattern.MatchString(bi.Command) && !rmForcePattern.MatchString(bi.Command) && !rmInteractivePattern.MatchString(bi.Command) {
		safeCmd := injectRmInteractive(bi.Command)
		if safeCmd != bi.Command {
			updated, err := json.Marshal(map[string]string{"command": safeCmd})
			if err != nil {
				return nil
			}
			return &safetyResult{
				UpdatedInput: updated,
				Warning:      "[buddy] Safety: added -i flag to rm command for interactive confirmation.",
			}
		}
	}

	// git stash drop — warn only, don't modify.
	if strings.Contains(bi.Command, "git stash drop") {
		return &safetyResult{
			Warning: "[buddy] Safety: git stash drop permanently removes the stash entry. Consider git stash pop instead to apply and remove.",
		}
	}

	return nil
}

// injectRmInteractive adds -i to rm commands that don't already have -i or -f.
// "rm foo.txt" → "rm -i foo.txt"
// "rm -r dir/" → "rm -ri dir/"
// Already-safe commands are returned unchanged.
func injectRmInteractive(cmd string) string {
	// Don't touch commands that already have -f or -i.
	if rmForcePattern.MatchString(cmd) || rmInteractivePattern.MatchString(cmd) {
		return cmd
	}

	loc := rmPattern.FindStringIndex(cmd)
	if loc == nil {
		return cmd
	}

	// Position right after "rm ".
	insertAt := loc[0] + 3 // len("rm ")
	rest := cmd[insertAt:]

	if strings.HasPrefix(rest, "-") {
		// Append i to existing flags: "rm -r" → "rm -ri"
		dashEnd := strings.Index(rest, " ")
		if dashEnd < 0 {
			return cmd[:insertAt] + rest + "i"
		}
		return cmd[:insertAt] + rest[:dashEnd] + "i" + rest[dashEnd:]
	}

	// No existing flags: "rm foo" → "rm -i foo"
	return cmd[:insertAt] + "-i " + rest
}
