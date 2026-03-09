package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/list"
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

// settingEntry implements list.DefaultItem for the settings list.
type settingEntry struct {
	label string
	envKey string
	value string
}

func (s settingEntry) Title() string       { return s.label }
func (s settingEntry) Description() string { return s.value }
func (s settingEntry) FilterValue() string { return s.label }

type settingsModel struct {
	phase    settingsPhase
	list     list.Model
	input    textinput.Model
	editKey  string
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

	items := []list.Item{
		settingEntry{label: "Voyage API Key", envKey: "VOYAGE_API_KEY", value: maskedKey},
	}

	delegate := list.NewDefaultDelegate()
	l := list.New(items, delegate, 50, 10)
	l.Title = "⚙  alfred settings"
	l.Styles.Title = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	l.SetFilteringEnabled(false)
	l.SetShowStatusBar(false)
	l.DisableQuitKeybindings()

	return settingsModel{
		phase: settingsMenu,
		list:  l,
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
			case "enter":
				if item, ok := m.list.SelectedItem().(settingEntry); ok {
					m.phase = settingsEditKey
					m.editKey = item.envKey
					m.input.SetValue("")
					if m.editKey == "VOYAGE_API_KEY" {
						m.input.EchoMode = textinput.EchoPassword
						m.input.Placeholder = "sk-voyage-..."
					} else {
						m.input.EchoMode = textinput.EchoNormal
					}
					return m, m.input.Focus()
				}

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
				// Update the list item with new masked value.
				idx := m.list.Index()
				if item, ok := m.list.Items()[idx].(settingEntry); ok {
					item.value = maskAPIKey(val)
					cmd := m.list.SetItem(idx, item)
					m.phase = settingsSaved
					return m, tea.Sequence(cmd, tea.Quit)
				}
				m.phase = settingsSaved
				return m, tea.Quit
			}
		}
	case tea.WindowSizeMsg:
		m.list.SetSize(msg.Width, msg.Height)
	}

	if m.phase == settingsEditKey {
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m settingsModel) View() tea.View {
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	errStyleLocal := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	hintStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))
	labelStyle := lipgloss.NewStyle().Width(22)

	var b strings.Builder

	switch m.phase {
	case settingsMenu:
		b.WriteString(m.list.View())
		if m.err != nil {
			b.WriteString("\n  " + errStyleLocal.Render("✗ Error: "+m.err.Error()) + "\n")
		}

	case settingsEditKey:
		headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
		b.WriteString("\n  " + headerStyle.Render("⚙  alfred settings") + "\n\n")
		b.WriteString("  " + labelStyle.Render(m.editKey) + "\n\n")
		b.WriteString("  " + m.input.View() + "\n\n")
		h := newHelp()
		enterKey := keyEnter
		enterKey.SetHelp("enter", "save")
		escKey := keyEsc
		escKey.SetHelp("esc", "cancel")
		b.WriteString("  " + h.View(simpleKeyMap{enterKey, escKey}) + "\n\n")

	case settingsSaved:
		b.WriteString("\n  " + okStyle.Render("✓ Saved") + "\n")
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
	// Use single quotes for shell safety: prevents $() and backtick expansion.
	escaped := strings.ReplaceAll(value, "'", "'\\''")
	exportLine := fmt.Sprintf("export %s='%s'", key, escaped)
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
