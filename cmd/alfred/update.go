package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/spinner"
	"charm.land/lipgloss/v2"
)

const modulePath = "github.com/hir4ta/claude-alfred/cmd/alfred"

// showVersion prints a styled version display.
func showVersion() {
	ver := resolvedVersion()
	c := resolvedCommit()
	d := resolvedDate()

	nameStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	verStyle := lipgloss.NewStyle().Bold(true)
	metaStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))

	line := nameStyle.Render("alfred") + " " + verStyle.Render(ver)
	if c != "" {
		meta := c
		if d != "" {
			// Show date only (strip time).
			if t, err := time.Parse(time.RFC3339, d); err == nil {
				meta += " " + t.Format("2006-01-02")
			} else {
				meta += " " + d
			}
		}
		line += " " + metaStyle.Render("("+meta+")")
	}
	fmt.Println(line)
}

// --- update TUI ---

type updatePhase int

const (
	updateChecking updatePhase = iota
	updateUpToDate
	updateInstalling
	updateDone
	updateError
)

type (
	latestVersionMsg struct {
		version string
		err     error
	}
	installDoneMsg struct{ err error }
)

type updateModel struct {
	phase      updatePhase
	current    string
	latest     string
	err        error
	spinner    spinner.Model
	startTime  time.Time
}

func newUpdateModel() updateModel {
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle
	return updateModel{
		phase:     updateChecking,
		current:   resolvedVersion(),
		spinner:   s,
		startTime: time.Now(),
	}
}

func (m updateModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, checkLatestVersion)
}

func (m updateModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			return m, tea.Quit
		}

	case latestVersionMsg:
		if msg.err != nil {
			m.phase = updateError
			m.err = msg.err
			return m, tea.Quit
		}
		m.latest = msg.version
		if m.latest == m.current {
			m.phase = updateUpToDate
			return m, tea.Quit
		}
		m.phase = updateInstalling
		return m, doInstall

	case installDoneMsg:
		if msg.err != nil {
			m.phase = updateError
			m.err = msg.err
			return m, tea.Quit
		}
		m.phase = updateDone
		return m, tea.Quit

	case spinner.TickMsg:
		if m.phase == updateChecking || m.phase == updateInstalling {
			sm, cmd := m.spinner.Update(msg)
			m.spinner = sm
			return m, cmd
		}
		return m, nil
	}

	return m, nil
}

func (m updateModel) View() tea.View {
	var b strings.Builder

	b.WriteString("\n")

	nameStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	verStyle := lipgloss.NewStyle().Bold(true)
	arrowStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#7571F9"))

	switch m.phase {
	case updateChecking:
		b.WriteString(fmt.Sprintf("  %s Checking latest version %s\n",
			nameStyle.Render("alfred"), m.spinner.View()))

	case updateUpToDate:
		b.WriteString(fmt.Sprintf("  %s %s %s\n",
			nameStyle.Render("alfred"),
			verStyle.Render(m.current),
			doneStyle.Render("already up to date")))

	case updateInstalling:
		b.WriteString(fmt.Sprintf("  %s %s %s %s\n",
			nameStyle.Render("alfred"),
			dimStyle.Render(m.current),
			arrowStyle.Render("→"),
			verStyle.Render(m.latest)))
		b.WriteString(fmt.Sprintf("  Installing %s\n", m.spinner.View()))

	case updateDone:
		elapsed := time.Since(m.startTime).Round(time.Second)
		b.WriteString(fmt.Sprintf("  %s %s %s %s\n",
			nameStyle.Render("alfred"),
			dimStyle.Render(m.current),
			arrowStyle.Render("→"),
			verStyle.Render(m.latest)))
		b.WriteString(fmt.Sprintf("  %s (%s)\n",
			doneStyle.Render("✓ Updated"),
			elapsed))

	case updateError:
		b.WriteString(fmt.Sprintf("  %s %v\n",
			errStyle.Render("✗ Error:"), m.err))
	}

	b.WriteString("\n")
	return tea.NewView(b.String())
}

func checkLatestVersion() tea.Msg {
	cmd := exec.Command("go", "list", "-m", "-json", modulePath+"@latest")
	out, err := cmd.Output()
	if err != nil {
		return latestVersionMsg{err: fmt.Errorf("failed to check latest version: %w", err)}
	}
	var info struct {
		Version string `json:"Version"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return latestVersionMsg{err: fmt.Errorf("failed to parse version info: %w", err)}
	}
	// Strip "v" prefix for consistency.
	ver := strings.TrimPrefix(info.Version, "v")
	return latestVersionMsg{version: ver}
}

func doInstall() tea.Msg {
	cmd := exec.Command("go", "install", modulePath+"@latest")
	if out, err := cmd.CombinedOutput(); err != nil {
		return installDoneMsg{err: fmt.Errorf("%w: %s", err, out)}
	}
	return installDoneMsg{}
}

func runUpdate() error {
	m := newUpdateModel()
	_, err := tea.NewProgram(m).Run()
	return err
}
