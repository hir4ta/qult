package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type notificationInput struct {
	CommonInput
	NotificationType string `json:"notification_type,omitempty"`
	Message          string `json:"message,omitempty"`
}

// handleNotification dequeues nudges during idle notifications.
// When Claude is idle (e.g., waiting for user input), this is a good time
// to deliver pending advice without interrupting active work.
func handleNotification(input []byte) (*HookOutput, error) {
	var in notificationInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] Notification: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Dequeue up to 2 nudges during idle time.
	nudges, _ := sdb.DequeueNudges(2)
	if len(nudges) == 0 {
		return nil, nil
	}

	recordNudgeDelivery(sdb, in.SessionID, nudges)

	var parts []string
	for _, n := range nudges {
		parts = append(parts, fmt.Sprintf("[buddy] %s (%s): %s\n→ %s",
			n.Pattern, n.Level, n.Observation, n.Suggestion))
	}

	return makeOutput("Notification", strings.Join(parts, "\n")), nil
}
