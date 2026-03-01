package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func reviewHandler(claudeHome string, st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")

		report := map[string]any{
			"project_path": projectPath,
		}

		// 1. Check CLAUDE.md
		report["claude_md"] = reviewClaudeMD(projectPath)

		// 2. Check .claude/ directory (skills, rules, agents)
		report["skills"] = reviewDir(projectPath, ".claude", "skills")
		report["rules"] = reviewDir(projectPath, ".claude", "rules")
		report["agents"] = reviewDir(projectPath, ".claude", "agents")

		// 3. Check hooks in settings.json
		report["hooks"] = reviewHooks(claudeHome)

		// 4. Check MCP servers
		report["mcp_servers"] = reviewMCP(projectPath)

		// 5. Session stats from store
		if st != nil && projectPath != "" {
			if stats, err := st.GetProjectSessionStats(projectPath); err == nil {
				report["session_stats"] = map[string]any{
					"total_sessions":      stats.TotalSessions,
					"total_turns":         stats.TotalTurns,
					"total_tool_uses":     stats.TotalToolUses,
					"total_compacts":      stats.TotalCompacts,
					"avg_turns_per_session": stats.AvgTurnsPerSession,
				}
			}
		}

		// Generate improvement suggestions.
		formatReviewSuggestions(report)

		return marshalResult(report)
	}
}

func reviewClaudeMD(projectPath string) map[string]any {
	result := map[string]any{"exists": false}
	if projectPath == "" {
		return result
	}

	path := filepath.Join(projectPath, "CLAUDE.md")
	data, err := os.ReadFile(path)
	if err != nil {
		return result
	}

	content := string(data)
	result["exists"] = true
	result["size_bytes"] = len(data)
	result["lines"] = countLines(content)

	return result
}

func reviewDir(projectPath, base, sub string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, base, sub)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var names []string
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		} else {
			// Skills are directories containing SKILL.md
			skillFile := filepath.Join(dir, e.Name(), "SKILL.md")
			if _, err := os.Stat(skillFile); err == nil {
				names = append(names, e.Name())
			}
		}
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	return result
}

func reviewHooks(claudeHome string) map[string]any {
	result := map[string]any{"count": 0}

	settingsPath := filepath.Join(claudeHome, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return result
	}

	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return result
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		return result
	}

	result["count"] = len(hooks)
	events := make([]string, 0, len(hooks))
	for event := range hooks {
		events = append(events, event)
	}
	result["events"] = events
	return result
}

func reviewMCP(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	mcpPath := filepath.Join(projectPath, ".mcp.json")
	data, err := os.ReadFile(mcpPath)
	if err != nil {
		return result
	}

	var mcpConfig map[string]any
	if err := json.Unmarshal(data, &mcpConfig); err != nil {
		return result
	}

	servers, ok := mcpConfig["mcpServers"].(map[string]any)
	if !ok {
		return result
	}

	result["count"] = len(servers)
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	result["servers"] = names
	return result
}

func countLines(s string) int {
	n := 0
	for _, c := range s {
		if c == '\n' {
			n++
		}
	}
	if len(s) > 0 && s[len(s)-1] != '\n' {
		n++
	}
	return n
}

// formatReviewSuggestions generates improvement suggestions based on the review.
func formatReviewSuggestions(report map[string]any) []string {
	var suggestions []string

	claudeMD, _ := report["claude_md"].(map[string]any)
	if exists, _ := claudeMD["exists"].(bool); !exists {
		suggestions = append(suggestions, "Create a CLAUDE.md file to give Claude Code project-specific instructions")
	}

	skills, _ := report["skills"].(map[string]any)
	if count, _ := skills["count"].(int); count == 0 {
		suggestions = append(suggestions, "Add custom skills (.claude/skills/) to automate repetitive workflows")
	}

	rules, _ := report["rules"].(map[string]any)
	if count, _ := rules["count"].(int); count == 0 {
		suggestions = append(suggestions, "Add rules (.claude/rules/) to enforce coding standards automatically")
	}

	hooks, _ := report["hooks"].(map[string]any)
	if count, _ := hooks["count"].(int); count == 0 {
		suggestions = append(suggestions, "Configure hooks for automated checks (tests, linting) on tool use")
	}

	if len(suggestions) > 0 {
		report["suggestions"] = suggestions
		report["suggestion_count"] = len(suggestions)
	} else {
		report["suggestions"] = []string{}
		report["suggestion_count"] = 0
		report["summary"] = "Good setup! CLAUDE.md, skills, rules, and hooks are all configured."
	}

	return suggestions
}
