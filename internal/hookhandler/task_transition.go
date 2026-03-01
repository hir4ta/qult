package hookhandler

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

func generateTaskTransitionBriefing(sdb *sessiondb.SessionDB, prevType, newType, cwd string) string {
	on, _ := sdb.IsOnCooldown("task_transition")
	if on {
		return ""
	}

	var b strings.Builder

	// 1. Intent transition header.
	if prevType != "" {
		fmt.Fprintf(&b, "Task switch: %s → %s.", prevType, newType)
	} else {
		fmt.Fprintf(&b, "Task classified: %s.", newType)
	}

	// 2. Unresolved failures from previous task.
	if prevType != "" {
		failures, _ := sdb.RecentFailures(5)
		var unresolvedFiles []string
		var priorityFile string
		for _, f := range failures {
			if f.FilePath == "" {
				continue
			}
			if ur, failType, _ := sdb.HasUnresolvedFailure(f.FilePath); ur {
				label := fmt.Sprintf("%s in %s", failType, filepath.Base(f.FilePath))
				unresolvedFiles = append(unresolvedFiles, label)
				if priorityFile == "" {
					priorityFile = label
				}
			}
			if len(unresolvedFiles) >= 5 {
				break
			}
		}
		if len(unresolvedFiles) > 0 {
			fmt.Fprintf(&b, " Carrying %d unresolved failure(s) from %s — priority: %s.",
				len(unresolvedFiles), prevType, priorityFile)
		}
	}

	// 3. Blast radius summary for working set files.
	wsFiles, _ := sdb.GetWorkingSetFiles()
	if len(wsFiles) > 0 && cwd != "" {
		var highRisk []string
		maxScore := 0
		limit := min(5, len(wsFiles))
		for i := range limit {
			info := analyzeImpact(nil, wsFiles[i], cwd)
			if info == nil || info.BlastScore < 25 {
				continue
			}
			if info.BlastScore > maxScore {
				maxScore = info.BlastScore
			}
			highRisk = append(highRisk, fmt.Sprintf("%s(%d)", filepath.Base(wsFiles[i]), info.BlastScore))
		}
		if len(highRisk) > 0 {
			fmt.Fprintf(&b, " Blast radius: %s (max %d/100).", strings.Join(highRisk, ", "), maxScore)
		}
	}

	// 4. START HERE: concrete first action for the new task.
	if action := taskTransitionAction(sdb, TaskType(newType)); action != "" {
		fmt.Fprintf(&b, "\nSTART HERE: %s", action)
	}

	result := b.String()
	if result == "" {
		return ""
	}

	_ = sdb.SetCooldown("task_transition", 3*time.Minute)
	return result
}

func taskTransitionAction(sdb *sessiondb.SessionDB, newType TaskType) string {
	switch newType {
	case TaskBugfix:
		return "Reproduce the bug — run the failing test or trigger the error path"
	case TaskFeature:
		return "Read the integration points — find where the new feature connects"
	case TaskRefactor:
		return "Run tests to establish a green baseline before changing code"
	case TaskTest:
		return "Read the code under test — identify the public API and edge cases"
	case TaskExplore:
		return "Start with the entry point — read main or the top-level handler"
	case TaskDebug:
		return "Reproduce the issue — run the command that triggers the unexpected behavior"
	default:
		return ""
	}
}
