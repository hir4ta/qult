package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Uninstall removes all alfred components: hooks, MCP, skills, agent, rules,
// database, and the binary itself.
func Uninstall() error {
	fmt.Println("Uninstalling alfred...")

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("could not determine home directory: %w", err)
	}

	// 1. Remove hooks from settings.json.
	if err := RemoveHooks(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: hook removal: %v\n", err)
	} else {
		fmt.Println("✓ Hooks removed")
	}

	// 2. Remove MCP server registration.
	for _, name := range []string{"alfred", "claude-alfred"} {
		cmd := exec.Command("claude", "mcp", "remove", "-s", "user", name)
		_ = cmd.Run()
	}
	fmt.Println("✓ MCP server removed")

	// 3. Remove skills.
	removeSkills()
	fmt.Println("✓ Skills removed")

	// 4. Remove agent.
	_ = os.Remove(filepath.Join(home, ".claude", "agents", "alfred.md"))
	fmt.Println("✓ Agent removed")

	// 5. Remove rules.
	_ = os.Remove(filepath.Join(home, ".claude", "rules", "alfred.md"))
	fmt.Println("✓ Rules removed")

	// 6. Remove database.
	dbDir := filepath.Join(home, ".claude-alfred")
	if _, err := os.Stat(dbDir); err == nil {
		_ = os.RemoveAll(dbDir)
		fmt.Println("✓ Database removed (~/.claude-alfred/)")
	}

	// 7. Remove binary from PATH.
	binPath := filepath.Join(home, ".local", "bin", "alfred")
	if _, err := os.Stat(binPath); err == nil {
		_ = os.Remove(binPath)
		fmt.Println("✓ Binary removed (~/.local/bin/alfred)")
	}

	fmt.Println("\n✓ Uninstall complete")
	return nil
}
