package main

import (
	"fmt"
	"os"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/hir4ta/claude-alfred/internal/tui"
)

func runDashboard() error {
	projectPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	var st *store.Store
	if s, err := store.OpenDefault(); err == nil {
		st = s
		defer st.Close()
	}

	emb, _ := embedder.NewEmbedder()

	ds := tui.NewFileDataSource(projectPath, st, emb)
	model := tui.New(ds)

	// Filter out leaked terminal responses (DECRPM, CPR, DA) that bubbletea v2
	// fails to parse. These arrive as KeyPressMsg with digit characters and cause
	// phantom tab switches and search activation.
	startedAt := time.Now()
	filter := func(_ tea.Model, msg tea.Msg) tea.Msg {
		if kp, ok := msg.(tea.KeyPressMsg); ok {
			// Drop all key events during the first 2 seconds (terminal negotiation).
			if time.Since(startedAt) < 2*time.Second {
				return nil
			}
			// Drop single-char key presses that look like terminal response fragments:
			// digits 0,4-9 (not 1-3 which are tab shortcuts), $, y, R, c, ?, ;, [
			if kp.Text != "" && len(kp.Text) == 1 {
				ch := kp.Text[0]
				switch {
				case ch == '$' || ch == 'y' || ch == 'R' || ch == 'c' || ch == '?' || ch == ';' || ch == '[':
					return nil
				case ch >= '4' && ch <= '9':
					return nil
				case ch == '0':
					return nil
				}
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
