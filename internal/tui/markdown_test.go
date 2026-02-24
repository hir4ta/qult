package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestParseTableCells(t *testing.T) {
	tests := []struct {
		line string
		want []string
	}{
		{"| foo | bar |", []string{"foo", "bar"}},
		{"| foo | bar", []string{"foo", "bar"}},
		{"foo | bar |", []string{"foo", "bar"}},
		{"| a | b | c |", []string{"a", "b", "c"}},
		{"| スタック | 説明 |", []string{"スタック", "説明"}},
	}
	for _, tt := range tests {
		got := parseTableCells(tt.line)
		if len(got) != len(tt.want) {
			t.Errorf("parseTableCells(%q) = %v (len %d), want %v (len %d)",
				tt.line, got, len(got), tt.want, len(tt.want))
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("parseTableCells(%q)[%d] = %q, want %q", tt.line, i, got[i], tt.want[i])
			}
		}
	}
}

func TestIsTableSeparator(t *testing.T) {
	tests := []struct {
		cells []string
		want  bool
	}{
		{[]string{"---", "---"}, true},
		{[]string{":---", "---:"}, true},
		{[]string{":---:", "---"}, true},
		{[]string{"----", "---", "------"}, true},
		{[]string{"foo", "bar"}, false},
		{[]string{""}, false},
		{nil, false},
		{[]string{"::"}, false},
	}
	for _, tt := range tests {
		got := isTableSeparator(tt.cells)
		if got != tt.want {
			t.Errorf("isTableSeparator(%v) = %v, want %v", tt.cells, got, tt.want)
		}
	}
}

func TestRenderTable(t *testing.T) {
	lines := []string{
		"| Name | Value |",
		"|------|-------|",
		"| foo  | bar   |",
		"| baz  | qux   |",
	}

	result := renderTable(lines, 0)
	// top border + header + separator + 2 data rows + bottom border = 6 lines
	if len(result) != 6 {
		t.Fatalf("expected 6 lines, got %d:\n%s", len(result), strings.Join(result, "\n"))
	}

	// Check box-drawing characters exist
	joined := strings.Join(result, "\n")
	for _, ch := range []string{"┌", "┬", "┐", "├", "┼", "┤", "└", "┴", "┘", "│", "─"} {
		if !strings.Contains(joined, ch) {
			t.Errorf("missing box-drawing character %q in:\n%s", ch, joined)
		}
	}
}

func TestRenderTableCJK(t *testing.T) {
	lines := []string{
		"| パッケージ | 役割 |",
		"|-----------|------|",
		"| parser | JSONL パーサー |",
	}

	result := renderTable(lines, 0)
	// top + header + sep + data + bottom = 5
	if len(result) != 5 {
		t.Fatalf("expected 5 lines, got %d:\n%s", len(result), strings.Join(result, "\n"))
	}

	joined := strings.Join(result, "\n")
	if !strings.Contains(joined, "パッケージ") {
		t.Error("missing CJK header text")
	}
	if !strings.Contains(joined, "JSONL パーサー") {
		t.Error("missing CJK data text")
	}
}

func TestRenderTableNoSeparator(t *testing.T) {
	// Table without separator row → no header styling but still box-drawn
	lines := []string{
		"| a | b |",
		"| c | d |",
	}

	result := renderTable(lines, 0)
	// top + 2 data + bottom = 4
	if len(result) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(result))
	}
}

func TestParseMdHeader(t *testing.T) {
	tests := []struct {
		line      string
		wantLevel int
		wantTitle string
	}{
		{"# Title", 1, "Title"},
		{"## Subtitle", 2, "Subtitle"},
		{"### Third", 3, "Third"},
		{"Not a header", 0, ""},
		{"#NoSpace", 0, ""},
	}
	for _, tt := range tests {
		level, title := parseMdHeader(tt.line)
		if level != tt.wantLevel || title != tt.wantTitle {
			t.Errorf("parseMdHeader(%q) = (%d, %q), want (%d, %q)",
				tt.line, level, title, tt.wantLevel, tt.wantTitle)
		}
	}
}

func TestRenderMarkdownHeaders(t *testing.T) {
	text := "# Title\n## Subtitle\nPlain text"
	lines := renderMarkdown(text, 80)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "Title") {
		t.Errorf("header line should contain 'Title', got %q", lines[0])
	}
}

func TestRenderMarkdownCodeBlock(t *testing.T) {
	text := "```\nfoo\nbar\n```"
	lines := renderMarkdown(text, 80)
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines (code block content), got %d", len(lines))
	}
	if !strings.Contains(lines[0], "foo") {
		t.Errorf("code line should contain 'foo', got %q", lines[0])
	}
}

func TestRenderMarkdownBullets(t *testing.T) {
	text := "- item one\n- item two\n* item three"
	lines := renderMarkdown(text, 80)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	for i, line := range lines {
		if !strings.Contains(line, "•") {
			t.Errorf("line[%d] should contain bullet '•', got %q", i, line)
		}
	}
}

func TestRenderMarkdownPlainText(t *testing.T) {
	text := "Hello world"
	lines := renderMarkdown(text, 80)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "Hello world") {
		t.Errorf("should contain 'Hello world', got %q", lines[0])
	}
}

func TestRenderMarkdownMixed(t *testing.T) {
	text := "# My Table\n\n| Col1 | Col2 |\n|------|------|\n| a    | b    |\n\nSome text after."
	lines := renderMarkdown(text, 80)

	// Should have: header(1) + empty(1) + table(5) + empty(1) + text(1) = 9
	if len(lines) < 7 {
		t.Fatalf("expected at least 7 lines, got %d:\n%s", len(lines), strings.Join(lines, "\n"))
	}

	hasBox := false
	for _, line := range lines {
		if strings.Contains(line, "┌") {
			hasBox = true
			break
		}
	}
	if !hasBox {
		t.Error("mixed content should contain table with box-drawing characters")
	}
}

func TestRenderMarkdownEmpty(t *testing.T) {
	lines := renderMarkdown("", 80)
	if len(lines) != 1 {
		t.Fatalf("expected 1 empty line, got %d", len(lines))
	}
}

func TestApplyInlineStylesBold(t *testing.T) {
	result := applyInlineStyles("hello **world** end", expandedTextStyle)
	if !strings.Contains(result, "world") {
		t.Errorf("should contain bold text 'world', got %q", result)
	}
	// Bold markers should be consumed (not appear in output)
	if strings.Contains(result, "**") {
		t.Errorf("should not contain raw ** markers, got %q", result)
	}
}

func TestApplyInlineStylesCode(t *testing.T) {
	result := applyInlineStyles("use `fmt.Println` here", expandedTextStyle)
	if !strings.Contains(result, "fmt.Println") {
		t.Errorf("should contain code text 'fmt.Println', got %q", result)
	}
	if strings.Contains(result, "`") {
		t.Errorf("should not contain raw backtick, got %q", result)
	}
}

func TestApplyInlineStylesMixed(t *testing.T) {
	result := applyInlineStyles("**bold** and `code` text", expandedTextStyle)
	if !strings.Contains(result, "bold") {
		t.Error("should contain bold text")
	}
	if !strings.Contains(result, "code") {
		t.Error("should contain code text")
	}
	if strings.Contains(result, "**") || strings.Contains(result, "`") {
		t.Errorf("should not contain raw markers, got %q", result)
	}
}

func TestApplyInlineStylesNoMarkers(t *testing.T) {
	result := applyInlineStyles("plain text", expandedTextStyle)
	if !strings.Contains(result, "plain text") {
		t.Errorf("should contain 'plain text', got %q", result)
	}
}

func TestApplyInlineStylesUnmatched(t *testing.T) {
	// Unmatched markers should be preserved as-is
	result := applyInlineStyles("open **bold no close", expandedTextStyle)
	if !strings.Contains(result, "**") {
		t.Errorf("unmatched ** should be preserved, got %q", result)
	}

	result2 := applyInlineStyles("open `code no close", expandedTextStyle)
	if !strings.Contains(result2, "`") {
		t.Errorf("unmatched backtick should be preserved, got %q", result2)
	}
}

func TestApplyInlineStylesEmpty(t *testing.T) {
	result := applyInlineStyles("", expandedTextStyle)
	if result != "" {
		t.Errorf("empty input should return empty, got %q", result)
	}
}

func TestRenderMarkdownInlineFormatting(t *testing.T) {
	text := "This has **bold** and `code` inline"
	lines := renderMarkdown(text, 80)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if strings.Contains(lines[0], "**") {
		t.Errorf("rendered line should not contain raw **, got %q", lines[0])
	}
	if strings.Contains(lines[0], "`") {
		t.Errorf("rendered line should not contain raw backtick, got %q", lines[0])
	}
}

func TestTableBorderLine(t *testing.T) {
	result := tableBorderLine("┌", "┬", "┐", "─", []int{5, 3})
	expected := "┌─────┬───┐"
	if result != expected {
		t.Errorf("tableBorderLine = %q, want %q", result, expected)
	}
}

func TestIsHorizontalRule(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"---", true},
		{"***", true},
		{"___", true},
		{"----", true},
		{"- - -", true},
		{"* * *", true},
		{"_ _ _", true},
		{"--", false},
		{"", false},
		{"--- text", false},
		{"abc", false},
		{"-*-", false},
	}
	for _, tt := range tests {
		got := isHorizontalRule(tt.input)
		if got != tt.want {
			t.Errorf("isHorizontalRule(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestRenderMarkdownHorizontalRule(t *testing.T) {
	text := "above\n\n---\n\nbelow"
	lines := renderMarkdown(text, 40)

	// Find the horizontal rule line
	found := false
	for _, line := range lines {
		if strings.Contains(line, "─") && !strings.Contains(line, "---") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected rendered horizontal rule with ─, got:\n%s", strings.Join(lines, "\n"))
	}
}

func TestRenderTableDynamicWidth(t *testing.T) {
	lines := []string{
		"| A | B |",
		"|---|---|",
		"| x | y |",
	}

	// With width=0 (no expansion), table fits content
	narrow := renderTable(lines, 0)

	// With width=60, table should expand to fill
	wide := renderTable(lines, 60)

	// The wide table's border line should be wider
	narrowTop := narrow[0]
	wideTop := wide[0]

	narrowW := lipgloss.Width(narrowTop)
	wideW := lipgloss.Width(wideTop)

	if wideW <= narrowW {
		t.Errorf("wide table (%d) should be wider than narrow table (%d)", wideW, narrowW)
	}
	if wideW != 60 {
		t.Errorf("wide table width = %d, want 60", wideW)
	}

	// ALL lines (border and data) must have the same width
	for i, line := range wide {
		w := lipgloss.Width(line)
		if w != 60 {
			t.Errorf("wide table line[%d] width = %d, want 60: %q", i, w, line)
		}
	}
}

func TestRenderTableAllLinesConsistent(t *testing.T) {
	// Reproduce the user's MCP tools table scenario
	lines := []string{
		"| ツール | 機能 |",
		"|---|---|",
		"| `buddy_stats` | セッション統計（ターン数、ツール頻度、経過時間） |",
		"| `buddy_resume` | **セッション復帰**: 直近の要約、最後のやりとり、決定事項、変更ファイルをまとめて返却 |",
		"| `buddy_recall` | **コンパクト前の履歴を FTS5 検索** で呼び戻し |",
	}

	targetWidth := 90
	result := renderTable(lines, targetWidth)

	for i, line := range result {
		w := lipgloss.Width(line)
		if w > targetWidth {
			t.Errorf("line[%d] width %d exceeds target %d: %q", i, w, targetWidth, line)
		}
	}
}

func TestRenderTableCellWrap(t *testing.T) {
	lines := []string{
		"| Key | Description |",
		"|-----|-------------|",
		"| foo | This is a very long description that should wrap to multiple lines in a narrow table |",
	}

	result := renderTable(lines, 40)

	// Should have multiple visual lines for the data row (cell wraps)
	// top + header + sep + data(multi) + bottom
	if len(result) <= 5 {
		t.Logf("table output:\n%s", strings.Join(result, "\n"))
		t.Errorf("expected >5 lines (cell wrap), got %d", len(result))
	}

	// All lines must fit within target width
	for i, line := range result {
		w := lipgloss.Width(line)
		if w > 40 {
			t.Errorf("line[%d] width %d exceeds 40: %q", i, w, line)
		}
	}

	// Wrapped continuation lines should have empty first column
	// (first col shows "foo" only on first line, blank on subsequent)
	foundWrap := false
	for _, line := range result {
		if strings.Contains(line, "│") && !strings.Contains(line, "─") {
			// Data row - check if first cell is blank (continuation)
			if strings.Contains(line, "│   ") || strings.Contains(line, "│ ") {
				foundWrap = true
			}
		}
	}
	if !foundWrap {
		t.Log("table output:")
		for _, l := range result {
			t.Log(l)
		}
		t.Error("expected to find wrapped continuation lines with empty first column")
	}
}

func TestRenderTableInBox(t *testing.T) {
	// Simulate the expanded box rendering
	tableLines := []string{
		"| Name | Value |",
		"|------|-------|",
		"| foo  | bar   |",
	}

	contentWidth := 80
	rendered := renderTable(tableLines, contentWidth)

	// Simulate what the box does: wrap content at boxWidth
	boxWidth := contentWidth + 2 // matches expandedBoxStyle.Width(contentWidth + 2)
	paddingLeft := 1

	for i, line := range rendered {
		w := lipgloss.Width(line)
		availableInBox := boxWidth - paddingLeft
		if w > availableInBox {
			t.Errorf("table line[%d] width %d exceeds box available %d (boxWidth=%d, padding=%d)",
				i, w, availableInBox, boxWidth, paddingLeft)
		}
	}
}
