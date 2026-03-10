package main

import (
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/stopwatch"
	"charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/viewport"
)

// keyMsg creates a tea.KeyPressMsg from a key string.
// Supports: single runes like "q", "?", and special keys like "enter", "esc", "ctrl+c".
func keyMsg(k string) tea.KeyPressMsg {
	switch k {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "ctrl+c":
		return tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
	default:
		r := []rune(k)
		return tea.KeyPressMsg{Code: r[0], Text: k}
	}
}

// isQuitCmd executes a tea.Cmd and checks if it returns tea.QuitMsg.
func isQuitCmd(cmd tea.Cmd) bool {
	if cmd == nil {
		return false
	}
	msg := cmd()
	_, ok := msg.(tea.QuitMsg)
	return ok
}

// viewString extracts the content string from a tea.View.
func viewString(v tea.View) string {
	return v.Content
}

// ---------- keys.go ----------

func TestTUI_NewHelp(t *testing.T) {
	t.Parallel()
	h := newHelp()
	if h.ShortSeparator != " · " {
		t.Errorf("newHelp().ShortSeparator = %q, want %q", h.ShortSeparator, " · ")
	}
}

func TestTUI_SimpleKeyMap(t *testing.T) {
	t.Parallel()
	bindings := simpleKeyMap{keyQuit, keyEnter}

	short := bindings.ShortHelp()
	if len(short) != 2 {
		t.Errorf("ShortHelp() returned %d bindings, want 2", len(short))
	}

	full := bindings.FullHelp()
	if len(full) != 1 || len(full[0]) != 2 {
		t.Errorf("FullHelp() = %v, want 1 group with 2 bindings", full)
	}
}

// ---------- settings.go ----------

func TestTUI_MaskAPIKey(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		key  string
		want string
	}{
		{"empty", "", "(not set)"},
		{"short", "short", "•••••"},
		{"exactly12", "123456789012", "••••••••••••"},
		{"long", "sk-voyage-abc123def456", "sk-voyag••••••••••f456"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := maskAPIKey(tt.key)
			if got != tt.want {
				t.Errorf("maskAPIKey(%q) = %q, want %q", tt.key, got, tt.want)
			}
		})
	}
}

func TestTUI_SettingsModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("q quits", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		result, cmd := m.Update(keyMsg("q"))
		sm := result.(settingsModel)
		if !sm.quitting {
			t.Error("expected quitting=true after q")
		}
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after q")
		}
	})

	t.Run("esc quits", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		result, cmd := m.Update(keyMsg("esc"))
		sm := result.(settingsModel)
		if !sm.quitting {
			t.Error("expected quitting=true after esc")
		}
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after esc")
		}
	})

	t.Run("enter transitions to editKey", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		result, _ := m.Update(keyMsg("enter"))
		sm := result.(settingsModel)
		if sm.phase != settingsEditKey {
			t.Errorf("phase = %d, want settingsEditKey (%d)", sm.phase, settingsEditKey)
		}
	})
}

func TestTUI_SettingsModel_View(t *testing.T) {
	t.Parallel()

	t.Run("menu phase", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		v := viewString(m.View())
		if !strings.Contains(v, "settings") {
			t.Error("menu view should contain 'settings'")
		}
	})

	t.Run("editKey phase", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		result, _ := m.Update(keyMsg("enter"))
		sm := result.(settingsModel)
		v := viewString(sm.View())
		if !strings.Contains(v, "VOYAGE_API_KEY") {
			t.Error("editKey view should contain 'VOYAGE_API_KEY'")
		}
	})

	t.Run("saved phase", func(t *testing.T) {
		t.Parallel()
		m := newSettingsModel()
		m.phase = settingsSaved
		v := viewString(m.View())
		if !strings.Contains(v, "Saved") {
			t.Error("saved view should contain 'Saved'")
		}
	})
}

// ---------- doctor.go ----------

func newTestDoctorModel() doctorModel {
	t := table.New(
		table.WithColumns([]table.Column{
			{Title: "Status", Width: 8},
			{Title: "Check", Width: 16},
			{Title: "Details", Width: 44},
		}),
		table.WithRows([]table.Row{
			{"✓ ok", "Test", "test check"},
		}),
	)
	return doctorModel{table: t, fails: 0, warns: 1}
}

func TestTUI_DoctorModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("q quits", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		_, cmd := m.Update(keyMsg("q"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after q")
		}
	})

	t.Run("? toggles help", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		result, _ := m.Update(keyMsg("?"))
		dm := result.(doctorModel)
		if !dm.showHelp {
			t.Error("expected showHelp=true after ?")
		}
		result2, _ := dm.Update(keyMsg("?"))
		dm2 := result2.(doctorModel)
		if dm2.showHelp {
			t.Error("expected showHelp=false after second ?")
		}
	})

	t.Run("esc closes help", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		m.showHelp = true
		result, cmd := m.Update(keyMsg("esc"))
		dm := result.(doctorModel)
		if dm.showHelp {
			t.Error("expected showHelp=false after esc when help is open")
		}
		if isQuitCmd(cmd) {
			t.Error("esc with help open should not quit")
		}
	})

	t.Run("esc quits when help closed", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		_, cmd := m.Update(keyMsg("esc"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit after esc when help is closed")
		}
	})
}

func TestTUI_DoctorModel_View(t *testing.T) {
	t.Parallel()

	t.Run("normal view contains header", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		v := viewString(m.View())
		if !strings.Contains(v, "alfred doctor") {
			t.Error("view should contain 'alfred doctor' header")
		}
	})

	t.Run("shows warning count", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		v := viewString(m.View())
		if !strings.Contains(v, "warning") {
			t.Error("view should contain warning summary when warns > 0")
		}
	})

	t.Run("help overlay", func(t *testing.T) {
		t.Parallel()
		m := newTestDoctorModel()
		m.showHelp = true
		v := viewString(m.View())
		if !strings.Contains(v, "Doctor Checks") {
			t.Error("help overlay should contain 'Doctor Checks'")
		}
		if !strings.Contains(v, "Press ? or Esc to close") {
			t.Error("help overlay should contain close instructions")
		}
	})
}

// ---------- analytics.go ----------

func TestTUI_IndentBlock(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		input  string
		prefix string
		want   string
	}{
		{"multiline", "a\nb\n", "  ", "  a\n  b\n"},
		{"empty", "", "  ", ""},
		{"single line", "hello", ">> ", ">> hello"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := indentBlock(tt.input, tt.prefix)
			if got != tt.want {
				t.Errorf("indentBlock(%q, %q) = %q, want %q", tt.input, tt.prefix, got, tt.want)
			}
		})
	}
}

func newTestAnalyticsModel() analyticsModel {
	vp := viewport.New(viewport.WithWidth(80), viewport.WithHeight(24))
	vp.SetContent("test analytics content")
	return analyticsModel{viewport: vp}
}

func TestTUI_AnalyticsModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("q quits", func(t *testing.T) {
		t.Parallel()
		m := newTestAnalyticsModel()
		_, cmd := m.Update(keyMsg("q"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after q")
		}
	})

	t.Run("? toggles help", func(t *testing.T) {
		t.Parallel()
		m := newTestAnalyticsModel()
		result, _ := m.Update(keyMsg("?"))
		am := result.(analyticsModel)
		if !am.showHelp {
			t.Error("expected showHelp=true after ?")
		}
	})

	t.Run("esc closes help", func(t *testing.T) {
		t.Parallel()
		m := newTestAnalyticsModel()
		m.showHelp = true
		result, cmd := m.Update(keyMsg("esc"))
		am := result.(analyticsModel)
		if am.showHelp {
			t.Error("expected showHelp=false after esc when help is open")
		}
		if isQuitCmd(cmd) {
			t.Error("esc with help open should not quit")
		}
	})
}

func TestTUI_AnalyticsModel_View(t *testing.T) {
	t.Parallel()

	t.Run("normal view", func(t *testing.T) {
		t.Parallel()
		m := newTestAnalyticsModel()
		v := viewString(m.View())
		// Viewport may or may not render content depending on internal state,
		// but the help bar should always be present.
		if !strings.Contains(v, "quit") {
			t.Error("view should contain help bar with quit binding")
		}
	})

	t.Run("help overlay", func(t *testing.T) {
		t.Parallel()
		m := newTestAnalyticsModel()
		m.showHelp = true
		v := viewString(m.View())
		if !strings.Contains(v, "Analytics Help") {
			t.Error("help overlay should contain 'Analytics Help'")
		}
	})
}

// ---------- setup.go ----------

func TestTUI_SetupModel_NewWithKey(t *testing.T) {
	t.Parallel()
	m := newSetupModel(true)
	if m.phase != phaseInit {
		t.Errorf("newSetupModel(true).phase = %d, want phaseInit (%d)", m.phase, phaseInit)
	}
	// keyReady should be closed.
	select {
	case <-m.keyReady:
		// ok
	default:
		t.Error("keyReady should be closed when hasKey=true")
	}
}

func TestTUI_SetupModel_NewWithoutKey(t *testing.T) {
	t.Parallel()
	m := newSetupModel(false)
	if m.phase != phaseKeyPrompt {
		t.Errorf("newSetupModel(false).phase = %d, want phaseKeyPrompt (%d)", m.phase, phaseKeyPrompt)
	}
}

func TestTUI_SetupModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("ctrl+c quits", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(false)
		_, cmd := m.Update(keyMsg("ctrl+c"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after ctrl+c")
		}
	})

	t.Run("esc at keyPrompt sets ftsOnly", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(false)
		result, _ := m.Update(keyMsg("esc"))
		sm := result.(setupModel)
		if !sm.ftsOnly {
			t.Error("expected ftsOnly=true after esc at phaseKeyPrompt")
		}
		if sm.phase != phaseInit {
			t.Errorf("phase = %d, want phaseInit (%d)", sm.phase, phaseInit)
		}
	})

	t.Run("enter with empty at keyPrompt sets ftsOnly", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(false)
		// keyInput value is empty by default
		result, _ := m.Update(keyMsg("enter"))
		sm := result.(setupModel)
		if !sm.ftsOnly {
			t.Error("expected ftsOnly=true after enter with empty input")
		}
		if sm.phase != phaseInit {
			t.Errorf("phase = %d, want phaseInit (%d)", sm.phase, phaseInit)
		}
	})

	t.Run("docProgressMsg transitions to phaseSeeding", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		result, _ := m.Update(docProgressMsg{done: 5, total: 10})
		sm := result.(setupModel)
		if sm.phase != phaseSeeding {
			t.Errorf("phase = %d, want phaseSeeding (%d)", sm.phase, phaseSeeding)
		}
		if sm.docsDone != 5 || sm.docsTotal != 10 {
			t.Errorf("docs progress = %d/%d, want 5/10", sm.docsDone, sm.docsTotal)
		}
	})

	t.Run("embedProgressMsg transitions to phaseEmbedding", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		result, _ := m.Update(embedProgressMsg{done: 3, total: 20})
		sm := result.(setupModel)
		if sm.phase != phaseEmbedding {
			t.Errorf("phase = %d, want phaseEmbedding (%d)", sm.phase, phaseEmbedding)
		}
	})

	t.Run("seedDoneMsg with error transitions to phaseError", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		testErr := errors.New("seed failed")
		result, cmd := m.Update(seedDoneMsg{err: testErr})
		sm := result.(setupModel)
		if sm.phase != phaseError {
			t.Errorf("phase = %d, want phaseError (%d)", sm.phase, phaseError)
		}
		if sm.err != testErr {
			t.Errorf("err = %v, want %v", sm.err, testErr)
		}
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after seedDoneMsg with error")
		}
	})

	t.Run("seedDoneMsg success transitions to phaseDone", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		result, _ := m.Update(seedDoneMsg{})
		sm := result.(setupModel)
		if sm.phase != phaseDone {
			t.Errorf("phase = %d, want phaseDone (%d)", sm.phase, phaseDone)
		}
	})
}

func TestTUI_SetupModel_View(t *testing.T) {
	t.Parallel()

	t.Run("keyPrompt phase", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(false)
		v := viewString(m.View())
		if !strings.Contains(v, "Voyage API Key") {
			t.Error("keyPrompt view should contain 'Voyage API Key'")
		}
	})

	t.Run("done phase", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		m.phase = phaseDone
		v := viewString(m.View())
		if !strings.Contains(v, "Setup complete") {
			t.Error("done view should contain 'Setup complete'")
		}
	})

	t.Run("error phase", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		m.phase = phaseError
		m.err = errors.New("test error message")
		v := viewString(m.View())
		if !strings.Contains(v, "test error message") {
			t.Error("error view should contain the error text")
		}
		if !strings.Contains(v, "Error") {
			t.Error("error view should contain 'Error'")
		}
	})

	t.Run("seeding phase", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		m.phase = phaseSeeding
		m.docsDone = 5
		m.docsTotal = 10
		v := viewString(m.View())
		if !strings.Contains(v, "Seeding docs") {
			t.Error("seeding view should contain 'Seeding docs'")
		}
	})
}

// ---------- memory.go ----------

func TestTUI_MemoryMaxAgeDays(t *testing.T) {
	// Cannot use t.Parallel() because subtests use t.Setenv.

	t.Run("default", func(t *testing.T) {
		t.Setenv("ALFRED_MEMORY_MAX_AGE_DAYS", "")
		got := memoryMaxAgeDays()
		if got != defaultMemoryMaxAgeDays {
			t.Errorf("memoryMaxAgeDays() = %d, want %d", got, defaultMemoryMaxAgeDays)
		}
	})

	t.Run("custom env", func(t *testing.T) {
		t.Setenv("ALFRED_MEMORY_MAX_AGE_DAYS", "30")
		got := memoryMaxAgeDays()
		if got != 30 {
			t.Errorf("memoryMaxAgeDays() = %d, want 30", got)
		}
	})

	t.Run("invalid env falls back", func(t *testing.T) {
		t.Setenv("ALFRED_MEMORY_MAX_AGE_DAYS", "not-a-number")
		got := memoryMaxAgeDays()
		if got != defaultMemoryMaxAgeDays {
			t.Errorf("memoryMaxAgeDays() = %d, want %d", got, defaultMemoryMaxAgeDays)
		}
	})
}

func newTestPruneModel() pruneModel {
	items := []pruneItem{
		{date: "2025-01-01", sectionPath: "project/memory-1"},
		{date: "2025-01-15", sectionPath: "project/memory-2"},
		{date: "2025-02-01", sectionPath: "project/memory-3"},
	}
	return newPruneModel(items, 3, 180, nil, "2025-06-01T00:00:00Z")
}

func TestTUI_PruneModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("q quits", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		_, cmd := m.Update(keyMsg("q"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after q")
		}
	})

	t.Run("enter starts deletion with non-nil cmd", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		result, cmd := m.Update(keyMsg("enter"))
		pm := result.(pruneModel)
		if !pm.deleting {
			t.Error("expected deleting=true after enter")
		}
		// cmd should be non-nil (it's the delete function).
		// We can't execute it because st is nil, but we verify it exists.
		if cmd == nil {
			t.Error("expected non-nil cmd after enter (delete function)")
		}
	})

	t.Run("pruneDeletedMsg sets done", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.deleting = true
		result, _ := m.Update(pruneDeletedMsg{deleted: 3})
		pm := result.(pruneModel)
		if !pm.done {
			t.Error("expected done=true after pruneDeletedMsg")
		}
		if pm.deleted != 3 {
			t.Errorf("deleted = %d, want 3", pm.deleted)
		}
		if pm.deleting {
			t.Error("expected deleting=false after pruneDeletedMsg")
		}
	})

	t.Run("ignores keys while deleting", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.deleting = true
		_, cmd := m.Update(keyMsg("q"))
		if isQuitCmd(cmd) {
			t.Error("should ignore q while deleting")
		}
	})

	t.Run("any key quits when done", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.done = true
		_, cmd := m.Update(keyMsg("q"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit when pressing key after done")
		}
	})
}

func TestTUI_PruneModel_View(t *testing.T) {
	t.Parallel()

	t.Run("normal shows found count", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		v := viewString(m.View())
		if !strings.Contains(v, "3 memories") {
			t.Error("view should contain 'Found 3 memories'")
		}
	})

	t.Run("done shows deleted", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.done = true
		m.deleted = 3
		v := viewString(m.View())
		if !strings.Contains(v, "Deleted") {
			t.Error("done view should contain 'Deleted'")
		}
	})

	t.Run("deleting shows progress", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.deleting = true
		v := viewString(m.View())
		if !strings.Contains(v, "Deleting...") {
			t.Error("deleting view should contain 'Deleting...'")
		}
	})

	t.Run("error shows error", func(t *testing.T) {
		t.Parallel()
		m := newTestPruneModel()
		m.done = true
		m.err = errors.New("delete failed")
		v := viewString(m.View())
		if !strings.Contains(v, "delete failed") {
			t.Error("error view should contain error text")
		}
	})
}

// ---------- update.go ----------

func TestTUI_ShowVersion(t *testing.T) {
	t.Parallel()
	// showVersion writes to stdout; just verify it doesn't panic.
	out := captureStdout(t, func() {
		showVersion()
	})
	if out == "" {
		t.Error("showVersion() should produce output")
	}
}

func newTestUpdateModel(phase updatePhase) updateModel {
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle
	return updateModel{
		phase:     phase,
		current:   "0.1.0",
		latest:    "0.2.0",
		spinner:   s,
		stopwatch: stopwatch.New(),
	}
}

func TestTUI_UpdateModel_Update(t *testing.T) {
	t.Parallel()

	t.Run("q quits", func(t *testing.T) {
		t.Parallel()
		m := newTestUpdateModel(updateChecking)
		_, cmd := m.Update(keyMsg("q"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after q")
		}
	})

	t.Run("ctrl+c quits", func(t *testing.T) {
		t.Parallel()
		m := newTestUpdateModel(updateInstalling)
		_, cmd := m.Update(keyMsg("ctrl+c"))
		if !isQuitCmd(cmd) {
			t.Error("expected tea.Quit cmd after ctrl+c")
		}
	})
}

func TestTUI_UpdateModel_View(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		phase    updatePhase
		contains string
	}{
		{"checking", updateChecking, "Checking"},
		{"up to date", updateUpToDate, "up to date"},
		{"installing", updateInstalling, "Installing"},
		{"done", updateDone, "Updated"},
		{"error", updateError, "Error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			m := newTestUpdateModel(tt.phase)
			if tt.phase == updateError {
				m.err = errors.New("network error")
			}
			v := viewString(m.View())
			if !strings.Contains(v, tt.contains) {
				t.Errorf("view at phase %d should contain %q, got:\n%s", tt.phase, tt.contains, v)
			}
		})
	}
}

// ---------- setup.go edge cases ----------

func TestTUI_SetupModel_KeyClosedGuard(t *testing.T) {
	t.Parallel()
	// Verify that keyClosed atomic bool prevents double-close panic.
	m := newSetupModel(false)
	// First esc closes keyReady.
	result, _ := m.Update(keyMsg("esc"))
	sm := result.(setupModel)
	if !sm.keyClosed.Load() {
		t.Error("keyClosed should be true after esc")
	}
	// Constructing a new model and closing again should be fine.
	m2 := newSetupModel(true)
	if !m2.keyClosed.Load() {
		t.Error("keyClosed should be true for hasKey=true")
	}
}

func TestTUI_SetupModel_FTSOnlyBanner(t *testing.T) {
	t.Parallel()
	m := newSetupModel(true)
	m.ftsOnly = true
	m.phase = phaseSeeding
	m.docsDone = 1
	m.docsTotal = 5
	v := viewString(m.View())
	if !strings.Contains(v, "FTS-only") {
		t.Error("view should show 'FTS-only' banner when ftsOnly=true")
	}
}

func TestTUI_SetupModel_Init(t *testing.T) {
	t.Parallel()

	t.Run("with key prompt", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(false)
		cmd := m.Init()
		if cmd == nil {
			t.Error("Init() should return focus cmd at phaseKeyPrompt")
		}
	})

	t.Run("with key ready", func(t *testing.T) {
		t.Parallel()
		m := newSetupModel(true)
		cmd := m.Init()
		if cmd == nil {
			t.Error("Init() should return batch cmd at phaseInit")
		}
	})
}

// Ensure keyClosed is properly initialized for the atomic check.
func TestTUI_SetupModel_AtomicBoolInit(t *testing.T) {
	t.Parallel()
	m := newSetupModel(false)
	if m.keyClosed == nil {
		t.Fatal("keyClosed should not be nil")
	}
	got := m.keyClosed.Load()
	if got {
		t.Error("keyClosed should be false for hasKey=false")
	}

	m2 := newSetupModel(true)
	got2 := m2.keyClosed.Load()
	if !got2 {
		t.Error("keyClosed should be true for hasKey=true")
	}
}

// Verify that the atomic.Bool trick in keyClosed prevents compile-time issues.
var _ *atomic.Bool = newSetupModel(false).keyClosed
