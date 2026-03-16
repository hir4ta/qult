package main

import (
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"github.com/hir4ta/claude-alfred/internal/tui"
)

func runDashboard() error {
	projectPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	ds := tui.NewFileDataSource(projectPath, nil, nil)
	model := tui.New(ds, resolvedVersion())

	p := tea.NewProgram(model, tea.WithColorProfile(colorprofile.TrueColor))
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	return nil
}
