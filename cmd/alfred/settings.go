package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/textinput"
	"charm.land/lipgloss/v2"
)

// settingsPhase tracks the current settings menu state.
type settingsPhase int

const (
	settingsMenu settingsPhase = iota
	settingsEditKey
	settingsSaved
)

// settingsItem represents a menu entry.
type settingsItem struct {
	label string
	key   string
	value string
}

type settingsModel struct {
	phase    settingsPhase
	items    []settingsItem
	cursor   int
	input    textinput.Model
	editKey  string
	saved    bool
	err      error
	quitting bool
}

func newSettingsModel() settingsModel {
	ti := textinput.New()
	ti.Placeholder = "Enter value..."
	ti.SetWidth(50)
	ti.CharLimit = 256

	voyageKey := os.Getenv("VOYAGE_API_KEY")
	maskedKey := maskAPIKey(voyageKey)

	items := []settingsItem{
		{label: "Voyage API Key", key: "VOYAGE_API_KEY", value: maskedKey},
	}

	return settingsModel{
		phase: settingsMenu,
		items: items,
		input: ti,
	}
}

func (m settingsModel) Init() tea.Cmd {
	return nil
}

func (m settingsModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		key := msg.String()

		switch m.phase {
		case settingsMenu:
			switch key {
			case "ctrl+c", "q", "esc":
				m.quitting = true
				return m, tea.Quit
			case "up", "k":
				if m.cursor > 0 {
					m.cursor--
				}
			case "down", "j":
				if m.cursor < len(m.items)-1 {
					m.cursor++
				}
			case "enter":
				m.phase = settingsEditKey
				m.editKey = m.items[m.cursor].key
				m.input.SetValue("")
				if m.editKey == "VOYAGE_API_KEY" {
					m.input.EchoMode = textinput.EchoPassword
					m.input.Placeholder = "sk-voyage-..."
				} else {
					m.input.EchoMode = textinput.EchoNormal
				}
				m.input.Focus()
				return m, m.input.Focus()
			}

		case settingsEditKey:
			switch key {
			case "ctrl+c", "esc":
				m.phase = settingsMenu
				return m, nil
			case "enter":
				val := m.input.Value()
				if val == "" {
					m.phase = settingsMenu
					return m, nil
				}
				if err := saveEnvToProfile(m.editKey, val); err != nil {
					m.err = err
					m.phase = settingsMenu
					return m, nil
				}
				os.Setenv(m.editKey, val)
				m.items[m.cursor].value = maskAPIKey(val)
				m.phase = settingsSaved
				return m, tea.Quit
			}
		}
	}

	if m.phase == settingsEditKey {
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m settingsModel) View() tea.View {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	labelStyle := lipgloss.NewStyle().Width(22)
	valStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))
	selectedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#7571F9")).Bold(true)
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	errStyleLocal := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	hintStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))

	var b strings.Builder

	b.WriteString("\n  " + headerStyle.Render("⚙  alfred settings") + "\n\n")

	switch m.phase {
	case settingsMenu:
		for i, item := range m.items {
			cursor := "  "
			label := labelStyle.Render(item.label)
			val := valStyle.Render(item.value)
			if item.value == "(not set)" {
				val = errStyleLocal.Render(item.value)
			}
			if i == m.cursor {
				cursor = selectedStyle.Render("▸ ")
				label = selectedStyle.Render(fmt.Sprintf("%-22s", item.label))
			}
			b.WriteString("  " + cursor + label + " " + val + "\n")
		}
		b.WriteString("\n")
		if m.err != nil {
			b.WriteString("  " + errStyleLocal.Render("✗ Error: "+m.err.Error()) + "\n\n")
		}
		b.WriteString("  " + hintStyle.Render("↑↓ navigate · enter edit · q quit") + "\n\n")

	case settingsEditKey:
		b.WriteString("  " + labelStyle.Render(m.editKey) + "\n\n")
		b.WriteString("  " + m.input.View() + "\n\n")
		b.WriteString("  " + hintStyle.Render("enter save · esc cancel") + "\n\n")

	case settingsSaved:
		b.WriteString("  " + okStyle.Render("✓ Saved") + "\n")
		b.WriteString("  " + hintStyle.Render("Value written to shell profile. Restart your terminal or run:") + "\n")
		b.WriteString("  " + hintStyle.Render("  source ~/.zshrc") + "\n\n")
	}

	return tea.NewView(b.String())
}

// maskAPIKey shows first 8 and last 4 chars, masking the rest.
func maskAPIKey(key string) string {
	if key == "" {
		return "(not set)"
	}
	if len(key) <= 12 {
		return strings.Repeat("•", len(key))
	}
	return key[:8] + strings.Repeat("•", len(key)-12) + key[len(key)-4:]
}

// saveEnvToProfile appends an export line to the user's shell profile.
func saveEnvToProfile(key, value string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("cannot determine home directory: %w", err)
	}

	// Determine profile file based on current shell.
	shell := os.Getenv("SHELL")
	var profilePath string
	switch {
	case strings.Contains(shell, "bash"):
		profilePath = filepath.Join(home, ".bashrc")
		if _, err := os.Stat(profilePath); os.IsNotExist(err) {
			profilePath = filepath.Join(home, ".bash_profile")
		}
	case strings.Contains(shell, "zsh"), shell == "":
		profilePath = filepath.Join(home, ".zshrc")
	default:
		return fmt.Errorf("unsupported shell %q — manually set: export %s=%q", shell, key, value)
	}

	// Read existing content to check for duplicates.
	content, _ := os.ReadFile(profilePath)
	exportLine := fmt.Sprintf("export %s=%q", key, value)
	prefix := fmt.Sprintf("export %s=", key)

	// Replace existing line if present.
	lines := strings.Split(string(content), "\n")
	found := false
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			lines[i] = exportLine
			found = true
			break
		}
	}

	if found {
		// Preserve original file permissions.
		perm := os.FileMode(0o644)
		if fi, err := os.Stat(profilePath); err == nil {
			perm = fi.Mode()
		}
		return os.WriteFile(profilePath, []byte(strings.Join(lines, "\n")), perm)
	}

	// Append new line.
	f, err := os.OpenFile(profilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("cannot open %s: %w", profilePath, err)
	}
	defer f.Close()

	_, err = fmt.Fprintf(f, "\n# Added by alfred\n%s\n", exportLine)
	return err
}

func runSettings() error {
	m := newSettingsModel()
	_, err := tea.NewProgram(m).Run()
	return err
}
