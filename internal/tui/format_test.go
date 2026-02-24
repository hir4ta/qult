package tui

import (
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func TestHumanizeAgeEn(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{0, "just now"},
		{30 * time.Second, "just now"},
		{5 * time.Minute, "5m ago"},
		{59 * time.Minute, "59m ago"},
		{1 * time.Hour, "1h ago"},
		{3 * time.Hour, "3h ago"},
		{23 * time.Hour, "23h ago"},
		{24 * time.Hour, "1d ago"},
		{3 * 24 * time.Hour, "3d ago"},
		{6 * 24 * time.Hour, "6d ago"},
		{7 * 24 * time.Hour, "1w ago"},
		{14 * 24 * time.Hour, "2w ago"},
		{21 * 24 * time.Hour, "3w ago"},
	}
	for _, tt := range tests {
		got := humanizeAge(tt.d, false)
		if got != tt.want {
			t.Errorf("humanizeAge(%v, false) = %q, want %q", tt.d, got, tt.want)
		}
	}

	// >= 30 days should return MM/DD format
	got := humanizeAge(60*24*time.Hour, false)
	if len(got) != 5 || got[2] != '/' {
		t.Errorf("humanizeAge(60d, false) = %q, want MM/DD format", got)
	}
}

func TestHumanizeAgeJa(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{0, "たった今"},
		{30 * time.Second, "たった今"},
		{5 * time.Minute, "5分前"},
		{59 * time.Minute, "59分前"},
		{1 * time.Hour, "1時間前"},
		{3 * time.Hour, "3時間前"},
		{24 * time.Hour, "1日前"},
		{3 * 24 * time.Hour, "3日前"},
		{7 * 24 * time.Hour, "1週間前"},
		{14 * 24 * time.Hour, "2週間前"},
	}
	for _, tt := range tests {
		got := humanizeAge(tt.d, true)
		if got != tt.want {
			t.Errorf("humanizeAge(%v, true) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

func TestWrapTextCJK(t *testing.T) {
	// Each CJK char takes 2 terminal columns.
	// 10 CJK chars = 20 columns visual width.
	cjk := "あいうえおかきくけこ" // 10 chars = 20 columns
	lines := wrapText(cjk+" "+cjk, 25)
	// 20 + 1 + 20 = 41 columns, should wrap at width 25
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %v", len(lines), lines)
	}
	if lipgloss.Width(lines[0]) > 25 {
		t.Errorf("line 0 visual width %d > 25", lipgloss.Width(lines[0]))
	}
}

func TestBreakLineCJK(t *testing.T) {
	// A single "word" (no spaces) of 20 CJK chars = 40 columns
	long := "あいうえおかきくけこさしすせそたちつてと"
	lines := breakLine(long, 20)
	for i, l := range lines {
		w := lipgloss.Width(l)
		if w > 20 {
			t.Errorf("breakLine[%d] visual width %d > 20: %q", i, w, l)
		}
	}
	if len(lines) < 2 {
		t.Errorf("expected at least 2 lines, got %d", len(lines))
	}
}

func TestWrapTextASCII(t *testing.T) {
	// ASCII should still work correctly
	lines := wrapText("hello world foo bar baz", 12)
	for _, l := range lines {
		if lipgloss.Width(l) > 12 {
			t.Errorf("line visual width %d > 12: %q", lipgloss.Width(l), l)
		}
	}
}
