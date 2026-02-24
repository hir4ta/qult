package tui

import (
	"fmt"
	"time"
)

// humanizeAge formats a duration into a short, human-friendly string.
func humanizeAge(d time.Duration, ja bool) string {
	if ja {
		return humanizeAgeJa(d)
	}
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

func humanizeAgeJa(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "たった今"
	case d < time.Hour:
		return fmt.Sprintf("%d分前", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d時間前", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%d日前", int(d.Hours()/24))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%d週間前", int(d.Hours()/(24*7)))
	default:
		return time.Now().Add(-d).Format("01/02")
	}
}
