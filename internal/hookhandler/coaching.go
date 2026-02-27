package hookhandler

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// coachingEntry is a template for phase-transition coaching.
type coachingEntry struct {
	situation  string
	reasoning  string
	suggestion string
	command    string // optional copy-pasteable command (e.g., "go test ./...")
}

// coachingTable maps TaskType → Phase → coaching template.
// Fires on phase transitions to provide proactive guidance.
var coachingTable = map[TaskType]map[Phase]coachingEntry{
	TaskBugfix: {
		PhaseExplore: {
			situation:  "Starting bug investigation",
			reasoning:  "Fixing a bug before reproducing it leads to 60% longer resolution times.",
			suggestion: "Reproduce the bug with a failing test first. This gives you a verifiable target.",
		},
		PhaseImplement: {
			situation:  "Transitioning from investigation to fix",
			reasoning:  "Focused, minimal fixes have higher success rates than broad changes.",
			suggestion: "Fix only the root cause. Avoid refactoring nearby code — that's a separate task.",
		},
		PhaseTest: {
			situation:  "Testing the bug fix",
			reasoning:  "A fix without a regression test will likely break again in future changes.",
			suggestion: "Ensure the failing test now passes AND add a regression test for the edge case.",
		},
	},
	TaskFeature: {
		PhaseExplore: {
			situation:  "Exploring for new feature",
			reasoning:  "Understanding the existing architecture prevents duplicate work and API mismatches.",
			suggestion: "Identify the integration points first. Check existing patterns in the codebase before designing new ones.",
		},
		PhaseImplement: {
			situation:  "Implementing new feature",
			reasoning:  "Features built without tests accumulate technical debt that slows future development.",
			suggestion: "Write tests alongside the implementation, not after. Test the public API contract.",
		},
		PhaseTest: {
			situation:  "Testing new feature",
			reasoning:  "Feature tests that only cover the happy path miss 70% of real-world failure modes.",
			suggestion: "Test edge cases and error paths. What happens with empty input? Invalid data? Concurrent access?",
		},
	},
	TaskRefactor: {
		PhaseExplore: {
			situation:  "Exploring code for refactoring",
			reasoning:  "Refactoring without a green test suite means you can't verify behavior is preserved.",
			suggestion: "Ensure all existing tests pass BEFORE starting. If coverage is low, add characterization tests first.",
		},
		PhaseImplement: {
			situation:  "Refactoring code",
			reasoning:  "Large refactors that touch many files are harder to review and more likely to introduce bugs.",
			suggestion: "Make small, incremental changes. Run tests after each step. Commit frequently.",
		},
		PhaseVerify: {
			situation:  "Verifying refactored code",
			reasoning:  "Refactoring should change structure, not behavior. All existing tests must still pass.",
			suggestion: "Run the full test suite, not just targeted tests. Check for subtle behavior changes in edge cases.",
		},
	},
	TaskTest: {
		PhaseExplore: {
			situation:  "Exploring code for test writing",
			reasoning:  "Effective tests require understanding the contract, not just the implementation.",
			suggestion: "Read the public API and documented behavior first. Focus on what the code should do, not how it does it.",
		},
		PhaseImplement: {
			situation:  "Writing tests",
			reasoning:  "Tests coupled to implementation details break on every refactor, creating maintenance burden.",
			suggestion: "Test behavior through the public interface. Use table-driven tests for comprehensive coverage.",
		},
	},
	TaskExplore: {
		PhaseExplore: {
			situation:  "Starting codebase exploration",
			reasoning:  "Unfocused exploration leads to context overload without actionable insight.",
			suggestion: "Define what you're looking for before diving in. Start from entry points (main, handlers, routes) and trace the call chain.",
		},
		PhaseDiagnose: {
			situation:  "Analyzing exploration findings",
			reasoning:  "Raw observations without synthesis don't transfer into useful knowledge.",
			suggestion: "Summarize what you found: key abstractions, data flow, and the one thing that surprised you most.",
		},
	},
	TaskDebug: {
		PhaseExplore: {
			situation:  "Starting debug investigation",
			reasoning:  "Debugging by reading code alone misses runtime state that caused the issue.",
			suggestion: "Gather runtime evidence first: logs, error messages, stack traces. Reproduce before theorizing.",
		},
		PhaseReproduce: {
			situation:  "Reproducing the issue",
			reasoning:  "A reproducible bug is 80% solved. Without reproduction, you're guessing at the fix.",
			suggestion: "Create a minimal reproduction case. Strip away unrelated code until you isolate the trigger.",
		},
		PhaseDiagnose: {
			situation:  "Diagnosing root cause",
			reasoning:  "Fixing symptoms instead of root causes leads to recurring bugs and wasted sessions.",
			suggestion: "Trace backwards from the symptom. Ask 'why does this value exist here?' not 'how do I make it go away?'",
		},
		PhaseImplement: {
			situation:  "Implementing debug fix",
			reasoning:  "Debug fixes under pressure tend to be narrow patches that miss related failure modes.",
			suggestion: "Fix the root cause, not just the symptom. Check if the same pattern exists elsewhere in the codebase.",
		},
		PhaseVerify: {
			situation:  "Verifying debug fix",
			reasoning:  "A fix that passes the original reproduction but breaks something else is net negative.",
			suggestion: "Run the full test suite, not just the reproduction case. Add a regression test for this specific bug.",
		},
	},
	TaskReview: {
		PhaseExplore: {
			situation:  "Starting code review",
			reasoning:  "Reviewing without understanding the intent leads to nitpicking style instead of catching real issues.",
			suggestion: "Read the PR description and linked issue first. Understand what problem is being solved before evaluating the solution.",
		},
		PhaseDiagnose: {
			situation:  "Evaluating review findings",
			reasoning:  "Listing every minor issue dilutes the signal. Reviewers who prioritize get better outcomes.",
			suggestion: "Separate blocking issues from suggestions. Focus on correctness and security first, style last.",
		},
		PhaseRefine: {
			situation:  "Providing review feedback",
			reasoning:  "Vague feedback ('this is confusing') creates back-and-forth. Specific feedback gets resolved in one round.",
			suggestion: "For each issue: state what's wrong, why it matters, and suggest a concrete fix.",
		},
	},
	TaskDocs: {
		PhaseExplore: {
			situation:  "Exploring code for documentation",
			reasoning:  "Documentation written without running the code often contains inaccuracies.",
			suggestion: "Run through the actual usage flow before documenting. Verify examples work. Check for undocumented prerequisites.",
		},
		PhaseImplement: {
			situation:  "Writing documentation",
			reasoning:  "Documentation that describes implementation instead of usage becomes stale immediately after refactoring.",
			suggestion: "Document the 'what' and 'why', not the 'how'. Focus on usage examples, not internal implementation details.",
		},
		PhaseVerify: {
			situation:  "Verifying documentation",
			reasoning:  "Untested code examples in documentation are a leading source of developer frustration.",
			suggestion: "Copy-paste every code example and run it. Verify links work. Have someone unfamiliar with the code try following the docs.",
		},
	},
}

// domainCoachingOverrides provides domain-specific coaching that replaces
// the generic coaching when domain + task type + phase all match.
var domainCoachingOverrides = map[string]map[TaskType]map[Phase]coachingEntry{
	"auth": {
		TaskFeature: {
			PhaseImplement: {
				situation:  "Implementing authentication feature",
				reasoning:  "Auth code is high-risk. A single vulnerability can compromise the entire system.",
				suggestion: "Write negative tests first (invalid tokens, expired sessions, missing credentials). Then implement the happy path.",
			},
		},
		TaskBugfix: {
			PhaseExplore: {
				situation:  "Investigating auth bug",
				reasoning:  "Auth bugs often stem from token lifecycle issues that are hard to reproduce without exact conditions.",
				suggestion: "Check token expiry logic, session state, and credential validation order. Reproduce with exact failure conditions.",
			},
		},
	},
	"database": {
		TaskFeature: {
			PhaseImplement: {
				situation:  "Implementing database feature",
				reasoning:  "Schema changes are often irreversible in production. Migration order and rollback strategy matter.",
				suggestion: "Write the migration with a rollback plan. Test the migration up AND down before committing.",
			},
		},
		TaskRefactor: {
			PhaseImplement: {
				situation:  "Refactoring database code",
				reasoning:  "Database refactors can cause data loss if migration steps are wrong.",
				suggestion: "Never modify existing migration files. Create new migrations for schema changes. Test with realistic data volumes.",
			},
		},
	},
	"infra": {
		TaskFeature: {
			PhaseImplement: {
				situation:  "Implementing infrastructure change",
				reasoning:  "Infrastructure changes affect all environments. A typo in YAML can cause outages.",
				suggestion: "Validate configuration syntax before applying. Use dry-run where available. Check for environment-specific overrides.",
			},
		},
	},
	"api": {
		TaskFeature: {
			PhaseImplement: {
				situation:  "Implementing API endpoint",
				reasoning:  "API contracts are hard to change once consumers depend on them. Breaking changes cause cascading failures.",
				suggestion: "Define the request/response schema first. Validate input at the boundary. Consider versioning from day one.",
			},
		},
		TaskReview: {
			PhaseExplore: {
				situation:  "Reviewing API changes",
				reasoning:  "API review should focus on contract stability, not internal implementation.",
				suggestion: "Check for breaking changes in request/response shapes. Verify error codes are consistent and documented.",
			},
		},
	},
	"ui": {
		TaskDebug: {
			PhaseReproduce: {
				situation:  "Reproducing UI bug",
				reasoning:  "UI bugs are often device/browser/state specific. Screenshots alone don't capture the trigger.",
				suggestion: "Note the exact browser, viewport size, and user actions. Check if the issue reproduces with an empty cache.",
			},
		},
	},
}

// generateCoaching produces a phase-transition coaching message
// based on current task type, domain, and the new phase.
func generateCoaching(sdb *sessiondb.SessionDB) string {
	// Only fire on phase transitions.
	changed, _ := sdb.GetContext("coaching_phase_changed")
	if changed != "true" {
		return ""
	}
	// Consume the flag.
	_ = sdb.SetContext("coaching_phase_changed", "")

	taskTypeStr, _ := sdb.GetContext("task_type")
	taskType := TaskType(taskTypeStr)
	if taskType == "" || taskType == TaskUnknown {
		return ""
	}

	phaseStr, _ := sdb.GetContext("prev_phase")
	phase := mapRawPhaseStr(phaseStr)
	if phase == PhaseUnknown {
		return ""
	}

	// Cooldown: max one coaching per task type × phase combination per 10 minutes.
	cooldownKey := "coaching_" + taskTypeStr + "_" + string(phase)
	set, _ := sdb.TrySetCooldown(cooldownKey, 10*time.Minute)
	if !set {
		return ""
	}

	domain, _ := sdb.GetWorkingSet("domain")

	riskProfile, _ := sdb.GetWorkingSet("risk_profile")

	// Try domain-specific override first.
	if domain != "" && domain != "general" {
		if domainMap, ok := domainCoachingOverrides[domain]; ok {
			if taskMap, ok := domainMap[taskType]; ok {
				if entry, ok := taskMap[phase]; ok {
					entry = adaptToneForRiskProfile(entry, riskProfile)
					return formatCoaching(entry)
				}
			}
		}
	}

	// Fall back to generic coaching table.
	if taskMap, ok := coachingTable[taskType]; ok {
		if entry, ok := taskMap[phase]; ok {
			// Enrich test-phase coaching with concrete test command.
			if phase == PhaseTest || phase == PhaseVerify {
				entry = enrichWithTestCommand(sdb, entry)
			}
			// Enrich with personal history from cross-session data.
			entry = personalizeCoaching(sdb, entry, taskType)
			entry = adaptToneForRiskProfile(entry, riskProfile)
			return formatCoaching(entry)
		}
	}

	return ""
}

// adaptToneForRiskProfile adjusts coaching tone based on the user's risk profile.
// Conservative users get verification-first guidance, aggressive users get
// downstream-impact awareness nudges.
func adaptToneForRiskProfile(entry coachingEntry, riskProfile string) coachingEntry {
	switch riskProfile {
	case "conservative":
		entry.suggestion += " You tend to be thorough — trust your instincts and verify before moving on."
	case "aggressive":
		entry.suggestion += " You move fast — pause to consider downstream impact before continuing."
	}
	return entry
}

// enrichWithTestCommand adds a concrete test command to coaching entries
// when coverage map and working set files are available.
func enrichWithTestCommand(sdb *sessiondb.SessionDB, entry coachingEntry) coachingEntry {
	if entry.command != "" {
		return entry
	}
	cm := LoadCoverageMap(sdb)
	if cm == nil {
		return entry
	}
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return entry
	}
	lastFile := files[len(files)-1]
	if cmd := SuggestTestCommand(cm, lastFile, nil, ""); cmd != "" {
		entry.command = cmd
	}
	return entry
}

// formatCoaching formats a coaching entry for display.
func formatCoaching(entry coachingEntry) string {
	msg := fmt.Sprintf("[buddy] coaching: %s\n  WHY: %s\n→ %s",
		entry.situation, entry.reasoning, entry.suggestion)
	if entry.command != "" {
		msg += "\n  Run: " + entry.command
	}
	return msg
}

// mapRawPhaseStr maps raw phase strings from recordPhase() to Phase constants.
func mapRawPhaseStr(phase string) Phase {
	switch phase {
	case "read":
		return PhaseExplore
	case "write":
		return PhaseImplement
	case "test":
		return PhaseTest
	case "compile":
		return PhaseVerify
	case "plan":
		return PhasePlan
	}
	return PhaseUnknown
}

// preActionCoaching generates pre-action coaching for specific risk scenarios.
// Returns a coaching message or "" if no coaching applies.
func preActionCoaching(sdb *sessiondb.SessionDB, toolName string, toolInput map[string]any) string {
	taskTypeStr, _ := sdb.GetContext("task_type")
	domain, _ := sdb.GetWorkingSet("domain")

	// Trigger 1: First Write/Edit without reading test files.
	// Suppressed during Test/Verify phases — user is already testing.
	if (toolName == "Edit" || toolName == "Write") && isFirstWrite(sdb) {
		if taskTypeStr != "" && taskTypeStr != string(TaskUnknown) {
			phase := classifyCurrentPhase(sdb, TaskType(taskTypeStr))
			if phase != PhaseTest && phase != PhaseVerify {
				set, _ := sdb.TrySetCooldown("coaching_test_first", 15*time.Minute)
				if set && !hasReadTestFile(sdb) {
					return "[buddy] coaching (pre-action): First edit without reading test files.\n" +
						"  WHY: Editing without knowing the existing test expectations risks breaking tests silently.\n" +
						"→ Consider reading the related test file first to understand the current assertions."
				}
			}
		}
	}

	// Trigger 2: Running tests when build is broken.
	if toolName == "Bash" {
		if cmd, ok := toolInput["command"].(string); ok && testCmdPattern.MatchString(cmd) {
			buildPassed, _ := sdb.GetContext("last_build_passed")
			if buildPassed == "false" {
				set, _ := sdb.TrySetCooldown("coaching_build_first", 15*time.Minute)
				if set {
					return "[buddy] coaching (pre-action): Running tests with a broken build.\n" +
						"  WHY: Compile errors prevent tests from producing useful output. You'll get noise, not signal.\n" +
						"→ Fix the build errors first, then run tests."
				}
			}
		}
	}

	// Trigger 3: Domain-specific pre-coaching.
	if msg := domainPreCoaching(sdb, domain, taskTypeStr, toolName, toolInput); msg != "" {
		return msg
	}

	return ""
}

// isFirstWrite checks if this is the first write operation in the current burst.
func isFirstWrite(sdb *sessiondb.SessionDB) bool {
	_, hasWrite, _, _ := sdb.BurstState()
	return !hasWrite
}

// hasReadTestFile checks if any test file has been read in the current burst.
func hasReadTestFile(sdb *sessiondb.SessionDB) bool {
	_, _, fileReads, err := sdb.BurstState()
	if err != nil {
		return false
	}
	for path := range fileReads {
		if testFilePathPattern.MatchString(path) {
			return true
		}
	}
	return false
}

// testFilePathPattern matches common test file naming conventions.
var testFilePathPattern = regexp.MustCompile(`(?i)(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|test_\w+\.py|_test\.py|_test\.rs)$`)

// personalizeCoaching enriches a static coaching template with the user's
// actual cross-session data. Transforms generic advice ("tests prevent regressions")
// into personal evidence ("your test-first bugfix sessions average 22 tools vs 45 without").
func personalizeCoaching(sdb *sessiondb.SessionDB, entry coachingEntry, taskType TaskType) coachingEntry {
	st, err := store.OpenDefault()
	if err != nil {
		return entry
	}
	defer st.Close()

	projectPath, _ := sdb.GetWorkingSet("project_path")

	// Axis 1: Workflow efficiency (tool count comparison).
	successful, err := st.GetSuccessfulWorkflows(projectPath, string(taskType), 20)
	if err != nil || len(successful) < 3 {
		return entry
	}

	var totalTools, totalDuration int
	for _, w := range successful {
		totalTools += w.ToolCount
		totalDuration += w.DurationSec
	}
	avgTools := totalTools / len(successful)

	personalNote := fmt.Sprintf(" Your successful %s sessions average %d tools across %d sessions.",
		taskType, avgTools, len(successful))

	// Axis 2: Success vs failure contrast.
	failed, _ := st.GetFailedWorkflows(string(taskType), 10)
	if len(failed) >= 2 {
		var failedTools int
		for _, w := range failed {
			failedTools += w.ToolCount
		}
		avgFailed := failedTools / len(failed)
		if avgFailed > avgTools+10 {
			personalNote += fmt.Sprintf(" Failed sessions averaged %d tools.", avgFailed)
		}
	}

	// Axis 3: Test frequency — low testers get a stronger test nudge.
	if tf, count, err := st.GetUserProfile("test_frequency"); err == nil && count >= 5 {
		if tf < 0.3 {
			personalNote += " Your test frequency is low — sessions with early testing resolve faster."
		}
	}

	// Axis 4: Session duration — flag if successful sessions are consistently short.
	if totalDuration > 0 {
		avgDuration := totalDuration / len(successful)
		if avgDuration > 0 && avgDuration < 600 {
			personalNote += fmt.Sprintf(" Successful sessions typically finish in ~%d min.", avgDuration/60)
		}
	}

	entry.reasoning += personalNote
	return entry
}

// domainPreCoaching provides domain-specific pre-action warnings.
// Unlike domainRiskCheck (which covers file-level risk), this focuses on
// workflow-level coaching: when to stop and think, not what's risky.
func domainPreCoaching(sdb *sessiondb.SessionDB, domain, _ /* taskType */, toolName string, toolInput map[string]any) string {
	if domain == "" || domain == "general" {
		return ""
	}

	filePath, _ := toolInput["file_path"].(string)

	// Workflow-level coaching (complements domainRiskCheck's file-level warnings).
	switch domain {
	case "auth":
		if (toolName == "Edit" || toolName == "Write") && filePath != "" {
			if containsAny(strings.ToLower(filePath), "auth", "login", "session", "oauth") {
				set, _ := sdb.TrySetCooldown("domain_coaching_auth", 15*time.Minute)
				if !set {
					return ""
				}
				return "[buddy] coaching (pre-action): Editing core auth flow.\n" +
					"  WHY: Auth changes affect every user. A subtle logic error can lock out legitimate users or let attackers in.\n" +
					"→ Have you written negative tests (invalid token, expired session, wrong password) for this change?"
			}
		}
	case "database":
		if (toolName == "Edit" || toolName == "Write") && filePath != "" {
			if containsAny(strings.ToLower(filePath), "migrat", "schema", "model") {
				set, _ := sdb.TrySetCooldown("domain_coaching_database", 15*time.Minute)
				if !set {
					return ""
				}
				return "[buddy] coaching (pre-action): Editing database schema/migration code.\n" +
					"  WHY: Schema changes are coupled to data. A bad migration on production data is hard to undo.\n" +
					"→ Test the migration with realistic data. Verify both UP and DOWN paths."
			}
		}
	case "infra":
		if toolName == "Bash" {
			if cmd, ok := toolInput["command"].(string); ok {
				if containsAny(strings.ToLower(cmd), "deploy", "apply", "push") {
					set, _ := sdb.TrySetCooldown("domain_coaching_infra", 15*time.Minute)
					if !set {
						return ""
					}
					return "[buddy] coaching (pre-action): Running a deployment command.\n" +
						"  WHY: Deployment commands affect live systems. Verify you're targeting the correct environment.\n" +
						"→ Check the target environment (staging vs production) before proceeding."
				}
			}
		}
	}

	return ""
}
