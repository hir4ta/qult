package hookhandler

// Minimal stubs for functions removed during alfred v1 rewrite.
// These will be replaced or removed entirely during schema reset.

import (
	"regexp"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// extractErrorSignature extracts a normalized error signature for failure tracking.
func extractErrorSignature(errorMsg string) string {
	if errorMsg == "" {
		return ""
	}
	// Normalize: take first meaningful line, strip file paths and line numbers.
	lines := strings.Split(errorMsg, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Strip file:line prefixes.
		sig := errorSigPathRe.ReplaceAllString(line, "")
		sig = strings.TrimSpace(sig)
		if len(sig) > 120 {
			sig = sig[:120]
		}
		if sig != "" {
			return sig
		}
	}
	if len(errorMsg) > 120 {
		return errorMsg[:120]
	}
	return errorMsg
}

var errorSigPathRe = regexp.MustCompile(`\S+\.\w+:\d+(?::\d+)?:\s*`)

// verifyPendingResolution is a no-op stub (suggestion tracking removed).
func verifyPendingResolution(_ *sessiondb.SessionDB, _ bool) {}

// extractTestFailures is a stub that returns nil (test correlation removed).
func extractTestFailures(_ string) []string { return nil }

// correlateWithRecentEdits is a stub (test correlation removed).
func correlateWithRecentEdits(_ *sessiondb.SessionDB, _ []string) string { return "" }

// --- Phase analysis helpers (moved from deleted playbook.go) ---

// phaseDist returns the percentage distribution of phases in a sequence.
func phaseDist(phases []string) map[string]float64 {
	if len(phases) == 0 {
		return nil
	}
	counts := make(map[string]int, len(phases))
	for _, p := range phases {
		counts[p]++
	}
	dist := make(map[string]float64, len(counts))
	total := float64(len(phases))
	for k, v := range counts {
		dist[k] = float64(v) / total
	}
	return dist
}

// countPhaseTransitions counts A→B transitions in a phase sequence.
func countPhaseTransitions(phases []string, from, to string) int {
	count := 0
	for i := 1; i < len(phases); i++ {
		if phases[i-1] == from && phases[i] == to {
			count++
		}
	}
	return count
}

// --- Detection functions for data recording (moved from deleted stop_detection.go) ---

// goTestFailRe matches Go test failure output lines.
// Matches "--- FAIL:" (individual test) or "FAIL\t" (package summary).
var goTestFailRe = regexp.MustCompile(`(?m)^(?:--- FAIL:|FAIL\t)`)

// isGoTestFailure detects Go test failures in command output.
// Uses precise regex matching to avoid false positives from log messages.
func isGoTestFailure(output string) bool {
	return goTestFailRe.MatchString(output)
}

// goBuildFailRe matches Go compiler error output.
// Matches file:line:col: patterns that indicate compilation errors.
var goBuildFailRe = regexp.MustCompile(`(?m)^\./\S+\.go:\d+:\d+:`)

// isBuildFailure detects Go build/compile failures in command output.
func isBuildFailure(output string) bool {
	if goBuildFailRe.MatchString(output) {
		return true
	}
	lower := strings.ToLower(output)
	return strings.Contains(lower, "compilation failed") || strings.Contains(lower, "build failed")
}

// containsError checks if command output contains error indicators.
func containsError(output string) bool {
	if output == "" {
		return false
	}
	// Check for Go-specific failure patterns first.
	if isGoTestFailure(output) || isBuildFailure(output) {
		return true
	}
	// Generic error indicators.
	lower := strings.ToLower(output)
	for _, indicator := range []string{"error:", "error[", "fatal:", "panic:", "exception:", "traceback"} {
		if strings.Contains(lower, indicator) {
			return true
		}
	}
	return false
}
