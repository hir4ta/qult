package install

import (
	"embed"
	"io/fs"
)

//go:embed content/rules/*.md
var rulesFS embed.FS

type ruleDef struct {
	File    string // filename under rules/
	Content string // markdown content
}

// loadRules reads all rule definitions from the embedded filesystem.
func loadRules() []ruleDef {
	var rules []ruleDef
	entries, err := fs.ReadDir(rulesFS, "content/rules")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := fs.ReadFile(rulesFS, "content/rules/"+e.Name())
		if err != nil {
			continue
		}
		rules = append(rules, ruleDef{File: e.Name(), Content: string(data)})
	}
	return rules
}

// deprecatedRuleFiles lists rule files from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedRuleFiles = []string{
	"butler-protocol.md",
	// v0.43 era: moved to skill supporting files
	"agents.md",
	"claude-md.md",
	"hooks.md",
	"memory.md",
	"mcp-config.md",
	"rules.md",
	"skills.md",
}
