package store

import (
	"context"
	"testing"
)

func TestSessionLinks(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	t.Run("link and resolve", func(t *testing.T) {
		err := st.LinkSession(ctx, &SessionLink{
			ClaudeSessionID: "session-2",
			MasterSessionID: "session-1",
			ProjectPath:     "/project",
			TaskSlug:        "my-task",
		})
		if err != nil {
			t.Fatalf("LinkSession: %v", err)
		}

		master := st.ResolveMasterSession(ctx, "session-2")
		if master != "session-1" {
			t.Errorf("ResolveMasterSession(session-2) = %q, want session-1", master)
		}
	})

	t.Run("resolve unlinked returns self", func(t *testing.T) {
		master := st.ResolveMasterSession(ctx, "unknown-session")
		if master != "unknown-session" {
			t.Errorf("ResolveMasterSession(unknown) = %q, want unknown-session", master)
		}
	})

	t.Run("idempotent link", func(t *testing.T) {
		err := st.LinkSession(ctx, &SessionLink{
			ClaudeSessionID: "session-2",
			MasterSessionID: "session-1",
			ProjectPath:     "/project",
			TaskSlug:        "my-task",
		})
		if err != nil {
			t.Fatalf("second LinkSession should be idempotent: %v", err)
		}
	})

	t.Run("continuity", func(t *testing.T) {
		st.LinkSession(ctx, &SessionLink{
			ClaudeSessionID: "session-3",
			MasterSessionID: "session-1",
			ProjectPath:     "/project",
			TaskSlug:        "my-task",
		})

		sc, err := st.GetSessionContinuity(ctx, "session-1")
		if err != nil {
			t.Fatalf("GetSessionContinuity: %v", err)
		}
		if sc.CompactCount != 2 {
			t.Errorf("CompactCount = %d, want 2", sc.CompactCount)
		}
	})

	t.Run("transitive chain resolution", func(t *testing.T) {
		st.LinkSession(ctx, &SessionLink{
			ClaudeSessionID: "session-5",
			MasterSessionID: "session-4",
			ProjectPath:     "/project",
		})
		st.LinkSession(ctx, &SessionLink{
			ClaudeSessionID: "session-6",
			MasterSessionID: "session-5",
			ProjectPath:     "/project",
		})

		master := st.ResolveMasterSession(ctx, "session-6")
		if master != "session-4" {
			t.Errorf("transitive chain: got %q, want session-4", master)
		}
	})
}

func TestKnowledgeSubType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id, changed, err := st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "decisions/dec-001.md",
		Title:       "Use FTS5 for search",
		Content:     "Decided to use FTS5 for full-text search",
		SubType:     SubTypeDecision,
		ProjectPath: "/test",
	})
	if err != nil {
		t.Fatalf("UpsertKnowledge: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new entry")
	}

	row, err := st.GetKnowledgeByID(ctx, id)
	if err != nil {
		t.Fatalf("GetKnowledgeByID: %v", err)
	}
	if row.SubType != SubTypeDecision {
		t.Errorf("SubType = %q, want %q", row.SubType, SubTypeDecision)
	}
}
