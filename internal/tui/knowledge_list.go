package tui

import (
	"fmt"
	"io"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/list"
	tea "charm.land/bubbletea/v2"
)

// knowledgeItem wraps KnowledgeEntry to implement list.Item and list.DefaultItem.
type knowledgeItem struct {
	entry KnowledgeEntry
}

func (i knowledgeItem) FilterValue() string {
	return i.entry.Label + " " + i.entry.Content
}

func (i knowledgeItem) Title() string {
	return extractKnowledgeTitle(i.entry)
}

func (i knowledgeItem) Description() string {
	_, ctx := simplifyKnowledgeLabel(i.entry.Label)
	return ctx
}

// knowledgeDelegate renders knowledge items with enabled/disabled state and sub_type tags.
type knowledgeDelegate struct{}

func (d knowledgeDelegate) Height() int  { return 2 }
func (d knowledgeDelegate) Spacing() int { return 0 }

func (d knowledgeDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }

func (d knowledgeDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	ki, ok := item.(knowledgeItem)
	if !ok {
		return
	}
	k := ki.entry

	isSelected := index == m.Index()

	// Enabled/disabled checkbox.
	enabledMark := "[x] "
	if !k.Enabled {
		enabledMark = "[ ] "
	}

	title := ki.Title()
	maxTitle := m.Width() - 36
	if maxTitle < 20 {
		maxTitle = 20
	}
	title = truncStr(title, maxTitle)

	// Sub_type tag + age.
	subTag := styledSubType(k.SubType)
	age := dimStyle.Render(formatDuration(k.Age))
	scoreStr := ""
	if k.Score > 0 {
		scoreStr = scoreStyle.Render(fmt.Sprintf("%3.0f%%", k.Score*100)) + " "
	}
	hitStr := ""
	if k.HitCount > 0 {
		hitStr = " " + hitCountStyle.Render(fmt.Sprintf("x%d", k.HitCount))
	}

	// Context line.
	ctx := ki.Description()

	if isSelected {
		prefix := "> " + enabledMark
		line1 := titleStyle.Render(prefix) + scoreStr + titleStyle.Render(title) + "  " + subTag + "  " + age + hitStr
		fmt.Fprintln(w, line1)
		if ctx != "" {
			fmt.Fprintln(w, "      "+dimStyle.Render(ctx))
		} else {
			fmt.Fprintln(w)
		}
	} else if !k.Enabled {
		prefix := "  " + enabledMark
		line := prefix + scoreStr + title + "  " + subTag + "  " + age + hitStr
		fmt.Fprintln(w, dimStyle.Render(line))
		fmt.Fprintln(w) // spacing for 2-line height
	} else {
		prefix := "  " + enabledMark
		line1 := prefix + scoreStr + title + "  " + subTag + "  " + age + hitStr
		fmt.Fprintln(w, line1)
		if ctx != "" {
			fmt.Fprintln(w, "      "+dimStyle.Render(ctx))
		} else {
			fmt.Fprintln(w)
		}
	}
}

// knowledgeToggleKey is the key binding for toggling enabled/disabled.
var knowledgeToggleKey = key.NewBinding(
	key.WithKeys(" ", "space"),
	key.WithHelp("space", "toggle"),
)

// newKnowledgeList creates a configured list.Model for the Knowledge tab.
func newKnowledgeList(width, height int) list.Model {
	delegate := knowledgeDelegate{}
	l := list.New(nil, delegate, width, height)
	l.SetShowTitle(false)
	l.SetShowHelp(false)
	l.SetShowStatusBar(true)
	l.SetFilteringEnabled(true)
	l.SetShowFilter(true)

	l.FilterInput.Placeholder = "search knowledge..."

	return l
}

// knowledgeEntriesToItems converts KnowledgeEntry slice to list.Item slice.
func knowledgeEntriesToItems(entries []KnowledgeEntry) []list.Item {
	items := make([]list.Item, len(entries))
	for i, e := range entries {
		items[i] = knowledgeItem{entry: e}
	}
	return items
}

// updateKnowledgeListItems refreshes the list items from the data source.
func (m *Model) updateKnowledgeListItems() {
	entries := m.ds.RecentKnowledge(100)
	m.knowledge = entries
	items := knowledgeEntriesToItems(entries)
	m.knList.SetItems(items)
}

// syncKnowledgeItemEnabled updates a single item's enabled state in the list.
func (m *Model) syncKnowledgeItemEnabled(index int, enabled bool) {
	if index >= len(m.knowledge) {
		return
	}
	m.knowledge[index].Enabled = enabled
	items := m.knList.Items()
	if index < len(items) {
		ki := items[index].(knowledgeItem)
		ki.entry.Enabled = enabled
		m.knList.SetItem(index, ki)
	}
}

// knowledgeListView renders the Knowledge tab using the list component.
func (m *Model) knowledgeListView() string {
	var b strings.Builder
	b.WriteString("\n")

	// Stats header — count from actual list items for consistency.
	items := m.knList.Items()
	if len(items) > 0 {
		dec, pat, rul, gen := 0, 0, 0, 0
		for _, it := range items {
			if ki, ok := it.(knowledgeItem); ok {
				switch ki.entry.SubType {
				case "decision":
					dec++
				case "pattern":
					pat++
				case "rule":
					rul++
				default:
					gen++
				}
			}
		}
		b.WriteString("  " + sectionHeader.Render("Stats") + "\n")
		fmt.Fprintf(&b, "  Total: %d  |  decision: %d  pattern: %d  rule: %d  general: %d\n\n",
			len(items), dec, pat, rul, gen)
	}

	// List component handles everything: filtering, pagination, cursor.
	b.WriteString(m.knList.View())

	return b.String()
}
