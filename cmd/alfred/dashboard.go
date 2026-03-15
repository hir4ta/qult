package main

import (
	"fmt"
	"os"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/hir4ta/claude-alfred/internal/tui"
)

func runDashboard() error {
	projectPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	ds := tui.NewFileDataSource(projectPath, nil, nil)
	model := tui.New(ds)

	// Workaround for bubbletea v2 bug #1627: DECRPM terminal responses leak
	// as phantom KeyPressMsg events. Two mitigations:
	//
	// 1. Set TERM_PROGRAM=Apple_Terminal to prevent bubbletea from sending
	//    DECRQM queries (mode 2026/2027) that trigger the responses.
	if os.Getenv("TERM_PROGRAM") == "" {
		os.Setenv("TERM_PROGRAM", "Apple_Terminal")
	}

	// 2. Block all key events for 2 seconds as a safety net for any
	//    terminal responses still in flight.
	startedAt := time.Now()
	filter := func(_ tea.Model, msg tea.Msg) tea.Msg {
		if _, ok := msg.(tea.KeyPressMsg); ok && time.Since(startedAt) < 2*time.Second {
			return nil
		}
		return msg
	}

	p := tea.NewProgram(model, tea.WithFilter(filter))
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	return nil
}
