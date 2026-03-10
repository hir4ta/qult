package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"gopkg.in/yaml.v3"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

func reviewHandler(claudeHome string, st *store.Store, _ *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath, errResult := validateProjectPath(req.GetString("project_path", ""))
		if errResult != nil {
			return errResult, nil
		}

		report := map[string]any{
			"project_path": projectPath,
		}

		// 1. Check CLAUDE.md
		report["claude_md"] = reviewClaudeMD(projectPath)

		// 2. Check .claude/ directory (skills, rules, agents)
		report["skills"] = reviewSkills(projectPath)
		report["rules"] = reviewRules(projectPath)
		report["agents"] = reviewAgents(projectPath, claudeHome)

		// 3. Check hooks (project-level .claude/hooks.json + user settings)
		report["hooks"] = reviewHooks(claudeHome, projectPath)

		// 4. Check MCP servers
		report["mcp_servers"] = reviewMCP(projectPath)

		// 5. Check permissions settings
		report["permissions"] = reviewPermissions(claudeHome, projectPath)

		// Generate improvement suggestions with KB cross-reference.
		suggestions := generateReviewSuggestions(ctx, report, st)
		report["suggestions"] = suggestions
		report["suggestion_count"] = len(suggestions)

		// Maturity scoring: score each category and compute overall.
		maturity := computeMaturityScore(report, suggestions)
		report["maturity"] = maturity
		if len(suggestions) == 0 {
			report["summary"] = "Good setup! CLAUDE.md, skills, rules, and hooks are all configured."
		}

		return marshalResult(report)
	}
}

// ---------------------------------------------------------------------------
// CLAUDE.md analysis
// ---------------------------------------------------------------------------

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
	lines := countLines(content)
	sections := extractH2Sections(content)

	result["exists"] = true
	result["size_bytes"] = len(data)
	result["lines"] = lines
	result["sections"] = sections
	result["section_count"] = len(sections)

	if lines > 200 {
		result["size_warning"] = "large (>200 lines): consider splitting or trimming"
	}

	// Check for key sections.
	keyMap := map[string]bool{}
	lowerContent := strings.ToLower(content)
	for _, kw := range []string{"commands", "stack", "git", "rules", "structure"} {
		keyMap[kw] = strings.Contains(lowerContent, "## "+kw) ||
			strings.Contains(lowerContent, "## "+kw+"s") ||
			strings.Contains(lowerContent, "## "+kw+" ")
	}
	result["key_sections"] = keyMap

	return result
}

// extractH2Sections returns the list of ## header titles in markdown content.
func extractH2Sections(content string) []string {
	var sections []string
	for line := range strings.SplitSeq(content, "\n") {
		if rest, ok := strings.CutPrefix(line, "## "); ok {
			sections = append(sections, strings.TrimSpace(rest))
		}
	}
	return sections
}

// ---------------------------------------------------------------------------
// Skills analysis (with deep content inspection)
// ---------------------------------------------------------------------------

// skillInfo holds parsed metadata for a single skill.
type skillInfo struct {
	Name          string   `json:"name"`
	HasName       bool     `json:"has_name"`
	HasDesc       bool     `json:"has_description"`
	HasTrigger    bool     `json:"has_trigger"`
	HasAllowed    bool     `json:"has_allowed_tools"`
	UserInvocable bool     `json:"user_invocable"`
	BodyLines     int      `json:"body_lines"`
	SizeWarning   string   `json:"size_warning,omitempty"`
	HasSupport    bool     `json:"has_support_files"`
	AllowedTools  []string `json:"allowed_tools,omitempty"`
}

func reviewSkills(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, ".claude", "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var skills []skillInfo
	var names []string
	var invalid []string

	for _, e := range entries {
		if e.IsDir() {
			skillFile := filepath.Join(dir, e.Name(), "SKILL.md")
			data, err := os.ReadFile(skillFile)
			if err != nil {
				continue
			}
			content := string(data)
			fm := parseSKILLFrontmatter(content)

			// Count body lines (after frontmatter).
			bodyLines := countBodyLines(content)

			// Parse allowed-tools into a slice.
			var allowedTools []string
			if raw := fm["allowed-tools"]; raw != "" {
				for _, t := range strings.Split(raw, ",") {
					t = strings.TrimSpace(t)
					if t != "" {
						allowedTools = append(allowedTools, t)
					}
				}
			}

			// Check for support files (anything besides SKILL.md in the skill dir).
			hasSupport := false
			skillDirEntries, _ := os.ReadDir(filepath.Join(dir, e.Name()))
			for _, se := range skillDirEntries {
				if se.Name() != "SKILL.md" {
					hasSupport = true
					break
				}
			}

			si := skillInfo{
				Name:          e.Name(),
				HasName:       fm["name"] != "",
				HasDesc:       fm["description"] != "",
				HasTrigger:    fm["trigger"] != "",
				HasAllowed:    fm["allowed-tools"] != "",
				UserInvocable: fm["user-invocable"] == "true",
				BodyLines:     bodyLines,
				HasSupport:    hasSupport,
				AllowedTools:  allowedTools,
			}

			if bodyLines > 150 {
				si.SizeWarning = "skill body exceeds 150 lines; consider splitting into support files"
			}

			skills = append(skills, si)
			names = append(names, e.Name())
			if !si.HasName || !si.HasDesc {
				invalid = append(invalid, e.Name())
			}
		} else if strings.HasSuffix(e.Name(), ".md") || strings.HasSuffix(e.Name(), ".yaml") {
			names = append(names, e.Name())
		}
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	if len(skills) > 0 {
		result["skill_details"] = skills
	}
	if len(invalid) > 0 {
		result["invalid_skills"] = invalid
	}
	return result
}

// countBodyLines counts lines after YAML frontmatter (--- delimited).
func countBodyLines(content string) int {
	lines := strings.Split(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return countLines(content)
	}
	// Find closing ---.
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			body := strings.Join(lines[i+1:], "\n")
			return countLines(strings.TrimSpace(body))
		}
	}
	return countLines(content)
}

// parseSKILLFrontmatter extracts YAML frontmatter fields from SKILL.md content.
// Handles --- delimited blocks. Returns empty map if no frontmatter found.
// Uses gopkg.in/yaml.v3 for correct multi-line value handling (e.g. description: >-).
func parseSKILLFrontmatter(content string) map[string]string {
	result := make(map[string]string)

	lines := strings.Split(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return result
	}

	// Find closing ---
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return result
	}

	// Parse with yaml.v3 for correct multi-line scalar handling.
	fmBlock := strings.Join(lines[1:end], "\n")
	var parsed map[string]any
	if err := yaml.Unmarshal([]byte(fmBlock), &parsed); err != nil {
		return result
	}

	for k, v := range parsed {
		switch val := v.(type) {
		case string:
			result[k] = val
		case bool:
			if val {
				result[k] = "true"
			} else {
				result[k] = "false"
			}
		case int:
			result[k] = fmt.Sprintf("%d", val)
		case float64:
			result[k] = fmt.Sprintf("%g", val)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Rules analysis (with content inspection)
// ---------------------------------------------------------------------------

type ruleInfo struct {
	Name        string `json:"name"`
	Lines       int    `json:"lines"`
	HasGlob     bool   `json:"has_glob"`
	HasPaths    bool   `json:"has_paths"`
	SizeWarning string `json:"size_warning,omitempty"`
}

func reviewRules(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, ".claude", "rules")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var names []string
	var details []ruleInfo

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		names = append(names, e.Name())

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}

		content := string(data)
		lines := countLines(content)
		hasGlob := false

		// Check for glob/paths frontmatter (path-scoped rules).
		fm := parseSKILLFrontmatter(content) // reuse YAML frontmatter parser
		if fm["globs"] != "" || fm["glob"] != "" {
			hasGlob = true
		}
		hasPaths := fm["paths"] != ""

		ri := ruleInfo{
			Name:     e.Name(),
			Lines:    lines,
			HasGlob:  hasGlob,
			HasPaths: hasPaths,
		}
		if lines < 3 {
			ri.SizeWarning = "rule is too short to be useful"
		} else if lines > 100 {
			ri.SizeWarning = "rule exceeds 100 lines; consider splitting"
		}
		details = append(details, ri)
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	if len(details) > 0 {
		result["rule_details"] = details
	}
	return result
}

// ---------------------------------------------------------------------------
// Hooks analysis
// ---------------------------------------------------------------------------

// recommendedEvents lists hook events that provide significant value when configured.
var recommendedEvents = []string{"SessionStart", "PreCompact", "UserPromptSubmit"}

// validHookEvents lists all documented Claude Code hook events.
var validHookEvents = map[string]bool{
	"PreToolUse":           true,
	"PostToolUse":          true,
	"PostToolUseFailure":   true,
	"Notification":         true,
	"Stop":                 true,
	"SubagentStop":         true,
	"SubagentStart":        true,
	"SessionStart":         true,
	"SessionEnd":           true,
	"PreCompact":           true,
	"UserPromptSubmit":     true,
	"PreAPIRequest":        true,
	"PostAPIRequest":       true,
	"UIRender":             true,
	"PermissionRequest":    true,
	"TaskCompleted":        true,
	"TeammateIdle":         true,
	"WorktreeCreate":       true,
	"WorktreeRemove":       true,
	"InstructionsLoaded":   true,
	"ConfigChange":         true,
}

// validHookTypes lists known hook handler types.
var validHookTypes = map[string]bool{
	"command": true,
	"prompt":  true,
	"agent":   true,
	"http":    true,
}

// defaultHookTimeoutMs is the default timeout per hook type in milliseconds.
var defaultHookTimeoutMs = map[string]int{
	"command": 600000,
	"prompt":  30000,
	"agent":   60000,
	"http":    30000,
}

// hookIssue describes a structural problem in a hook configuration.
type hookIssue struct {
	Event    string `json:"event"`
	Severity string `json:"severity"` // "warning" or "info"
	Message  string `json:"message"`
}

func reviewHooks(claudeHome, projectPath string) map[string]any {
	result := map[string]any{"count": 0}

	allEvents := make(map[string]bool)
	var issues []hookIssue

	// parseHooksConfig validates hook entries within a hooks config map.
	parseHooksConfig := func(hooks map[string]any, source string) {
		for event, matchers := range hooks {
			allEvents[event] = true

			// Validate event name.
			if !validHookEvents[event] {
				issues = append(issues, hookIssue{
					Event:    event,
					Severity: "warning",
					Message:  fmt.Sprintf("unknown hook event %q in %s (may be ignored by Claude Code)", event, source),
				})
			}

			// Parse matchers array.
			matcherList, ok := matchers.([]any)
			if !ok {
				continue
			}
			for _, m := range matcherList {
				matcher, ok := m.(map[string]any)
				if !ok {
					continue
				}
				// Validate matcher regex if present.
				if matcherStr, ok := matcher["matcher"].(string); ok && matcherStr != "" {
					if _, err := regexp.Compile(matcherStr); err != nil {
						issues = append(issues, hookIssue{
							Event:    event,
							Severity: "warning",
							Message:  fmt.Sprintf("invalid matcher regex %q in %s %s: %v", matcherStr, source, event, err),
						})
					}
				}
				// Parse nested hooks array.
				hookEntries, ok := matcher["hooks"].([]any)
				if !ok {
					continue
				}
				for _, h := range hookEntries {
					entry, ok := h.(map[string]any)
					if !ok {
						continue
					}
					hookType, _ := entry["type"].(string)
					if hookType == "" {
						issues = append(issues, hookIssue{
							Event:    event,
							Severity: "warning",
							Message:  fmt.Sprintf("hook entry missing 'type' field in %s %s", source, event),
						})
						continue
					}
					if !validHookTypes[hookType] {
						issues = append(issues, hookIssue{
							Event:    event,
							Severity: "warning",
							Message:  fmt.Sprintf("unknown hook type %q in %s %s (expected: command, prompt, agent)", hookType, source, event),
						})
					}
					// Validate command non-empty for command type.
					if hookType == "command" {
						cmd, _ := entry["command"].(string)
						if strings.TrimSpace(cmd) == "" {
							issues = append(issues, hookIssue{
								Event:    event,
								Severity: "warning",
								Message:  fmt.Sprintf("command hook has empty 'command' field in %s %s", source, event),
							})
						}
					}
					// Validate timeout range: 1s absolute floor, 10x default ceiling.
					if timeout, ok := entry["timeout"].(float64); ok {
						timeoutMs := int(timeout * 1000)
						if defMs, ok := defaultHookTimeoutMs[hookType]; ok {
							if timeoutMs < 1000 || timeoutMs > defMs*10 {
								issues = append(issues, hookIssue{
									Event:    event,
									Severity: "info",
									Message:  fmt.Sprintf("unusual timeout %.0fs for %s hook in %s %s (default: %ds)", timeout, hookType, source, event, defMs/1000),
								})
							}
						}
					}
				}
			}
		}
	}

	// 1. Check project-level .claude/hooks.json (preferred location).
	if projectPath != "" {
		projectHooksPath := filepath.Join(projectPath, ".claude", "hooks.json")
		if data, err := os.ReadFile(projectHooksPath); err == nil {
			var hooksConfig struct {
				Hooks map[string]any `json:"hooks"`
			}
			if json.Unmarshal(data, &hooksConfig) == nil && hooksConfig.Hooks != nil {
				parseHooksConfig(hooksConfig.Hooks, "project hooks.json")
				result["project_hooks"] = projectHooksPath
			}
		}
	}

	// 2. Check user-level settings.json (legacy/fallback).
	settingsPath := filepath.Join(claudeHome, "settings.json")
	if data, err := os.ReadFile(settingsPath); err == nil {
		var settings map[string]any
		if json.Unmarshal(data, &settings) == nil {
			if hooks, ok := settings["hooks"].(map[string]any); ok {
				parseHooksConfig(hooks, "user settings.json")
			}
		}
	}

	result["count"] = len(allEvents)
	events := make([]string, 0, len(allEvents))
	for event := range allEvents {
		events = append(events, event)
	}
	result["events"] = events

	// Check missing recommended events.
	var missing []string
	for _, ev := range recommendedEvents {
		if !allEvents[ev] {
			missing = append(missing, ev)
		}
	}
	if len(missing) > 0 {
		result["missing_recommended"] = missing
	}

	if len(issues) > 0 {
		result["hook_issues"] = issues
	}

	return result
}

// ---------------------------------------------------------------------------
// Agent analysis (deep inspection of .claude/agents/*.md)
// ---------------------------------------------------------------------------

// agentInfo describes a parsed agent file.
type agentInfo struct {
	Name             string `json:"name"`
	HasDesc          bool   `json:"has_description"`
	HasModel         bool   `json:"has_model"`
	Model            string `json:"model,omitempty"`
	HasTools         bool   `json:"has_tools"`
	PermissionBypass bool   `json:"permission_bypass,omitempty"`
	BodyLines        int    `json:"body_lines"`
	SizeWarning      string `json:"size_warning,omitempty"`
	Source           string `json:"source"` // "project" or "user"
}

func reviewAgents(projectPath, claudeHome string) map[string]any {
	result := map[string]any{"count": 0}

	var agents []agentInfo
	var names []string
	var invalid []string

	scanDir := func(dir, source string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			content := string(data)
			fm := parseSKILLFrontmatter(content)
			bodyLines := countBodyLines(content)

			name := strings.TrimSuffix(e.Name(), ".md")
			names = append(names, name)

			ai := agentInfo{
				Name:      name,
				HasDesc:   fm["description"] != "",
				HasModel:  fm["model"] != "",
				Model:     fm["model"],
				HasTools:  fm["tools"] != "",
				BodyLines: bodyLines,
				Source:    source,
			}

			if fm["permissionMode"] == "bypassPermissions" {
				ai.PermissionBypass = true
			}

			if bodyLines > 200 {
				ai.SizeWarning = fmt.Sprintf("agent body is %d lines (consider splitting into sub-agents)", bodyLines)
			} else if bodyLines < 5 && bodyLines > 0 {
				ai.SizeWarning = fmt.Sprintf("agent body is only %d lines (may be too brief for effective delegation)", bodyLines)
			}

			if !ai.HasDesc {
				invalid = append(invalid, name)
			}

			agents = append(agents, ai)
		}
	}

	if projectPath != "" {
		scanDir(filepath.Join(projectPath, ".claude", "agents"), "project")
	}
	if claudeHome != "" {
		scanDir(filepath.Join(claudeHome, "agents"), "user")
	}

	result["count"] = len(agents)
	if len(names) > 0 {
		result["items"] = names
	}
	if len(agents) > 0 {
		result["agent_details"] = agents
	}
	if len(invalid) > 0 {
		result["invalid_agents"] = invalid
	}
	return result
}

// ---------------------------------------------------------------------------
// Permissions analysis (.claude/settings.json + .claude/settings.local.json)
// ---------------------------------------------------------------------------

// fullSettings is the complete settings structure for conflict detection.
// Parsed once in reviewPermissions and passed to detectSettingsConflicts.
type fullSettings struct {
	Permissions struct {
		Allow []string `json:"allow,omitempty"`
		Deny  []string `json:"deny,omitempty"`
	} `json:"permissions"`
	DisableAllHooks       bool           `json:"disableAllHooks"`
	AllowManagedHooksOnly bool           `json:"allowManagedHooksOnly"`
	Hooks                 map[string]any `json:"hooks"`
}

// settingsSource pairs a parsed settings file with its origin label.
type settingsSource struct {
	name string
	s    *fullSettings
}

func reviewPermissions(claudeHome, projectPath string) map[string]any {
	result := map[string]any{"configured": false}

	readFull := func(path string) *fullSettings {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var s fullSettings
		if json.Unmarshal(data, &s) != nil {
			return nil
		}
		return &s
	}

	// Parse all settings files once.
	var allSources []settingsSource
	var sourceNames []string

	if projectPath != "" {
		if s := readFull(filepath.Join(projectPath, ".claude", "settings.json")); s != nil {
			allSources = append(allSources, settingsSource{"project", s})
			p := s.Permissions
			if len(p.Allow) > 0 || len(p.Deny) > 0 {
				result["configured"] = true
				result["project_allow"] = p.Allow
				result["project_deny"] = p.Deny
				sourceNames = append(sourceNames, "project")
			}
		}
		if s := readFull(filepath.Join(projectPath, ".claude", "settings.local.json")); s != nil {
			allSources = append(allSources, settingsSource{"local", s})
			p := s.Permissions
			if len(p.Allow) > 0 || len(p.Deny) > 0 {
				result["configured"] = true
				result["local_allow"] = p.Allow
				result["local_deny"] = p.Deny
				sourceNames = append(sourceNames, "local")
			}
		}
	}
	if claudeHome != "" {
		if s := readFull(filepath.Join(claudeHome, "settings.json")); s != nil {
			allSources = append(allSources, settingsSource{"user", s})
			p := s.Permissions
			if len(p.Allow) > 0 || len(p.Deny) > 0 {
				result["user_allow"] = p.Allow
				result["user_deny"] = p.Deny
				sourceNames = append(sourceNames, "user")
			}
		}
	}

	if len(sourceNames) > 0 {
		result["sources"] = sourceNames
	}

	// Detect conflicts using already-parsed data (no re-read).
	result["conflicts"] = detectSettingsConflicts(allSources, projectPath)

	return result
}

// settingsConflict describes a contradiction between settings entries.
type settingsConflict struct {
	Pattern  string `json:"pattern"`
	Type     string `json:"type"`     // "intra_file", "cross_file", or "feature_flag"
	Severity string `json:"severity"` // "warning" or "info"
	Detail   string `json:"detail"`
}

// detectSettingsConflicts finds contradictions within and across settings files.
// Takes already-parsed settings to avoid double file reads.
func detectSettingsConflicts(sources []settingsSource, projectPath string) []settingsConflict {
	var conflicts []settingsConflict

	// 1. Intra-file allow+deny exact match.
	for _, src := range sources {
		deny := make(map[string]bool, len(src.s.Permissions.Deny))
		for _, d := range src.s.Permissions.Deny {
			deny[d] = true
		}
		for _, a := range src.s.Permissions.Allow {
			if deny[a] {
				conflicts = append(conflicts, settingsConflict{
					Pattern:  a,
					Type:     "intra_file",
					Severity: "warning",
					Detail:   fmt.Sprintf("%q in both allow and deny in %s settings (deny takes precedence)", a, src.name),
				})
			}
		}
	}

	// 2. Cross-file allow vs deny exact match.
	type permEntry struct {
		list   string // "allow" or "deny"
		source string
	}
	allEntries := make(map[string][]permEntry)
	for _, src := range sources {
		for _, a := range src.s.Permissions.Allow {
			allEntries[a] = append(allEntries[a], permEntry{"allow", src.name})
		}
		for _, d := range src.s.Permissions.Deny {
			allEntries[d] = append(allEntries[d], permEntry{"deny", src.name})
		}
	}
	for pattern, entries := range allEntries {
		var allowSrc, denySrc string
		for _, e := range entries {
			if e.list == "allow" {
				allowSrc = e.source
			}
			if e.list == "deny" {
				denySrc = e.source
			}
		}
		if allowSrc != "" && denySrc != "" && allowSrc != denySrc {
			conflicts = append(conflicts, settingsConflict{
				Pattern:  pattern,
				Type:     "cross_file",
				Severity: "info",
				Detail:   fmt.Sprintf("%q allowed in %s but denied in %s (local overrides may be intentional)", pattern, allowSrc, denySrc),
			})
		}
	}

	// 3. Feature flag conflicts.
	for _, src := range sources {
		if src.s.DisableAllHooks && len(src.s.Hooks) > 0 {
			conflicts = append(conflicts, settingsConflict{
				Type:     "feature_flag",
				Severity: "warning",
				Detail:   fmt.Sprintf("disableAllHooks=true in %s settings but hooks are configured in the same file", src.name),
			})
		}
	}
	// AllowManagedHooksOnly: check if project-level hooks exist.
	for _, src := range sources {
		if src.s.AllowManagedHooksOnly {
			if projectPath != "" {
				if _, err := os.Stat(filepath.Join(projectPath, ".claude", "hooks.json")); err == nil {
					conflicts = append(conflicts, settingsConflict{
						Type:     "feature_flag",
						Severity: "warning",
						Detail:   fmt.Sprintf("allowManagedHooksOnly=true in %s settings but .claude/hooks.json exists (project hooks will be ignored)", src.name),
					})
				}
			}
			break
		}
	}

	return conflicts
}

// ---------------------------------------------------------------------------
// MCP server analysis
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Structured suggestions with KB cross-reference
// ---------------------------------------------------------------------------

// kbQueries maps suggestion categories to FTS5 queries for best practices.
var kbQueries = map[string]string{
	"claude_md":   "CLAUDE.md best practices project instructions sections",
	"skills":      "skills SKILL.md frontmatter allowed-tools support files",
	"rules":       "rules coding standards configuration best practices",
	"hooks":       "hooks lifecycle events configuration automation",
	"agents":      "sub-agents model description tools delegation configuration",
	"permissions": "permissions settings allow deny tool access control",
}

func generateReviewSuggestions(ctx context.Context, report map[string]any, st *store.Store) []Suggestion {
	var suggestions []Suggestion

	// CLAUDE.md checks.
	claudeMD, _ := report["claude_md"].(map[string]any)
	if exists, _ := claudeMD["exists"].(bool); !exists {
		suggestions = append(suggestions, Suggestion{
			Severity: "warning",
			Category: "claude_md",
			Message:  "Create a CLAUDE.md file to give Claude Code project-specific instructions",
		})
	} else {
		if w, _ := claudeMD["size_warning"].(string); w != "" {
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "claude_md",
				Message:  "CLAUDE.md is " + w,
			})
		}
		if keySections, ok := claudeMD["key_sections"].(map[string]bool); ok {
			if !keySections["commands"] {
				suggestions = append(suggestions, Suggestion{
					Severity: "warning",
					Category: "claude_md",
					Message:  "CLAUDE.md: Add a ## Commands section listing common build/test commands",
				})
			}
		}
	}

	// Skills checks.
	skills, _ := report["skills"].(map[string]any)
	if count, _ := skills["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "skills",
			Message:  "Consider adding custom skills (.claude/skills/) if you have repetitive workflows to automate",
		})
	} else {
		if invalid, ok := skills["invalid_skills"].([]string); ok && len(invalid) > 0 {
			suggestions = append(suggestions, Suggestion{
				Severity: "warning",
				Category: "skills",
				Message:  "Skills missing name or description in frontmatter: " + strings.Join(invalid, ", "),
				Affected: invalid,
			})
		}
		// Deep skill checks.
		if details, ok := skills["skill_details"].([]skillInfo); ok {
			for _, si := range details {
				if si.SizeWarning != "" {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "skills",
						Message:  "Skill '" + si.Name + "': " + si.SizeWarning,
						Affected: []string{".claude/skills/" + si.Name + "/SKILL.md"},
					})
				}
			}
		}
	}

	// Rules checks.
	rules, _ := report["rules"].(map[string]any)
	if count, _ := rules["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "rules",
			Message:  "Consider adding rules (.claude/rules/) if you have coding standards to enforce automatically",
		})
	} else {
		if details, ok := rules["rule_details"].([]ruleInfo); ok {
			for _, ri := range details {
				if ri.SizeWarning != "" {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "rules",
						Message:  "Rule '" + ri.Name + "': " + ri.SizeWarning,
						Affected: []string{".claude/rules/" + ri.Name},
					})
				}
			}
		}
	}

	// Agent checks.
	agents, _ := report["agents"].(map[string]any)
	if count, _ := agents["count"].(int); count > 0 {
		if invalid, ok := agents["invalid_agents"].([]string); ok && len(invalid) > 0 {
			suggestions = append(suggestions, Suggestion{
				Severity: "warning",
				Category: "agents",
				Message:  "Agents missing description (won't be auto-selected): " + strings.Join(invalid, ", "),
				Affected: invalid,
			})
		}
		if details, ok := agents["agent_details"].([]agentInfo); ok {
			for _, a := range details {
				if a.PermissionBypass {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "agents",
						Message:  fmt.Sprintf("Agent '%s' uses bypassPermissions — skips all permission checks", a.Name),
						Affected: []string{".claude/agents/" + a.Name + ".md"},
					})
				}
				if a.SizeWarning != "" {
					suggestions = append(suggestions, Suggestion{
						Severity: "info",
						Category: "agents",
						Message:  fmt.Sprintf("Agent '%s': %s", a.Name, a.SizeWarning),
						Affected: []string{".claude/agents/" + a.Name + ".md"},
					})
				}
			}
		}
	}

	// Hooks checks.
	hooks, _ := report["hooks"].(map[string]any)
	if count, _ := hooks["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "hooks",
			Message:  "Configure hooks for automated checks (tests, linting) on tool use",
		})
	} else {
		if missing, ok := hooks["missing_recommended"].([]string); ok && len(missing) > 0 {
			suggestions = append(suggestions, Suggestion{
				Severity: "warning",
				Category: "hooks",
				Message:  "Missing recommended alfred hook events: " + strings.Join(missing, ", "),
			})
		}
		// Hook content validation issues.
		if issues, ok := hooks["hook_issues"].([]hookIssue); ok {
			for _, issue := range issues {
				suggestions = append(suggestions, Suggestion{
					Severity: issue.Severity,
					Category: "hooks",
					Message:  issue.Message,
				})
			}
		}
	}

	// Permissions checks.
	perms, _ := report["permissions"].(map[string]any)
	if configured, _ := perms["configured"].(bool); !configured {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "permissions",
			Message:  "Consider configuring .claude/settings.json with permissions (allow/deny lists) for tool access control",
		})
	} else {
		// Check for overly permissive settings.
		if allow, ok := perms["project_allow"].([]string); ok {
			for _, a := range allow {
				if a == "*" || a == "Bash(*)" {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "permissions",
						Message:  "Overly permissive allow rule: " + a + " — consider narrowing scope",
						Affected: []string{".claude/settings.json"},
					})
				}
			}
		}
	}

	// Settings conflict checks.
	if conflicts, ok := perms["conflicts"].([]settingsConflict); ok {
		for _, c := range conflicts {
			suggestions = append(suggestions, Suggestion{
				Severity: c.Severity,
				Category: "permissions",
				Message:  "Settings conflict: " + c.Detail,
			})
		}
	}

	// Enrich suggestions with KB best practices.
	enrichWithKB(ctx, suggestions, st)

	return suggestions
}

// enrichWithKB attaches best practice snippets from the knowledge base to suggestions.
func enrichWithKB(ctx context.Context, suggestions []Suggestion, st *store.Store) {
	if st == nil || len(suggestions) == 0 {
		return
	}

	// Query KB once per category that has suggestions.
	categories := map[string]bool{}
	for _, s := range suggestions {
		categories[s.Category] = true
	}

	cache := map[string]*KBSnippet{}
	for cat := range categories {
		q, ok := kbQueries[cat]
		if !ok {
			continue
		}
		if snippets := queryKB(ctx, st, q, 1); len(snippets) > 0 {
			cache[cat] = &snippets[0]
		}
	}

	// Attach cached snippets to suggestions.
	for i := range suggestions {
		if bp, ok := cache[suggestions[i].Category]; ok {
			suggestions[i].BestPractice = bp
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// computeMaturityScore derives a 0-100 score per category and overall from the review report.
func computeMaturityScore(report map[string]any, suggestions []Suggestion) map[string]any {
	scores := map[string]int{
		"claude_md":   0,
		"skills":      0,
		"rules":       0,
		"hooks":       0,
		"agents":      0,
		"mcp":         0,
		"permissions": 0,
	}

	// CLAUDE.md: exists=40, no size warning=20, has commands section=20, sections>2=20
	if cm, ok := report["claude_md"].(map[string]any); ok {
		if exists, _ := cm["exists"].(bool); exists {
			scores["claude_md"] += 40
			if _, hasWarning := cm["size_warning"]; !hasWarning {
				scores["claude_md"] += 20
			}
			if ks, ok := cm["key_sections"].(map[string]bool); ok && ks["commands"] {
				scores["claude_md"] += 20
			}
			if sc, _ := cm["section_count"].(int); sc > 2 {
				scores["claude_md"] += 20
			}
		}
	}

	// Skills: absent=N/A (50 baseline), count>0=40, all valid frontmatter=30, no size warnings=30
	if sk, ok := report["skills"].(map[string]any); ok {
		if count, _ := sk["count"].(int); count > 0 {
			scores["skills"] += 40
			if _, hasInvalid := sk["invalid_skills"]; !hasInvalid {
				scores["skills"] += 30
			}
			hasWarning := false
			if details, ok := sk["skill_details"].([]skillInfo); ok {
				for _, si := range details {
					if si.SizeWarning != "" {
						hasWarning = true
						break
					}
				}
			}
			if !hasWarning {
				scores["skills"] += 30
			}
		} else {
			// No skills is not inherently bad — baseline score.
			scores["skills"] = 50
		}
	}

	// Rules: absent=N/A (50 baseline), count>0=50, no size warnings=50
	if ru, ok := report["rules"].(map[string]any); ok {
		if count, _ := ru["count"].(int); count > 0 {
			scores["rules"] += 50
			hasWarning := false
			if details, ok := ru["rule_details"].([]ruleInfo); ok {
				for _, ri := range details {
					if ri.SizeWarning != "" {
						hasWarning = true
						break
					}
				}
			}
			if !hasWarning {
				scores["rules"] += 50
			}
		} else {
			// No rules is not inherently bad — baseline score.
			scores["rules"] = 50
		}
	}

	// Agents: absent=50 baseline, count>0=50, all have desc=25, no bypass=25
	if ag, ok := report["agents"].(map[string]any); ok {
		if count, _ := ag["count"].(int); count > 0 {
			scores["agents"] += 50
			if _, hasInvalid := ag["invalid_agents"]; !hasInvalid {
				scores["agents"] += 25
			}
			hasBypass := false
			if details, ok := ag["agent_details"].([]agentInfo); ok {
				for _, a := range details {
					if a.PermissionBypass {
						hasBypass = true
						break
					}
				}
			}
			if !hasBypass {
				scores["agents"] += 25
			}
		} else {
			scores["agents"] = 50 // baseline
		}
	}

	// Hooks: count>0=60, no missing recommended=40
	if hk, ok := report["hooks"].(map[string]any); ok {
		if count, _ := hk["count"].(int); count > 0 {
			scores["hooks"] += 60
			if _, hasMissing := hk["missing_recommended"]; !hasMissing {
				scores["hooks"] += 40
			}
		}
	}

	// MCP: count>0=100
	if mc, ok := report["mcp_servers"].(map[string]any); ok {
		if count, _ := mc["count"].(int); count > 0 {
			scores["mcp"] = 100
		}
	}

	// Permissions: configured=60, no overly permissive=40; absent=50 baseline
	if pm, ok := report["permissions"].(map[string]any); ok {
		if configured, _ := pm["configured"].(bool); configured {
			scores["permissions"] = 60
			// Gets to 100 if no warnings deducted below.
			hasPermWarning := false
			for _, s := range suggestions {
				if s.Category == "permissions" && s.Severity == "warning" {
					hasPermWarning = true
					break
				}
			}
			if !hasPermWarning {
				scores["permissions"] += 40
			}
		} else {
			scores["permissions"] = 50 // baseline
		}
	}

	// Deduct for warnings.
	for _, s := range suggestions {
		if s.Severity == "warning" {
			scores[s.Category] = max(scores[s.Category]-10, 0)
		}
	}

	total := 0
	for _, v := range scores {
		total += v
	}
	overall := total / len(scores)

	return map[string]any{
		"overall":  overall,
		"scores":   scores,
		"warnings": countSeverity(suggestions, "warning"),
		"info":     countSeverity(suggestions, "info"),
	}
}

func countSeverity(suggestions []Suggestion, severity string) int {
	n := 0
	for _, s := range suggestions {
		if s.Severity == severity {
			n++
		}
	}
	return n
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
