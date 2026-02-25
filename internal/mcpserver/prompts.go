package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// registerPrompts adds MCP prompts to the server.
func registerPrompts(s *server.MCPServer, claudeHome string, lang locale.Lang, st *store.Store) {
	s.AddPrompts(
		server.ServerPrompt{
			Prompt: mcp.Prompt{
				Name:        "health_check",
				Description: "Run a comprehensive session health diagnostic",
			},
			Handler: healthCheckPrompt(claudeHome, lang),
		},
		server.ServerPrompt{
			Prompt: mcp.Prompt{
				Name:        "resume",
				Description: "Resume context from a previous session with decisions, files, and summary",
			},
			Handler: resumePrompt(st),
		},
		server.ServerPrompt{
			Prompt: mcp.Prompt{
				Name:        "playbook",
				Description: "Get workflow recommendations for a task type",
				Arguments: []mcp.PromptArgument{
					{
						Name:        "task_type",
						Description: "Task type: bugfix, feature, refactor, research, review",
						Required:    true,
					},
				},
			},
			Handler: playbookPrompt(st),
		},
	)
}

func healthCheckPrompt(claudeHome string, lang locale.Lang) server.PromptHandlerFunc {
	return func(ctx context.Context, request mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return &mcp.GetPromptResult{
				Description: "Session health check",
				Messages: []mcp.PromptMessage{
					{Role: "user", Content: mcp.TextContent{Text: "No active session found. Start a session first."}},
				},
			}, nil
		}

		alerts, score := computeAlertsAndScore(session, lang)
		var b strings.Builder
		fmt.Fprintf(&b, "Session Health Score: %.2f/1.0\n", score)
		fmt.Fprintf(&b, "Active Alerts: %d\n\n", len(alerts))

		if len(alerts) > 0 {
			b.WriteString("Issues detected:\n")
			for i, a := range alerts {
				fmt.Fprintf(&b, "%d. [%s] %s: %s\n   Suggestion: %s\n",
					i+1, a.Level, a.Pattern, a.Observation, a.Suggestion)
			}
		} else {
			b.WriteString("No issues detected. Session is healthy.")
		}

		return &mcp.GetPromptResult{
			Description: "Session health diagnostic",
			Messages: []mcp.PromptMessage{
				{Role: "user", Content: mcp.TextContent{Text: b.String()}},
			},
		}, nil
	}
}

func resumePrompt(st *store.Store) server.PromptHandlerFunc {
	return func(ctx context.Context, request mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		if st == nil {
			return &mcp.GetPromptResult{
				Description: "Resume session context",
				Messages: []mcp.PromptMessage{
					{Role: "user", Content: mcp.TextContent{Text: "No persistent store available."}},
				},
			}, nil
		}

		decisions, _ := st.SearchDecisions("", "", 5)
		var b strings.Builder
		b.WriteString("Previous session context:\n\n")

		if len(decisions) > 0 {
			b.WriteString("Recent design decisions:\n")
			for _, d := range decisions {
				fmt.Fprintf(&b, "  - %s: %s\n", d.Topic, d.DecisionText)
			}
		} else {
			b.WriteString("No previous decisions found.\n")
		}

		return &mcp.GetPromptResult{
			Description: "Previous session context",
			Messages: []mcp.PromptMessage{
				{Role: "user", Content: mcp.TextContent{Text: b.String()}},
			},
		}, nil
	}
}

func playbookPrompt(st *store.Store) server.PromptHandlerFunc {
	return func(ctx context.Context, request mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		taskType := request.Params.Arguments["task_type"]
		if taskType == "" {
			taskType = "feature"
		}

		var b strings.Builder
		fmt.Fprintf(&b, "Recommended workflow for task type: %s\n\n", taskType)

		// Try to find learned workflow from store.
		if st != nil {
			workflow, count, _ := st.MostCommonWorkflow("", taskType, 3)
			if len(workflow) > 0 {
				fmt.Fprintf(&b, "Learned workflow (from %d past sessions):\n", count)
				for i, phase := range workflow {
					fmt.Fprintf(&b, "  %d. %s\n", i+1, phase)
				}
				b.WriteString("\n")
			}
		}

		// Default playbooks.
		playbooks := map[string]string{
			"bugfix": "1. Read error/bug report\n2. Reproduce with test\n3. Read relevant code\n4. Fix the issue\n5. Run tests\n6. Verify fix",
			"feature": "1. Plan the approach\n2. Read existing code\n3. Implement incrementally\n4. Write tests\n5. Run tests\n6. Review changes",
			"refactor": "1. Run existing tests (baseline)\n2. Read code to refactor\n3. Plan refactoring steps\n4. Refactor incrementally\n5. Run tests after each step\n6. Verify no behavior change",
			"research": "1. Define the question\n2. Search codebase with Grep/Glob\n3. Read key files\n4. Summarize findings",
			"review": "1. Read the diff\n2. Check for common issues\n3. Run tests if applicable\n4. Provide feedback",
		}

		if playbook, ok := playbooks[taskType]; ok {
			b.WriteString("Default playbook:\n")
			b.WriteString(playbook)
		} else {
			b.WriteString("No predefined playbook for this task type. Use the general feature workflow.")
		}

		return &mcp.GetPromptResult{
			Description: fmt.Sprintf("Workflow playbook for %s", taskType),
			Messages: []mcp.PromptMessage{
				{Role: "user", Content: mcp.TextContent{Text: b.String()}},
			},
		}, nil
	}
}
