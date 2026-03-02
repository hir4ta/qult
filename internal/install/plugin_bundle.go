package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runCmd is the shell command that invokes the wrapper script.
// ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code at plugin install time.
const runCmd = `"${CLAUDE_PLUGIN_ROOT}/bin/run.sh"`

// alfredHookEntries returns the hook configuration for plugin distribution.
// Only SessionStart is registered.
func alfredHookEntries(binPath string) map[string]any {
	return map[string]any{
		"SessionStart": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": binPath + " hook SessionStart",
						"timeout": 5,
					},
				},
			},
		},
	}
}

// Bundle generates the plugin directory structure from Go source definitions.
// The outputDir will contain .claude-plugin/, hooks/, bin/, skills/, agents/, rules/, and .mcp.json.
func Bundle(outputDir, version string) error {
	// 0. Clean up deprecated skill directories.
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(outputDir, "skills", dir))
	}

	// 1. Create directory structure.
	dirs := []string{
		filepath.Join(outputDir, ".claude-plugin"),
		filepath.Join(outputDir, "hooks"),
		filepath.Join(outputDir, "bin"),
		filepath.Join(outputDir, "agents"),
		filepath.Join(outputDir, "rules"),
	}
	for _, skill := range alfredSkills {
		dirs = append(dirs, filepath.Join(outputDir, "skills", skill.Dir))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}

	// 2. Write plugin.json.
	pluginJSON := map[string]any{
		"name":        "alfred",
		"version":     version,
		"description": "Your silent butler for Claude Code",
		"author":      map[string]string{"name": "hir4ta"},
		"homepage":    "https://github.com/hir4ta/claude-alfred",
		"repository":  "https://github.com/hir4ta/claude-alfred",
		"license":     "MIT",
		"keywords":    []string{"butler", "best-practices", "workflow"},
	}
	if err := writeJSON(filepath.Join(outputDir, ".claude-plugin", "plugin.json"), pluginJSON); err != nil {
		return fmt.Errorf("write plugin.json: %w", err)
	}

	// 3. Write hooks.json — commands invoke the guard/setup wrapper.
	hooksJSON := map[string]any{
		"description": "Silent butler hooks — CLAUDE.md auto-ingest on session start",
		"hooks":       alfredHookEntries(runCmd),
	}
	if err := writeJSON(filepath.Join(outputDir, "hooks", "hooks.json"), hooksJSON); err != nil {
		return fmt.Errorf("write hooks.json: %w", err)
	}

	// 4. Write .mcp.json — MCP server also uses the wrapper.
	mcpJSON := map[string]any{
		"mcpServers": map[string]any{
			"alfred": map[string]any{
				"command": "${CLAUDE_PLUGIN_ROOT}/bin/run.sh",
				"args":    []string{"serve"},
			},
		},
	}
	if err := writeJSON(filepath.Join(outputDir, ".mcp.json"), mcpJSON); err != nil {
		return fmt.Errorf("write .mcp.json: %w", err)
	}

	// 5. Write bin/run.sh — guard + setup wrapper.
	runScript := generateRunScript(version)
	runPath := filepath.Join(outputDir, "bin", "run.sh")
	if err := os.WriteFile(runPath, []byte(runScript), 0o755); err != nil {
		return fmt.Errorf("write run.sh: %w", err)
	}

	// 6. Write skills.
	for _, skill := range alfredSkills {
		p := filepath.Join(outputDir, "skills", skill.Dir, "SKILL.md")
		if err := os.WriteFile(p, []byte(skill.Content), 0o644); err != nil {
			return fmt.Errorf("write skill %s: %w", skill.Dir, err)
		}
	}

	// 7. Write agent.
	agentPath := filepath.Join(outputDir, "agents", "alfred.md")
	if err := os.WriteFile(agentPath, []byte(alfredAgentContent), 0o644); err != nil {
		return fmt.Errorf("write alfred agent: %w", err)
	}

	// 8. Write rules.
	for _, rule := range alfredRules {
		p := filepath.Join(outputDir, "rules", rule.File)
		if err := os.WriteFile(p, []byte(rule.Content), 0o644); err != nil {
			return fmt.Errorf("write rule %s: %w", rule.File, err)
		}
	}

	hookCount := len(alfredHookEntries(runCmd))

	fmt.Printf("✓ Plugin bundle generated at %s\n", outputDir)
	fmt.Printf("  - plugin.json (v%s)\n", version)
	fmt.Printf("  - hooks.json (%d events)\n", hookCount)
	fmt.Printf("  - .mcp.json\n")
	fmt.Printf("  - bin/run.sh (delegator)\n")
	fmt.Printf("  - %d skills\n", len(alfredSkills))
	fmt.Printf("  - %d rules\n", len(alfredRules))
	fmt.Printf("  - 1 agent (alfred)\n")
	return nil
}

// generateRunScript creates a simple delegator script.
// Requires claude-alfred to be installed via `go install`.
func generateRunScript(_ string) string {
	return `#!/bin/sh
# alfred wrapper — delegates to go-installed binary.
exec claude-alfred "$@"
`
}

func writeJSON(path string, data any) error {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}
