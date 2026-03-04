package mcpserver

import (
	"context"
	"sync"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const (
	refreshMaxAge  = 7 * 24 * time.Hour // sources older than 7 days are stale
	refreshCooldown = 1 * time.Hour      // don't re-check the same source within 1 hour
)

// autoRefresher checks custom source freshness and triggers background harvests.
type autoRefresher struct {
	st  *store.Store
	emb *embedder.Embedder

	mu          sync.Mutex
	lastChecked time.Time                 // when we last ran a staleness check
	refreshing  map[string]bool           // sources currently being refreshed
	cooldowns   map[string]time.Time      // per-source cooldown timestamps
}

func newAutoRefresher(st *store.Store, emb *embedder.Embedder) *autoRefresher {
	return &autoRefresher{
		st:         st,
		emb:        emb,
		refreshing: make(map[string]bool),
		cooldowns:  make(map[string]time.Time),
	}
}

// checkAndRefresh is called after each knowledge query.
// It checks if any custom sources are stale and refreshes them in the background.
func (r *autoRefresher) checkAndRefresh() {
	r.mu.Lock()
	// Rate-limit staleness checks to once per cooldown period.
	if time.Since(r.lastChecked) < refreshCooldown {
		r.mu.Unlock()
		return
	}
	r.lastChecked = time.Now()
	r.mu.Unlock()

	sources, err := install.LoadCustomSources()
	if err != nil || len(sources) == 0 {
		return
	}

	urlMap := install.SourceURLMap(sources)
	staleNames, err := r.st.StaleCustomSources(urlMap, refreshMaxAge)
	if err != nil || len(staleNames) == 0 {
		return
	}

	// Find which sources to refresh (skip those already refreshing or in cooldown).
	r.mu.Lock()
	var toRefresh []install.CustomSource
	now := time.Now()
	for _, name := range staleNames {
		if r.refreshing[name] {
			continue
		}
		if cd, ok := r.cooldowns[name]; ok && now.Before(cd) {
			continue
		}
		r.refreshing[name] = true
		for _, s := range sources {
			if s.Name == name {
				toRefresh = append(toRefresh, s)
				break
			}
		}
	}
	r.mu.Unlock()

	if len(toRefresh) == 0 {
		return
	}

	// Refresh in the background, one source at a time.
	go func() {
		for _, src := range toRefresh {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			install.HarvestSources(ctx, r.st, r.emb, []install.CustomSource{src})
			cancel()

			r.mu.Lock()
			delete(r.refreshing, src.Name)
			r.cooldowns[src.Name] = time.Now().Add(refreshCooldown)
			r.mu.Unlock()
		}
	}()
}
