package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// humanizeAge formats a duration into a short, human-friendly string.
func humanizeAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dw ago", int(d.Hours()/(24*7)))
	default:
		return time.Now().Add(-d).Format("01/02")
	}
}

func truncateID(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// formatDuration formats a duration as human-readable compact text.
// Examples: "3m", "1h08m", "2d5h", "1w3d"
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return "0m"
	}
	totalMin := int(d.Minutes())
	switch {
	case totalMin < 60:
		return fmt.Sprintf("%dm", totalMin)
	case totalMin < 60*24:
		h := totalMin / 60
		m := totalMin % 60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh%02dm", h, m)
	case totalMin < 60*24*7:
		days := totalMin / (60 * 24)
		hours := (totalMin % (60 * 24)) / 60
		if hours == 0 {
			return fmt.Sprintf("%dd", days)
		}
		return fmt.Sprintf("%dd%dh", days, hours)
	default:
		weeks := totalMin / (60 * 24 * 7)
		days := (totalMin % (60 * 24 * 7)) / (60 * 24)
		if days == 0 {
			return fmt.Sprintf("%dw", weeks)
		}
		return fmt.Sprintf("%dw%dd", weeks, days)
	}
}

func wrapText(s string, width int) []string {
	if width <= 0 {
		width = 80
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var result []string
	for _, paragraph := range strings.Split(s, "\n") {
		if paragraph == "" {
			result = append(result, "")
			continue
		}
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			result = append(result, "")
			continue
		}
		line := words[0]
		for _, w := range words[1:] {
			if lipgloss.Width(line)+1+lipgloss.Width(w) > width {
				result = append(result, breakLine(line, width)...)
				line = w
			} else {
				line += " " + w
			}
		}
		result = append(result, breakLine(line, width)...)
	}
	return result
}

// breakLine splits a single line into multiple lines if it exceeds width.
// Handles CJK characters that occupy 2 terminal columns per rune.
func breakLine(s string, width int) []string {
	if lipgloss.Width(s) <= width {
		return []string{s}
	}
	var lines []string
	runes := []rune(s)
	start := 0
	w := 0
	for i, r := range runes {
		rw := lipgloss.Width(string(r))
		if w+rw > width && i > start {
			lines = append(lines, string(runes[start:i]))
			start = i
			w = 0
		}
		w += rw
	}
	if start < len(runes) {
		lines = append(lines, string(runes[start:]))
	}
	return lines
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
