package install

import (
	"embed"
	"io/fs"
	"path"
)

//go:embed content/skills/*/SKILL.md
var skillsFS embed.FS

type skillDef struct {
	Dir     string // directory name under skills/
	Content string // SKILL.md content
}

// loadSkills reads all skill definitions from the embedded filesystem.
func loadSkills() []skillDef {
	var skills []skillDef
	entries, err := fs.ReadDir(skillsFS, "content/skills")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := fs.ReadFile(skillsFS, path.Join("content/skills", e.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		skills = append(skills, skillDef{Dir: e.Name(), Content: string(data)})
	}
	return skills
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	// v0.1-v0.19 era
	"init",
	"alfred-unstuck",
	"alfred-checkpoint",
	"alfred-before-commit",
	"alfred-impact",
	"alfred-review",
	"alfred-estimate",
	"alfred-error-recovery",
	"alfred-test-guidance",
	"alfred-predict",
	// v0.20-v0.22 era
	"alfred-recover",
	"alfred-gate",
	"alfred-analyze",
	"alfred-forecast",
	"alfred-context-recovery",
	"alfred-crawl",
	// v0.23 era (alfred- prefix removed in v0.24)
	"alfred-create-skill",
	"alfred-create-rule",
	"alfred-create-hook",
	"alfred-create-agent",
	"alfred-create-mcp",
	"alfred-create-claude-md",
	"alfred-create-memory",
	"alfred-review",
	"alfred-audit",
	"alfred-learn",
	"alfred-preferences",
	"alfred-update-docs",
	"alfred-update",
	"alfred-setup",
	"alfred-migrate",
	"alfred-explain",
	// v0.24-v0.26 era (renamed to butler-style in v0.27)
	"create-skill",
	"create-rule",
	"create-hook",
	"create-agent",
	"create-mcp",
	"create-claude-md",
	"create-memory",
	"review",
	"audit",
	"learn",
	"preferences",
	"update-docs",
	"update",
	"setup",
	"migrate",
	"explain",
	// v0.27-v0.28 era (consolidated into configure/setup)
	"inspect",
	"harvest",
	"prepare",
	"polish",
	"greetings",
	"brief",
	"memorize",
}
