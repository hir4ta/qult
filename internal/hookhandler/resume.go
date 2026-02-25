package hookhandler

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/store"
)

// ResumeData holds gathered context for session resumption.
type ResumeData struct {
	Session   *store.SessionRow
	Decisions []store.DecisionRow
	Files     []store.FileActivity
	Patterns  []store.PatternRow
	Intent    string
	Briefing  []briefingItem
}

type briefingItem struct {
	Category string
	Message  string
}

// BuildResumeData gathers resume context from the store.
// If sessionID is empty, finds the latest session matching the project path.
func BuildResumeData(st *store.Store, sessionID, projectPath string) (*ResumeData, error) {
	var sess *store.SessionRow
	var err error

	if sessionID != "" {
		sess, err = st.GetSession(sessionID)
	} else if projectPath != "" {
		sess, err = st.GetLatestSession(projectPath)
		if err != nil {
			sess, err = st.GetLatestSession(filepath.Base(projectPath))
		}
	} else {
		sess, err = st.GetLatestSession("")
	}
	if err != nil || sess == nil {
		return nil, err
	}

	decisions, _ := st.GetDecisions(sess.ID, "", 10)
	filesChanged, _ := st.GetFilesWritten(sess.ID, 15)
	patterns, _ := st.SearchPatternsByProject(sess.ProjectPath, 5)

	intent := sess.FirstPrompt
	if len(intent) > 200 {
		intent = intent[:200] + "..."
	}

	var briefing []briefingItem

	// Anti-pattern frequency from past sessions.
	patternFreqs, err := st.GetAlertPatternFrequency(sess.ProjectPath)
	if err == nil {
		for _, pf := range patternFreqs {
			if pf.Count >= 3 {
				briefing = append(briefing, briefingItem{
					Category: "anti_pattern",
					Message:  fmt.Sprintf("%s has occurred %d times (last: %s)", pf.PatternType, pf.Count, pf.LastSeen),
				})
			}
		}
	}

	// Frequent failures for this project.
	freqFailures, _ := st.FrequentFailures(sess.ProjectPath, 3)
	for _, ff := range freqFailures {
		if ff.Count >= 2 {
			briefing = append(briefing, briefingItem{
				Category: "frequent_failure",
				Message:  fmt.Sprintf("%s in %s (%dx)", ff.FailureType, filepath.Base(ff.FilePath), ff.Count),
			})
		}
	}

	// Unresolved issues from previous session.
	if sess.ParentSessionID != "" {
		unresolved, _ := st.UnresolvedFromSession(sess.ParentSessionID)
		for _, u := range unresolved {
			briefing = append(briefing, briefingItem{
				Category: "unresolved",
				Message:  fmt.Sprintf("Previous session had unresolved %s in %s", u.FailureType, filepath.Base(u.FilePath)),
			})
		}
	}

	return &ResumeData{
		Session:   sess,
		Decisions: decisions,
		Files:     filesChanged,
		Patterns:  patterns,
		Intent:    intent,
		Briefing:  briefing,
	}, nil
}

// FormatResumeContext formats ResumeData as compact text for additionalContext.
func FormatResumeContext(data *ResumeData) string {
	if data == nil || data.Session == nil {
		return ""
	}

	var b strings.Builder
	b.WriteString("[buddy] Session context restored:\n")

	s := data.Session
	fmt.Fprintf(&b, "Project: %s | Turns: %d | Compacts: %d\n", s.ProjectName, s.TurnCount, s.CompactCount)

	if data.Intent != "" {
		fmt.Fprintf(&b, "Last goal: %s\n", data.Intent)
	}

	if len(data.Decisions) > 0 {
		b.WriteString("Key decisions:\n")
		limit := min(5, len(data.Decisions))
		for i := 0; i < limit; i++ {
			text := data.Decisions[i].DecisionText
			if len(text) > 100 {
				text = text[:100] + "..."
			}
			fmt.Fprintf(&b, "  - %s\n", text)
		}
	}

	if len(data.Files) > 0 {
		b.WriteString("Recently modified files:\n")
		limit := min(8, len(data.Files))
		for i := 0; i < limit; i++ {
			fmt.Fprintf(&b, "  - %s (%s)\n", data.Files[i].Path, data.Files[i].Action)
		}
	}

	if len(data.Patterns) > 0 {
		b.WriteString("Past knowledge:\n")
		limit := min(5, len(data.Patterns))
		for i := range limit {
			p := data.Patterns[i]
			content := p.Content
			if len([]rune(content)) > 100 {
				content = string([]rune(content)[:100]) + "..."
			}
			fmt.Fprintf(&b, "  - [%s] %s\n", p.PatternType, content)
		}
	}

	if len(data.Briefing) > 0 {
		b.WriteString("Alerts:\n")
		for _, item := range data.Briefing {
			fmt.Fprintf(&b, "  - [%s] %s\n", item.Category, item.Message)
		}
	}

	return b.String()
}
