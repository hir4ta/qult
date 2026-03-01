package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// viewKnowledge renders the Knowledge tab showing docs statistics.
func (m Model) viewKnowledge() string {
	if m.st == nil {
		return dimStyle.Render("  Store not available. Run 'claude-alfred install' first.")
	}
	if m.knTotal == 0 {
		return dimStyle.Render("  No knowledge base entries. Run 'claude-alfred install' to sync.")
	}

	var lines []string

	lines = append(lines, "")
	lines = append(lines, "  "+tabLabelStyle.Render("Total Sections")+"  "+tabValueStyle.Render(fmt.Sprintf("%d", m.knTotal)))

	// Source breakdown
	if len(m.knBySource) > 0 {
		lines = append(lines, "")
		lines = append(lines, "  "+tabLabelStyle.Render("By Source"))
		for src, count := range m.knBySource {
			lines = append(lines, "    "+dimStyle.Render(src)+": "+tabValueStyle.Render(fmt.Sprintf("%d", count)))
		}
	}

	if m.knLastCrawl != "" {
		lines = append(lines, "")
		lines = append(lines, "  "+tabLabelStyle.Render("Last Crawled")+"  "+tabValueStyle.Render(m.knLastCrawl))
	}

	if m.knVersion != "" {
		lines = append(lines, "  "+tabLabelStyle.Render("Latest Version")+"  "+tabValueStyle.Render(m.knVersion))
	}

	return strings.Join(lines, "\n")
}

// viewPreferences renders the Preferences tab showing user profile.
func (m Model) viewPreferences() string {
	if m.st == nil {
		return dimStyle.Render("  Store not available. Run 'claude-alfred install' first.")
	}

	var lines []string
	lines = append(lines, "")

	// Cluster
	cluster := m.pfCluster
	if cluster == "" {
		cluster = "unknown"
	}
	lines = append(lines, "  "+tabLabelStyle.Render("Cluster")+"  "+tabValueStyle.Render(cluster))

	// EWMA Metrics
	if len(m.pfMetrics) > 0 {
		lines = append(lines, "")
		lines = append(lines, "  "+tabLabelStyle.Render("Profile Metrics"))

		// Table header
		nameW := 24
		header := fmt.Sprintf("    %-*s  %8s  %7s", nameW, "Metric", "Value", "Samples")
		lines = append(lines, dimStyle.Render(header))
		lines = append(lines, dimStyle.Render("    "+strings.Repeat("\u2500", nameW+20)))

		for _, m := range m.pfMetrics {
			name := m.MetricName
			if lipgloss.Width(name) > nameW {
				name = name[:nameW-1] + "\u2026"
			}
			row := fmt.Sprintf("    %-*s  %8.2f  %7d", nameW, name, m.EWMAValue, m.SampleCount)
			lines = append(lines, tabValueStyle.Render(row))
		}
	}

	// Feature Usage
	if len(m.pfFeatures) > 0 {
		lines = append(lines, "")
		lines = append(lines, "  "+tabLabelStyle.Render("Feature Usage"))
		for _, key := range []string{"plan_mode", "worktree", "agent", "skill", "team"} {
			p, ok := m.pfFeatures[key]
			if !ok {
				continue
			}
			lines = append(lines, fmt.Sprintf("    %s: %s",
				dimStyle.Render(key),
				tabValueStyle.Render(fmt.Sprintf("%d uses (effectiveness: %.1f%%)", p.DeliveryCount, p.EffectivenessScore*100)),
			))
		}
	}

	return strings.Join(lines, "\n")
}

// viewDocs renders the Docs tab with search and results.
func (m Model) viewDocs() string {
	if m.st == nil {
		return dimStyle.Render("  Store not available. Run 'claude-alfred install' first.")
	}

	var lines []string
	lines = append(lines, "")

	// Search input
	if m.docsSearching {
		lines = append(lines, "  "+tabLabelStyle.Render("/")+tabValueStyle.Render(m.docsQuery)+cursorStyle.Render("\u2588"))
	} else if m.docsQuery != "" {
		lines = append(lines, "  "+dimStyle.Render("Search: ")+tabValueStyle.Render(m.docsQuery))
	} else {
		lines = append(lines, "  "+dimStyle.Render("Press / to search docs"))
	}

	// Results
	if len(m.docsResults) == 0 && m.docsQuery != "" && !m.docsSearching {
		lines = append(lines, "")
		lines = append(lines, "  "+dimStyle.Render("No results found."))
	}

	for i, doc := range m.docsResults {
		lines = append(lines, "")

		prefix := "  "
		if i == m.docsCursor {
			prefix = cursorStyle.Render("> ")
		}

		sourceTag := dimStyle.Render("["+doc.SourceType+"]")
		path := tabLabelStyle.Render(doc.SectionPath)
		lines = append(lines, prefix+sourceTag+" "+path)

		if m.docsExpanded[i] {
			content := doc.Content
			if len(content) > 500 {
				content = content[:500] + "..."
			}
			boxWidth := m.width - 6
			if boxWidth < 40 {
				boxWidth = 40
			}
			box := expandedBoxStyle.Width(boxWidth).Render(expandedTextStyle.Render(content))
			lines = append(lines, box)
		}
	}

	return strings.Join(lines, "\n")
}
