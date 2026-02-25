package hookhandler

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// trackFileChange records file change metrics after Edit/Write and detects oscillation/revert.
func trackFileChange(sdb *sessiondb.SessionDB, filePath, cwd string) {
	if filePath == "" || cwd == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Get numstat for this file.
	numstat, err := execGit(ctx, cwd, "diff", "--numstat", "--", filePath)
	if err != nil || strings.TrimSpace(numstat) == "" {
		return
	}

	parts := strings.Fields(strings.TrimSpace(numstat))
	if len(parts) < 2 {
		return
	}

	added, _ := strconv.ParseInt(parts[0], 10, 64)
	removed, _ := strconv.ParseInt(parts[1], 10, 64)

	// Get diff hash for revert detection.
	diff, err := execGit(ctx, cwd, "diff", "--", filePath)
	if err != nil {
		diff = ""
	}
	h := fnv.New64a()
	h.Write([]byte(diff))
	diffHash := fmt.Sprintf("%016x", h.Sum64())

	seq, _ := sdb.CurrentEventSeq()
	if err := sdb.RecordFileChange(filePath, seq, added, removed, diffHash); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] trackFileChange: %v\n", err)
		return
	}

	// Detect oscillation (net_change sign alternates 3+ times).
	if osc, _ := sdb.DetectOscillation(filePath); osc {
		cooldownKey := "oscillation:" + filepath.Base(filePath)
		set, _ := sdb.TrySetCooldown(cooldownKey, 10*time.Minute)
		if set {
			Deliver(sdb, "oscillation", "warning",
				fmt.Sprintf("File %s is oscillating — edits keep going back and forth", filepath.Base(filePath)),
				"Step back and re-read the file to understand the current state before making more changes.",
				PriorityHigh)
		}
	}

	// Detect revert (same diff_hash appears within window of 6).
	if rev, _ := sdb.DetectRevert(filePath, 6); rev {
		cooldownKey := "revert:" + filepath.Base(filePath)
		set, _ := sdb.TrySetCooldown(cooldownKey, 10*time.Minute)
		if set {
			Deliver(sdb, "revert-detected", "warning",
				fmt.Sprintf("Changes to %s appear to be reverting a previous edit", filepath.Base(filePath)),
				"The same diff pattern was seen before. Consider a different approach.",
				PriorityHigh)
		}
	}
}
