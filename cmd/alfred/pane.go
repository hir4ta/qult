package main

import (
	"crypto/md5"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/hir4ta/claude-alfred/internal/spec"
)

// Everforest Dark palette — muted, earthy tones.
var (
	// Base text
	paneFg  = lipgloss.NewStyle().Foreground(lipgloss.Color("#D3C6AA")) // fg
	paneDim = lipgloss.NewStyle().Foreground(lipgloss.Color("#859289")) // grey1

	// Accents
	paneGreen  = lipgloss.NewStyle().Foreground(lipgloss.Color("#A7C080")) // green
	paneYellow = lipgloss.NewStyle().Foreground(lipgloss.Color("#DBBC7F")) // yellow
	paneOrange = lipgloss.NewStyle().Foreground(lipgloss.Color("#E69875")) // orange
	paneRed    = lipgloss.NewStyle().Foreground(lipgloss.Color("#E67E80")) // red
	paneAqua   = lipgloss.NewStyle().Foreground(lipgloss.Color("#83C092")) // aqua
	panePurple = lipgloss.NewStyle().Foreground(lipgloss.Color("#D699B6")) // purple
	paneBlue   = lipgloss.NewStyle().Foreground(lipgloss.Color("#7FBBB3")) // blue

	// Structural
	paneSec = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7FBBB3")) // blue bold
	paneSep = lipgloss.NewStyle().Foreground(lipgloss.Color("#4F585E"))             // bg3 (subtle line)
)

// --- Messages ---

type paneTickMsg time.Time

func paneTick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
		return paneTickMsg(t)
	})
}

// --- Helpers ---

func readActiveSlug() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	slug, err := spec.ReadActive(cwd)
	if err != nil {
		return ""
	}
	return slug
}

func specFilePath(slug, file string) string {
	return filepath.Join(".alfred", "specs", slug, file)
}

func fileHash(paths ...string) string {
	var parts []string
	for _, p := range paths {
		data, _ := os.ReadFile(p)
		parts = append(parts, fmt.Sprintf("%x", md5.Sum(data)))
	}
	return strings.Join(parts, ":")
}

func stripComments(s string) string {
	var lines []string
	inComment := false
	for line := range strings.SplitSeq(s, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "<!--") {
			inComment = true
		}
		if inComment {
			if strings.Contains(trimmed, "-->") {
				inComment = false
			}
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func gitCmd(args ...string) string {
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func altView(content string) tea.View {
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

func separator(width int) string {
	if width <= 4 {
		width = 40
	}
	return paneSep.Render(strings.Repeat("─", width-4))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spec Pane
// ═══════════════════════════════════════════════════════════════════════════════

type specPaneModel struct {
	width, height int
	slug          string
	session       string
	hash          string
}

func (m specPaneModel) Init() tea.Cmd { return paneTick() }

func (m specPaneModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case paneTickMsg:
		m.refresh()
		return m, paneTick()
	}
	return m, nil
}

func (m *specPaneModel) refresh() {
	slug := readActiveSlug()
	if slug == "" {
		m.slug = ""
		return
	}

	sp := specFilePath(slug, "session.md")
	h := fileHash(sp)
	if h == m.hash {
		return
	}

	m.slug = slug
	s, _ := os.ReadFile(sp)
	m.session = string(s)
	m.hash = h
}

func (m specPaneModel) View() tea.View {
	var b strings.Builder

	if m.slug == "" {
		b.WriteString("\n")
		b.WriteString(paneDim.Render("  Waiting for spec...") + "\n\n")
		b.WriteString(paneDim.Render("  /alfred:plan <slug>") + "\n")
		return altView(b.String())
	}

	b.WriteString("\n")
	b.WriteString("  " + paneBlue.Render(m.slug) + "\n")

	// Session
	b.WriteString("\n")
	b.WriteString("  " + separator(m.width) + "\n")
	b.WriteString(paneSec.Render("  session.md") + "\n")
	b.WriteString("  " + separator(m.width) + "\n")
	for line := range strings.SplitSeq(m.session, "\n") {
		switch {
		case strings.HasPrefix(line, "## "):
			b.WriteString(paneOrange.Render("  "+line) + "\n")
		case strings.TrimSpace(line) != "":
			b.WriteString(paneFg.Render("  "+line) + "\n")
		}
	}

	return altView(b.String())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Decisions Pane
// ═══════════════════════════════════════════════════════════════════════════════

type decisionsPaneModel struct {
	width, height int
	slug          string
	decisions     string
	hash          string
}

func (m decisionsPaneModel) Init() tea.Cmd { return paneTick() }

func (m decisionsPaneModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case paneTickMsg:
		m.refresh()
		return m, paneTick()
	}
	return m, nil
}

func (m *decisionsPaneModel) refresh() {
	slug := readActiveSlug()
	if slug == "" {
		m.slug = ""
		return
	}

	dp := specFilePath(slug, "decisions.md")
	h := fileHash(dp)
	if h == m.hash {
		return
	}

	m.slug = slug
	d, _ := os.ReadFile(dp)
	m.decisions = stripComments(string(d))
	m.hash = h
}

func (m decisionsPaneModel) View() tea.View {
	var b strings.Builder

	if m.slug == "" {
		b.WriteString("\n")
		b.WriteString(paneDim.Render("  Waiting for spec...") + "\n")
		return altView(b.String())
	}

	// Decisions
	b.WriteString("\n")
	b.WriteString("  " + separator(m.width) + "\n")
	b.WriteString(panePurple.Bold(true).Render("  decisions.md") + "\n")
	b.WriteString("  " + separator(m.width) + "\n")
	for line := range strings.SplitSeq(m.decisions, "\n") {
		switch {
		case strings.HasPrefix(line, "## "):
			b.WriteString(paneYellow.Render("  "+line) + "\n")
		case strings.HasPrefix(line, "- **"):
			b.WriteString(paneAqua.Render("  "+line) + "\n")
		case strings.TrimSpace(line) != "":
			b.WriteString(paneFg.Render("  "+line) + "\n")
		}
	}

	return altView(b.String())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Git Pane
// ═══════════════════════════════════════════════════════════════════════════════

type gitPaneModel struct {
	width, height int
	branch        string
	staged        string
	unstaged      string
	untracked     []string
	hash          string
}

func (m gitPaneModel) Init() tea.Cmd { return paneTick() }

func (m gitPaneModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case paneTickMsg:
		m.refresh()
		return m, paneTick()
	}
	return m, nil
}

func (m *gitPaneModel) refresh() {
	branch := gitCmd("branch", "--show-current")
	staged := gitCmd("diff", "--cached", "--stat")
	unstaged := gitCmd("diff", "--stat")
	untracked := gitCmd("ls-files", "--others", "--exclude-standard")

	h := branch + "|" + staged + "|" + unstaged + "|" + untracked
	if h == m.hash {
		return
	}

	m.branch = branch
	m.staged = staged
	m.unstaged = unstaged
	m.untracked = nil
	for f := range strings.SplitSeq(untracked, "\n") {
		if f != "" {
			m.untracked = append(m.untracked, f)
		}
	}
	m.hash = h
}

func (m gitPaneModel) View() tea.View {
	var b strings.Builder

	if m.branch == "" {
		b.WriteString("\n")
		b.WriteString(paneDim.Render("  Not a git repository") + "\n")
		return altView(b.String())
	}

	b.WriteString("\n")
	b.WriteString("  " + paneGreen.Bold(true).Render(m.branch) + "\n")

	if m.staged != "" {
		b.WriteString("\n")
		b.WriteString(paneAqua.Render("  Staged") + "\n")
		for line := range strings.SplitSeq(m.staged, "\n") {
			if strings.TrimSpace(line) != "" {
				b.WriteString(paneFg.Render("    "+line) + "\n")
			}
		}
	}

	if m.unstaged != "" {
		b.WriteString("\n")
		b.WriteString(paneOrange.Render("  Modified") + "\n")
		for line := range strings.SplitSeq(m.unstaged, "\n") {
			if strings.TrimSpace(line) != "" {
				b.WriteString(paneFg.Render("    "+line) + "\n")
			}
		}
	}

	if len(m.untracked) > 0 {
		b.WriteString("\n")
		b.WriteString(paneDim.Render(fmt.Sprintf("  Untracked (%d)", len(m.untracked))) + "\n")
		limit := min(len(m.untracked), 10)
		for _, f := range m.untracked[:limit] {
			b.WriteString(paneFg.Render("    "+f) + "\n")
		}
		if len(m.untracked) > 10 {
			b.WriteString(paneDim.Render(fmt.Sprintf("    ... +%d more", len(m.untracked)-10)) + "\n")
		}
	}

	if m.staged == "" && m.unstaged == "" && len(m.untracked) == 0 {
		b.WriteString("\n")
		b.WriteString(paneDim.Render("  Working tree clean") + "\n")
	}

	return altView(b.String())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════════

func runPane(paneType string) error {
	var model tea.Model
	switch paneType {
	case "spec":
		model = specPaneModel{}
	case "decisions":
		model = decisionsPaneModel{}
	case "git":
		model = gitPaneModel{}
	default:
		return fmt.Errorf("unknown pane type: %s (available: spec, decisions, git)", paneType)
	}

	_, err := tea.NewProgram(model).Run()
	return err
}
