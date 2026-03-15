package main

import (
	"fmt"
	"os"

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

	// Filter leaked terminal response fragments (DECRPM, CPR, DA) that
	// bubbletea v2 fails to parse and delivers as KeyPressMsg.
	filter := func(_ tea.Model, msg tea.Msg) tea.Msg {
		if kp, ok := msg.(tea.KeyPressMsg); ok && kp.Text != "" && len(kp.Text) == 1 {
			switch kp.Text[0] {
			case '$', 'y', 'R', 'c', '?', ';', '[':
				return nil
			}
		}
		return msg
	}

	p := tea.NewProgram(model, tea.WithFilter(filter))
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	return nil
}
