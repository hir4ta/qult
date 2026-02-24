package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// renderTable renders a markdown table block with box-drawing characters.
// availWidth is the available display width for the table.
func renderTable(lines []string, availWidth int) []string {
	if len(lines) == 0 {
		return nil
	}

	type tableRow struct {
		cells []string
		isSep bool
	}

	var rows []tableRow
	for _, line := range lines {
		cells := parseTableCells(line)
		rows = append(rows, tableRow{
			cells: cells,
			isSep: isTableSeparator(cells),
		})
	}

	// Determine column count from data rows
	numCols := 0
	for _, r := range rows {
		if !r.isSep && len(r.cells) > numCols {
			numCols = len(r.cells)
		}
	}
	if numCols == 0 {
		var result []string
		for _, line := range lines {
			result = append(result, applyInlineStyles(line, expandedTextStyle))
		}
		return result
	}

	// Calculate column widths
	colWidths := make([]int, numCols)
	for _, r := range rows {
		if r.isSep {
			continue
		}
		for j := 0; j < numCols && j < len(r.cells); j++ {
			w := lipgloss.Width(r.cells[j])
			if w > colWidths[j] {
				colWidths[j] = w
			}
		}
	}
	for i := range colWidths {
		if colWidths[i] < 1 {
			colWidths[i] = 1
		}
	}

	// Fit columns to available width.
	// Table border overhead: numCols+1 border chars (│).
	if availWidth > 0 {
		borderOverhead := numCols + 1
		contentSum := 0
		for _, w := range colWidths {
			contentSum += w
		}
		totalWidth := contentSum + borderOverhead
		availContent := availWidth - borderOverhead

		if totalWidth < availWidth {
			extra := availContent - contentSum
			perCol := extra / numCols
			remainder := extra % numCols
			for i := range colWidths {
				colWidths[i] += perCol
			}
			colWidths[numCols-1] += remainder
		} else if totalWidth > availWidth && availContent > numCols {
			for i := range colWidths {
				colWidths[i] = colWidths[i] * availContent / contentSum
				if colWidths[i] < 1 {
					colWidths[i] = 1
				}
			}
			used := 0
			for _, w := range colWidths {
				used += w
			}
			for i := len(colWidths) - 1; i >= 0 && used < availContent; i-- {
				colWidths[i]++
				used++
			}
		}
	}

	// Identify header rows (before first separator)
	headerEnd := -1
	for i, r := range rows {
		if r.isSep {
			headerEnd = i
			break
		}
	}

	var result []string

	// Top border
	result = append(result, mdTableBorderStyle.Render(tableBorderLine("┌", "┬", "┐", "─", colWidths)))

	for i, r := range rows {
		if r.isSep {
			result = append(result, mdTableBorderStyle.Render(tableBorderLine("├", "┼", "┤", "─", colWidths)))
			continue
		}
		isHeader := headerEnd > 0 && i < headerEnd
		result = append(result, tableDataRows(r.cells, colWidths, numCols, isHeader)...)
	}

	// Bottom border
	result = append(result, mdTableBorderStyle.Render(tableBorderLine("└", "┴", "┘", "─", colWidths)))

	return result
}

func parseTableCells(line string) []string {
	line = strings.TrimSpace(line)
	if strings.HasPrefix(line, "|") {
		line = line[1:]
	}
	if strings.HasSuffix(line, "|") {
		line = line[:len(line)-1]
	}
	parts := strings.Split(line, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func isTableSeparator(cells []string) bool {
	if len(cells) == 0 {
		return false
	}
	hasDashes := false
	for _, cell := range cells {
		trimmed := strings.TrimSpace(cell)
		if trimmed == "" {
			continue
		}
		t := strings.TrimLeft(trimmed, ":")
		t = strings.TrimRight(t, ":")
		if len(t) == 0 || strings.Trim(t, "-") != "" {
			return false
		}
		hasDashes = true
	}
	return hasDashes
}

func tableBorderLine(left, mid, right, fill string, colWidths []int) string {
	var b strings.Builder
	b.WriteString(left)
	for i, w := range colWidths {
		b.WriteString(strings.Repeat(fill, w))
		if i < len(colWidths)-1 {
			b.WriteString(mid)
		}
	}
	b.WriteString(right)
	return b.String()
}

// tableDataRows renders a single logical table row as one or more visual lines.
// Cells wider than their column are wrapped onto continuation lines.
func tableDataRows(cells []string, colWidths []int, numCols int, isHeader bool) []string {
	wrapped := make([][]string, numCols)
	maxLines := 1
	for j := 0; j < numCols; j++ {
		cell := ""
		if j < len(cells) {
			cell = cells[j]
		}
		w := colWidths[j]
		if lipgloss.Width(cell) <= w {
			wrapped[j] = []string{cell}
		} else {
			wrapped[j] = wrapCellText(cell, w)
		}
		if len(wrapped[j]) > maxLines {
			maxLines = len(wrapped[j])
		}
	}

	var result []string
	for line := 0; line < maxLines; line++ {
		var b strings.Builder
		b.WriteString(mdTableBorderStyle.Render("│"))
		for j := 0; j < numCols; j++ {
			cell := ""
			if line < len(wrapped[j]) {
				cell = wrapped[j][line]
			}
			w := lipgloss.Width(cell)
			padding := colWidths[j] - w
			if padding < 0 {
				padding = 0
			}
			if isHeader {
				b.WriteString(mdTableHeaderStyle.Render(cell))
			} else {
				b.WriteString(mdTableCellStyle.Render(cell))
			}
			if padding > 0 {
				b.WriteString(strings.Repeat(" ", padding))
			}
			b.WriteString(mdTableBorderStyle.Render("│"))
		}
		result = append(result, b.String())
	}
	return result
}

// wrapCellText breaks a cell string into lines fitting within maxWidth.
func wrapCellText(s string, maxWidth int) []string {
	if maxWidth <= 0 {
		return []string{""}
	}
	if lipgloss.Width(s) <= maxWidth {
		return []string{s}
	}

	words := strings.Fields(s)
	if len(words) == 0 {
		return []string{""}
	}

	var result []string
	line := words[0]
	for _, w := range words[1:] {
		if lipgloss.Width(line)+1+lipgloss.Width(w) <= maxWidth {
			line += " " + w
		} else {
			result = append(result, breakCellLine(line, maxWidth)...)
			line = w
		}
	}
	result = append(result, breakCellLine(line, maxWidth)...)
	return result
}

// breakCellLine splits a single (no-space) segment into lines of maxWidth.
func breakCellLine(s string, maxWidth int) []string {
	if lipgloss.Width(s) <= maxWidth {
		return []string{s}
	}
	var result []string
	runes := []rune(s)
	cur := 0
	start := 0
	for i, r := range runes {
		rw := lipgloss.Width(string(r))
		if cur+rw > maxWidth {
			result = append(result, string(runes[start:i]))
			start = i
			cur = 0
		}
		cur += rw
	}
	if start < len(runes) {
		result = append(result, string(runes[start:]))
	}
	return result
}
