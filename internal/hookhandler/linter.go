package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// LinterResult is a unified lint finding from any external linter.
type LinterResult struct {
	File     string `json:"file"`
	Line     int    `json:"line"`
	Severity string `json:"severity"` // "error", "warning", "info"
	Rule     string `json:"rule"`
	Message  string `json:"message"`
}

// detectAvailableLinters checks which linters are installed and caches in sessiondb.
func detectAvailableLinters(sdb *sessiondb.SessionDB) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	for _, linter := range []string{"oxlint", "ruff"} {
		path, err := exec.CommandContext(ctx, "which", linter).Output()
		if err == nil && len(strings.TrimSpace(string(path))) > 0 {
			_ = sdb.SetContext("linter_"+linter, "available")
		}
	}
}

// runExternalLinters runs available linters on a file and returns findings.
// Total budget: 2 seconds. Runs linters appropriate for the file extension.
func runExternalLinters(sdb *sessiondb.SessionDB, filePath, cwd string) []LinterResult {
	ext := filepath.Ext(filePath)
	var results []LinterResult

	switch ext {
	case ".js", ".jsx", ".ts", ".tsx":
		if avail, _ := sdb.GetContext("linter_oxlint"); avail == "available" {
			results = append(results, runOxlint(filePath, cwd)...)
		}
	case ".py":
		if avail, _ := sdb.GetContext("linter_ruff"); avail == "available" {
			results = append(results, runRuff(filePath, cwd)...)
		}
	}

	return results
}

// runOxlint runs oxlint on a single file and parses JSON output.
func runOxlint(filePath, cwd string) []LinterResult {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "oxlint", "--format", "json", filePath)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		// oxlint returns non-zero when it finds issues.
		if exitErr, ok := err.(*exec.ExitError); ok {
			out = exitErr.Stderr
			if len(out) == 0 {
				out = []byte(err.Error())
			}
			// Try stdout from the command.
			out, _ = cmd.Output()
		}
		if len(out) == 0 {
			return nil
		}
	}

	return parseOxlintOutput(out)
}

// parseOxlintOutput parses oxlint JSON output into LinterResults.
func parseOxlintOutput(data []byte) []LinterResult {
	var diagnostics []struct {
		Message  string `json:"message"`
		Severity string `json:"severity"`
		Labels   []struct {
			Span struct {
				Offset int `json:"offset"`
			} `json:"span"`
		} `json:"labels"`
		Filename string `json:"filename"`
		Code     string `json:"code"`
	}
	if json.Unmarshal(data, &diagnostics) != nil {
		return nil
	}

	var results []LinterResult
	for _, d := range diagnostics {
		if len(results) >= 5 {
			break
		}
		results = append(results, LinterResult{
			File:     d.Filename,
			Severity: normalizeSeverity(d.Severity),
			Rule:     d.Code,
			Message:  d.Message,
		})
	}
	return results
}

// runRuff runs ruff check on a single file and parses JSON output.
func runRuff(filePath, cwd string) []LinterResult {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ruff", "check", "--output-format", "json", filePath)
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil
	}

	return parseRuffOutput(out)
}

// parseRuffOutput parses ruff JSON output into LinterResults.
func parseRuffOutput(data []byte) []LinterResult {
	var diagnostics []struct {
		Code     string `json:"code"`
		Message  string `json:"message"`
		Filename string `json:"filename"`
		Location struct {
			Row int `json:"row"`
		} `json:"location"`
	}
	if json.Unmarshal(data, &diagnostics) != nil {
		return nil
	}

	var results []LinterResult
	for _, d := range diagnostics {
		if len(results) >= 5 {
			break
		}
		results = append(results, LinterResult{
			File:     d.Filename,
			Line:     d.Location.Row,
			Severity: "warning",
			Rule:     d.Code,
			Message:  d.Message,
		})
	}
	return results
}

func normalizeSeverity(s string) string {
	switch strings.ToLower(s) {
	case "error", "deny":
		return "error"
	case "warning", "warn":
		return "warning"
	default:
		return "info"
	}
}

// deliverLintResults enqueues lint findings as nudges.
func deliverLintResults(sdb *sessiondb.SessionDB, results []LinterResult) {
	if len(results) == 0 {
		return
	}

	var b strings.Builder
	for i, r := range results {
		if i > 0 {
			b.WriteByte('\n')
		}
		if r.Line > 0 {
			fmt.Fprintf(&b, "  %s:%d [%s] %s: %s", filepath.Base(r.File), r.Line, r.Severity, r.Rule, r.Message)
		} else {
			fmt.Fprintf(&b, "  %s [%s] %s: %s", filepath.Base(r.File), r.Severity, r.Rule, r.Message)
		}
	}

	file := filepath.Base(results[0].File)
	cooldownKey := "lint:" + file
	set, _ := sdb.TrySetCooldown(cooldownKey, 5*time.Minute)
	if set {
		Deliver(sdb, "lint", "info",
			fmt.Sprintf("External linter found %d issue(s) in %s", len(results), file),
			b.String(), PriorityMedium)
	}
}

// lintAfterWrite runs external linters after a Write/Edit and delivers results.
func lintAfterWrite(sdb *sessiondb.SessionDB, filePath, cwd string) {
	if filePath == "" || cwd == "" {
		return
	}
	// Only lint if linters were detected at session start.
	results := runExternalLinters(sdb, filePath, cwd)
	deliverLintResults(sdb, results)
}

