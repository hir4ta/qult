package main

import (
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/hir4ta/claude-alfred/internal/tui"
)

func runDashboard() error {
	projectPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	// Open store for memory access (optional — dashboard works without it).
	var st *store.Store
	if s, err := store.OpenDefault(); err == nil {
		st = s
		defer st.Close()
	}

	ds := tui.NewFileDataSource(projectPath, st)
	model := tui.New(ds)

	p := tea.NewProgram(model)
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	return nil
}
