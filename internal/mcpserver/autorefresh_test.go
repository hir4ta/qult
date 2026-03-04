package mcpserver

import (
	"testing"
	"time"
)

func TestNewAutoRefresher(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	r := newAutoRefresher(st, nil)

	if r.st != st {
		t.Error("store not set")
	}
	if r.emb != nil {
		t.Error("expected nil embedder")
	}
	if r.refreshing == nil {
		t.Fatal("refreshing map not initialized")
	}
	if r.cooldowns == nil {
		t.Fatal("cooldowns map not initialized")
	}
	if !r.lastChecked.IsZero() {
		t.Errorf("lastChecked = %v, want zero", r.lastChecked)
	}
}

func TestAutoRefresherCooldown(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	r := newAutoRefresher(st, nil)

	// First call: lastChecked is zero, so it should proceed and update lastChecked.
	r.checkAndRefresh()

	r.mu.Lock()
	first := r.lastChecked
	r.mu.Unlock()

	if first.IsZero() {
		t.Fatal("lastChecked should be set after first checkAndRefresh")
	}

	// Second call within cooldown: lastChecked should not change.
	r.checkAndRefresh()

	r.mu.Lock()
	second := r.lastChecked
	r.mu.Unlock()

	if !second.Equal(first) {
		t.Errorf("lastChecked changed within cooldown: first=%v, second=%v", first, second)
	}
}

func TestAutoRefresherDeduplication(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	r := newAutoRefresher(st, nil)

	// Pre-populate the refreshing map to simulate an in-progress refresh.
	r.mu.Lock()
	r.refreshing["some-source"] = true
	r.mu.Unlock()

	// Call checkAndRefresh; the source should remain in the refreshing map
	// (not cleared, not duplicated).
	r.checkAndRefresh()

	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.refreshing["some-source"] {
		t.Error("expected 'some-source' to remain in refreshing map")
	}
}

func TestAutoRefresherNoStale(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	r := newAutoRefresher(st, nil)

	// With an empty store, there are no custom sources at all.
	// checkAndRefresh should complete without error or goroutine launches.
	r.checkAndRefresh()

	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.refreshing) != 0 {
		t.Errorf("refreshing map should be empty, got %v", r.refreshing)
	}
	if !r.lastChecked.After(time.Time{}) {
		t.Error("lastChecked should be set after checkAndRefresh")
	}
}
