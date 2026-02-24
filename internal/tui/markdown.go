package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// renderMarkdown converts markdown text to pre-styled terminal lines.
// Returned lines already have ANSI styling — do NOT wrap with expandedTextStyle.
func renderMarkdown(text string, width int) []string {
	if width <= 0 {
		width = 80
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	rawLines := strings.Split(text, "\n")

	var result []string
	i := 0
	for i < len(rawLines) {
		line := rawLines[i]
		trimmed := strings.TrimSpace(line)

		// Code block (``` fenced)
		if strings.HasPrefix(trimmed, "```") {
			i++
			var block []string
			for i < len(rawLines) {
				if strings.HasPrefix(strings.TrimSpace(rawLines[i]), "```") {
					i++
					break
				}
				block = append(block, rawLines[i])
				i++
			}
			for _, bl := range block {
				result = append(result, mdCodeBlockStyle.Render("  "+bl))
			}
			continue
		}

		// Horizontal rule: ---, ***, ___  (3+ chars, optional spaces)
		if isHorizontalRule(trimmed) {
			ruleWidth := width
			if ruleWidth > 0 {
				result = append(result, mdHorizontalRuleStyle.Render(strings.Repeat("─", ruleWidth)))
			}
			i++
			continue
		}

		// Table block: consecutive lines starting with |
		if strings.HasPrefix(trimmed, "|") {
			var tableLines []string
			for i < len(rawLines) && strings.HasPrefix(strings.TrimSpace(rawLines[i]), "|") {
				tableLines = append(tableLines, rawLines[i])
				i++
			}
			result = append(result, renderTable(tableLines, width)...)
			continue
		}

		// Headers
		if _, title := parseMdHeader(trimmed); title != "" {
			result = append(result, applyInlineStyles(title, mdHeaderStyle))
			i++
			continue
		}

		// Bullet list
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			content := trimmed[2:]
			wrapped := wrapText(content, width-2)
			if len(wrapped) == 0 {
				result = append(result, mdBulletStyle.Render("•"))
			} else {
				result = append(result, mdBulletStyle.Render("•")+" "+applyInlineStyles(wrapped[0], expandedTextStyle))
				for _, wl := range wrapped[1:] {
					result = append(result, "  "+applyInlineStyles(wl, expandedTextStyle))
				}
			}
			i++
			continue
		}

		// Empty line
		if trimmed == "" {
			result = append(result, "")
			i++
			continue
		}

		// Plain text with word wrap
		wrapped := wrapText(line, width)
		for _, wl := range wrapped {
			result = append(result, applyInlineStyles(wl, expandedTextStyle))
		}
		i++
	}

	return result
}

// applyInlineStyles processes **bold** and `code` markers within a line.
func applyInlineStyles(text string, baseStyle lipgloss.Style) string {
	runes := []rune(text)
	if len(runes) == 0 {
		return ""
	}

	var result strings.Builder
	i := 0
	normalStart := 0

	for i < len(runes) {
		// Inline code: `...`
		if runes[i] == '`' {
			j := i + 1
			for j < len(runes) && runes[j] != '`' {
				j++
			}
			if j < len(runes) {
				if normalStart < i {
					result.WriteString(baseStyle.Render(string(runes[normalStart:i])))
				}
				result.WriteString(mdInlineCodeStyle.Render(string(runes[i+1 : j])))
				i = j + 1
				normalStart = i
				continue
			}
		}

		// Bold: **...**
		if i+1 < len(runes) && runes[i] == '*' && runes[i+1] == '*' {
			j := i + 2
			for j+1 < len(runes) {
				if runes[j] == '*' && runes[j+1] == '*' {
					break
				}
				j++
			}
			if j+1 < len(runes) && runes[j] == '*' && runes[j+1] == '*' {
				if normalStart < i {
					result.WriteString(baseStyle.Render(string(runes[normalStart:i])))
				}
				result.WriteString(mdBoldStyle.Render(string(runes[i+2 : j])))
				i = j + 2
				normalStart = i
				continue
			}
		}

		i++
	}

	if normalStart < len(runes) {
		result.WriteString(baseStyle.Render(string(runes[normalStart:])))
	}

	return result.String()
}

func parseMdHeader(line string) (int, string) {
	for level := 6; level >= 1; level-- {
		prefix := strings.Repeat("#", level) + " "
		if strings.HasPrefix(line, prefix) {
			return level, strings.TrimPrefix(line, prefix)
		}
	}
	return 0, ""
}

// isHorizontalRule checks if a trimmed line is a markdown horizontal rule.
func isHorizontalRule(trimmed string) bool {
	if len(trimmed) < 3 {
		return false
	}
	stripped := strings.ReplaceAll(trimmed, " ", "")
	if len(stripped) < 3 {
		return false
	}
	ch := stripped[0]
	if ch != '-' && ch != '*' && ch != '_' {
		return false
	}
	for i := 1; i < len(stripped); i++ {
		if stripped[i] != ch {
			return false
		}
	}
	return true
}
