package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Uninstall removes claude-buddy hooks and MCP registration.
func Uninstall() error {
	// Step 1: Remove hooks from settings.json.
	if err := RemoveHooks(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: hook removal failed: %v\n", err)
	} else {
		fmt.Println("✓ Hooks removed from ~/.claude/settings.json")
	}

	// Step 2: Remove MCP server registration.
	cmd := exec.Command("claude", "mcp", "remove", "-s", "user", "claude-buddy")
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("Warning: MCP removal: %v (%s)\n", err, strings.TrimSpace(string(output)))
	} else {
		fmt.Println("✓ MCP server removed")
	}

	// Step 3: Remove buddy skills.
	removeSkills()
	fmt.Println("✓ Skills removed")

	// Step 4: Remove buddy agent.
	if home, err := os.UserHomeDir(); err == nil {
		agentPath := filepath.Join(home, ".claude", "agents", "buddy.md")
		if _, err := os.Stat(agentPath); err == nil {
			_ = os.Remove(agentPath)
			fmt.Println("✓ Buddy agent removed")
		}
	}

	// Step 5: Clean up legacy plugin bundle.
	home, err := os.UserHomeDir()
	if err == nil {
		pluginDir := filepath.Join(home, ".claude-buddy", "plugin")
		if _, err := os.Stat(pluginDir); err == nil {
			if err := os.RemoveAll(pluginDir); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", pluginDir, err)
			} else {
				fmt.Printf("✓ Removed legacy plugin bundle: %s\n", pluginDir)
			}
		}
	}

	fmt.Println("\n✓ Uninstall complete")
	return nil
}
