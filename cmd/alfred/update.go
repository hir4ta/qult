package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/spinner"
	"charm.land/lipgloss/v2"
)

const githubRepo = "hir4ta/claude-alfred"

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
	phase     updatePhase
	current   string
	latest    string
	method    string // "brew", "download", "go"
	err       error
	spinner   spinner.Model
	startTime time.Time
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
		return m, doInstall(m.latest)

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

// checkLatestVersion fetches the latest release tag from GitHub API.
func checkLatestVersion() tea.Msg {
	url := "https://api.github.com/repos/" + githubRepo + "/releases/latest"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return latestVersionMsg{err: fmt.Errorf("failed to check latest version: %w", err)}
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return latestVersionMsg{err: fmt.Errorf("failed to check latest version: %w", err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return latestVersionMsg{err: fmt.Errorf("failed to check latest version: HTTP %d", resp.StatusCode)}
	}

	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return latestVersionMsg{err: fmt.Errorf("failed to parse version info: %w", err)}
	}

	ver := strings.TrimPrefix(release.TagName, "v")
	return latestVersionMsg{version: ver}
}

// doInstall updates alfred using the best available method:
// 1. Homebrew (if installed via brew)
// 2. Direct download from GitHub Releases
// 3. go install (fallback if Go is available)
func doInstall(version string) tea.Cmd {
	return func() tea.Msg {
		// Try Homebrew first.
		if isBrewInstalled() {
			cmd := exec.Command("brew", "upgrade", "hir4ta/alfred/alfred")
			if out, err := cmd.CombinedOutput(); err != nil {
				// brew upgrade fails if already latest or not installed via brew.
				// Try reinstall as fallback.
				cmd = exec.Command("brew", "install", "hir4ta/alfred/alfred")
				if out2, err2 := cmd.CombinedOutput(); err2 != nil {
					debugf("brew install failed: %s / %s", out, out2)
					// Fall through to direct download.
				} else {
					regenPluginBundle()
					return installDoneMsg{}
				}
			} else {
				regenPluginBundle()
				return installDoneMsg{}
			}
		}

		// Direct download from GitHub Releases.
		if err := downloadRelease(version); err == nil {
			regenPluginBundle()
			return installDoneMsg{}
		}

		// Fallback: go install (if Go is available).
		goPath, err := exec.LookPath("go")
		if err == nil {
			cmd := exec.Command(goPath, "install",
				"github.com/hir4ta/claude-alfred/cmd/alfred@v"+version)
			if out, err := cmd.CombinedOutput(); err != nil {
				return installDoneMsg{err: fmt.Errorf("%w: %s", err, out)}
			}
			regenPluginBundle()
			return installDoneMsg{}
		}

		return installDoneMsg{err: fmt.Errorf("no install method available (tried brew, download, go install)")}
	}
}

// isBrewInstalled checks if the current alfred binary was installed via Homebrew.
func isBrewInstalled() bool {
	brewPrefix, err := exec.Command("brew", "--prefix").Output()
	if err != nil {
		return false
	}
	selfPath, err := os.Executable()
	if err != nil {
		return false
	}
	resolved, err := filepath.EvalSymlinks(selfPath)
	if err != nil {
		return false
	}
	return strings.HasPrefix(resolved, strings.TrimSpace(string(brewPrefix)))
}

// downloadRelease downloads the alfred binary from GitHub Releases.
func downloadRelease(version string) error {
	goos := runtime.GOOS
	goarch := runtime.GOARCH
	url := fmt.Sprintf("https://github.com/%s/releases/download/v%s/alfred_%s_%s.tar.gz",
		githubRepo, version, goos, goarch)

	cacheDir := filepath.Join(os.Getenv("HOME"), ".alfred", "bin")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return err
	}

	// Use curl or wget.
	if curlPath, err := exec.LookPath("curl"); err == nil {
		cmd := exec.Command("sh", "-c",
			fmt.Sprintf("%s -sSfL '%s' | tar xz -C '%s' alfred", curlPath, url, cacheDir))
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download failed: %w: %s", err, out)
		}
		return nil
	}
	if wgetPath, err := exec.LookPath("wget"); err == nil {
		cmd := exec.Command("sh", "-c",
			fmt.Sprintf("%s -qO- '%s' | tar xz -C '%s' alfred", wgetPath, url, cacheDir))
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download failed: %w: %s", err, out)
		}
		return nil
	}
	return fmt.Errorf("curl or wget not found")
}

// regenPluginBundle regenerates the plugin bundle at the installed location (best-effort).
func regenPluginBundle() {
	if root := findInstalledPluginRoot(); root != "" {
		cmd := exec.Command("alfred", "plugin-bundle", root)
		cmd.Run()
	}
}

// findInstalledPluginRoot reads ~/.claude/plugins/installed_plugins.json
// and returns the installPath for the alfred plugin.
func findInstalledPluginRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "plugins", "installed_plugins.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return ""
	}
	for key, entries := range manifest.Plugins {
		if strings.Contains(key, "alfred") && len(entries) > 0 {
			return entries[0].InstallPath
		}
	}
	return ""
}

func runUpdate() error {
	m := newUpdateModel()
	_, err := tea.NewProgram(m).Run()
	return err
}
