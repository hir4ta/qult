package watcher

import (
	"testing"
	"time"
)

func TestDeduplicateByPrompt(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name     string
		input    []RecentSession
		wantIDs  []string
	}{
		{
			name: "resume pair within seconds — keep newest only",
			input: []RecentSession{
				{SessionID: "b3a87513", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now},
				{SessionID: "30df70a9", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-30 * time.Second)},
			},
			wantIDs: []string{"b3a87513"},
		},
		{
			name: "same prompt hours apart — keep both (separate sessions)",
			input: []RecentSession{
				{SessionID: "c4d0832b", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-8 * time.Hour)},
				{SessionID: "a5e82f6d", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-9 * time.Hour)},
			},
			wantIDs: []string{"c4d0832b", "a5e82f6d"},
		},
		{
			name: "full user scenario — 4 sessions, 1 resume pair + 2 separate",
			input: []RecentSession{
				{SessionID: "b3a87513", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now},
				{SessionID: "30df70a9", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-1 * time.Minute)},
				{SessionID: "c4d0832b", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-8 * time.Hour)},
				{SessionID: "a5e82f6d", Project: "buddy", FirstPrompt: "このclaude-buddy...", ModTime: now.Add(-9 * time.Hour)},
			},
			wantIDs: []string{"b3a87513", "c4d0832b", "a5e82f6d"},
		},
		{
			name: "different projects same prompt — keep both",
			input: []RecentSession{
				{SessionID: "aaa", Project: "proj-a", FirstPrompt: "same prompt", ModTime: now},
				{SessionID: "bbb", Project: "proj-b", FirstPrompt: "same prompt", ModTime: now.Add(-1 * time.Minute)},
			},
			wantIDs: []string{"aaa", "bbb"},
		},
		{
			name: "different prompts same project — keep both",
			input: []RecentSession{
				{SessionID: "aaa", Project: "buddy", FirstPrompt: "first task", ModTime: now},
				{SessionID: "bbb", Project: "buddy", FirstPrompt: "second task", ModTime: now.Add(-1 * time.Minute)},
			},
			wantIDs: []string{"aaa", "bbb"},
		},
		{
			name: "empty prompt sessions — always kept",
			input: []RecentSession{
				{SessionID: "aaa", Project: "buddy", FirstPrompt: "", ModTime: now},
				{SessionID: "bbb", Project: "buddy", FirstPrompt: "", ModTime: now.Add(-10 * time.Second)},
			},
			wantIDs: []string{"aaa", "bbb"},
		},
		{
			name: "triple resume chain — all within 2 minutes",
			input: []RecentSession{
				{SessionID: "aaa", Project: "buddy", FirstPrompt: "fix bug", ModTime: now},
				{SessionID: "bbb", Project: "buddy", FirstPrompt: "fix bug", ModTime: now.Add(-1 * time.Minute)},
				{SessionID: "ccc", Project: "buddy", FirstPrompt: "fix bug", ModTime: now.Add(-2 * time.Minute)},
			},
			wantIDs: []string{"aaa"},
		},
		{
			name: "genuine session 6 min after resume — kept",
			input: []RecentSession{
				{SessionID: "aaa", Project: "buddy", FirstPrompt: "task X", ModTime: now},
				{SessionID: "bbb", Project: "buddy", FirstPrompt: "task X", ModTime: now.Add(-1 * time.Minute)},
				{SessionID: "ccc", Project: "buddy", FirstPrompt: "task X", ModTime: now.Add(-6 * time.Minute)},
			},
			wantIDs: []string{"aaa", "ccc"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deduplicateByPrompt(tt.input)
			if len(got) != len(tt.wantIDs) {
				t.Fatalf("got %d sessions, want %d", len(got), len(tt.wantIDs))
			}
			for i, want := range tt.wantIDs {
				if got[i].SessionID != want {
					t.Errorf("session[%d] = %s, want %s", i, got[i].SessionID, want)
				}
			}
		})
	}
}
