package store

import (
	"context"
	"testing"
	"time"
)

func TestSchemaV4Migration(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Schema version should be 5 after migration.
	if got := st.SchemaVersionCurrent(); got != 5 {
		t.Fatalf("SchemaVersionCurrent() = %d, want 5", got)
	}

	// Verify hit_count and last_accessed columns exist by inserting and querying.
	ctx := context.Background()
	id, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/v4",
		SectionPath: "test > v4",
		Content:     "schema v4 test",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	var hitCount int
	var lastAccessed string
	err = st.DB().QueryRow("SELECT hit_count, last_accessed FROM records WHERE id = ?", id).
		Scan(&hitCount, &lastAccessed)
	if err != nil {
		t.Fatalf("query hit_count: %v", err)
	}
	if hitCount != 0 {
		t.Errorf("initial hit_count = %d, want 0", hitCount)
	}
	if lastAccessed != "" {
		t.Errorf("initial last_accessed = %q, want empty", lastAccessed)
	}
}

func TestIncrementHitCount(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert two memory records.
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/hit1", SectionPath: "test > hit1",
		Content: "content 1", SourceType: SourceMemory,
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/hit2", SectionPath: "test > hit2",
		Content: "content 2", SourceType: SourceMemory,
	})

	// Increment both.
	if err := st.IncrementHitCount(ctx, []int64{id1, id2}); err != nil {
		t.Fatalf("IncrementHitCount: %v", err)
	}

	// Verify hit_count = 1 for both.
	var h1, h2 int
	st.DB().QueryRow("SELECT hit_count FROM records WHERE id = ?", id1).Scan(&h1)
	st.DB().QueryRow("SELECT hit_count FROM records WHERE id = ?", id2).Scan(&h2)
	if h1 != 1 {
		t.Errorf("id1 hit_count = %d, want 1", h1)
	}
	if h2 != 1 {
		t.Errorf("id2 hit_count = %d, want 1", h2)
	}

	// Increment id1 again.
	if err := st.IncrementHitCount(ctx, []int64{id1}); err != nil {
		t.Fatalf("IncrementHitCount 2nd: %v", err)
	}
	st.DB().QueryRow("SELECT hit_count FROM records WHERE id = ?", id1).Scan(&h1)
	if h1 != 2 {
		t.Errorf("id1 hit_count after 2nd increment = %d, want 2", h1)
	}

	// Verify last_accessed was set.
	var la string
	st.DB().QueryRow("SELECT last_accessed FROM records WHERE id = ?", id1).Scan(&la)
	if la == "" {
		t.Error("last_accessed should be set after increment")
	}

	// Empty IDs should not error.
	if err := st.IncrementHitCount(ctx, nil); err != nil {
		t.Errorf("IncrementHitCount(nil) = %v, want nil", err)
	}
}

func TestPromoteSubType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/promote", SectionPath: "test > promote",
		Content: "promotable", SourceType: SourceMemory, SubType: SubTypeGeneral,
	})

	// general → pattern: OK.
	if err := st.PromoteSubType(ctx, id, SubTypePattern); err != nil {
		t.Fatalf("promote general→pattern: %v", err)
	}

	// Verify sub_type updated.
	var st2 string
	st.DB().QueryRow("SELECT sub_type FROM records WHERE id = ?", id).Scan(&st2)
	if st2 != SubTypePattern {
		t.Errorf("sub_type = %q, want %q", st2, SubTypePattern)
	}

	// pattern → rule: OK.
	if err := st.PromoteSubType(ctx, id, SubTypeRule); err != nil {
		t.Fatalf("promote pattern→rule: %v", err)
	}

	// general → rule: should fail (skip).
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/promote2", SectionPath: "test > promote2",
		Content: "another", SourceType: SourceMemory, SubType: SubTypeGeneral,
	})
	if err := st.PromoteSubType(ctx, id2, SubTypeRule); err == nil {
		t.Error("promote general→rule should fail")
	}

	// Invalid target.
	if err := st.PromoteSubType(ctx, id2, "invalid"); err == nil {
		t.Error("promote to invalid target should fail")
	}

	// decision cannot be promoted.
	idDec, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/decision", SectionPath: "test > decision",
		Content: "decision", SourceType: SourceMemory, SubType: SubTypeDecision,
	})
	if err := st.PromoteSubType(ctx, idDec, SubTypePattern); err == nil {
		t.Error("promote decision→pattern should fail")
	}
}

func TestGetPromotionCandidates(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert general with hit_count = 6 (above threshold 5).
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/cand1", SectionPath: "test > cand1",
		Content: "candidate 1", SourceType: SourceMemory, SubType: SubTypeGeneral,
	})
	st.DB().Exec("UPDATE records SET hit_count = 6 WHERE id = ?", id1)

	// Insert pattern with hit_count = 20 (above threshold 15).
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/cand2", SectionPath: "test > cand2",
		Content: "candidate 2", SourceType: SourceMemory, SubType: SubTypePattern,
	})
	st.DB().Exec("UPDATE records SET hit_count = 20 WHERE id = ?", id2)

	// Insert general with hit_count = 2 (below threshold).
	st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/below", SectionPath: "test > below",
		Content: "below threshold", SourceType: SourceMemory, SubType: SubTypeGeneral,
	})

	// Insert decision with hit_count = 100 (should not appear).
	idDec, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/dec", SectionPath: "test > dec",
		Content: "decision high", SourceType: SourceMemory, SubType: SubTypeDecision,
	})
	st.DB().Exec("UPDATE records SET hit_count = 100 WHERE id = ?", idDec)

	candidates, err := st.GetPromotionCandidates(ctx)
	if err != nil {
		t.Fatalf("GetPromotionCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("got %d candidates, want 2", len(candidates))
	}

	// Should be ordered by hit_count DESC (id2=20 first, id1=6 second).
	if candidates[0].ID != id2 {
		t.Errorf("first candidate ID = %d, want %d", candidates[0].ID, id2)
	}
	if candidates[1].ID != id1 {
		t.Errorf("second candidate ID = %d, want %d", candidates[1].ID, id1)
	}
}

func TestGetMemoryStats(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Empty stats.
	stats, err := st.GetMemoryStats(ctx)
	if err != nil {
		t.Fatalf("GetMemoryStats (empty): %v", err)
	}
	if stats.Total != 0 {
		t.Errorf("Total = %d, want 0", stats.Total)
	}

	// Insert some memories.
	for i, subType := range []string{SubTypeGeneral, SubTypeGeneral, SubTypeDecision, SubTypePattern} {
		id, _, _ := st.UpsertDoc(ctx, &DocRow{
			URL: "memory://test/stats" + string(rune('0'+i)), SectionPath: "test > stats" + string(rune('0'+i)),
			Content: "content", SourceType: SourceMemory, SubType: subType,
		})
		if i == 0 {
			st.DB().Exec("UPDATE records SET hit_count = 10 WHERE id = ?", id)
		}
	}

	stats, err = st.GetMemoryStats(ctx)
	if err != nil {
		t.Fatalf("GetMemoryStats: %v", err)
	}
	if stats.Total != 4 {
		t.Errorf("Total = %d, want 4", stats.Total)
	}
	if stats.BySubType[SubTypeGeneral] != 2 {
		t.Errorf("BySubType[general] = %d, want 2", stats.BySubType[SubTypeGeneral])
	}
	if stats.BySubType[SubTypeDecision] != 1 {
		t.Errorf("BySubType[decision] = %d, want 1", stats.BySubType[SubTypeDecision])
	}
	if len(stats.TopAccessed) != 1 {
		t.Errorf("TopAccessed length = %d, want 1", len(stats.TopAccessed))
	}
}

func TestGetStaleMemories(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a memory with old crawled_at and no last_accessed.
	oldTime := time.Now().AddDate(0, -4, 0).UTC().Format(time.RFC3339)
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/stale1", SectionPath: "test > stale1",
		Content: "old memory", SourceType: SourceMemory, CrawledAt: oldTime,
	})
	_ = id1

	// Insert a recent memory.
	st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/fresh", SectionPath: "test > fresh",
		Content: "new memory", SourceType: SourceMemory,
	})

	stale, err := st.GetStaleMemories(ctx, 90)
	if err != nil {
		t.Fatalf("GetStaleMemories: %v", err)
	}
	if len(stale) != 1 {
		t.Fatalf("got %d stale, want 1", len(stale))
	}
	if stale[0].SectionPath != "test > stale1" {
		t.Errorf("stale[0].SectionPath = %q, want %q", stale[0].SectionPath, "test > stale1")
	}
}
