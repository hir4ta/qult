package store

import (
	"fmt"
	"testing"
)

func TestAggregatePreferenceStats_Empty(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	delivered, resolved, err := st.AggregatePreferenceStats()
	if err != nil {
		t.Fatalf("AggregatePreferenceStats() error = %v", err)
	}
	if delivered != 0 || resolved != 0 {
		t.Errorf("empty store: got delivered=%d resolved=%d, want 0/0", delivered, resolved)
	}
}

func TestAggregatePreferenceStats_WithData(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	for i := range 5 {
		_ = st.UpsertUserPreference(fmt.Sprintf("pattern-%d", i), true, 0)
		_ = st.UpsertUserPreference(fmt.Sprintf("pattern-%d", i), false, 0)
	}
	delivered, resolved, err := st.AggregatePreferenceStats()
	if err != nil {
		t.Fatalf("AggregatePreferenceStats() error = %v", err)
	}
	if delivered == 0 {
		t.Error("should have deliveries after upserting preferences")
	}
	if resolved == 0 {
		t.Error("should have resolutions (some were resolved=true)")
	}
}
