package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sync"
)

var validSSEType = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// SSEEvent is a server-sent event.
type SSEEvent struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// SSEHub manages SSE client connections and broadcasts.
type SSEHub struct {
	mu      sync.RWMutex
	clients map[chan SSEEvent]struct{}
	closed  bool
}

// NewSSEHub creates a new SSE broadcast hub.
func NewSSEHub() *SSEHub {
	return &SSEHub{
		clients: make(map[chan SSEEvent]struct{}),
	}
}

// Broadcast sends an event to all connected clients (non-blocking).
// Event type must match [a-zA-Z0-9_-]+ to prevent SSE injection.
func (h *SSEHub) Broadcast(event SSEEvent) {
	if !validSSEType.MatchString(event.Type) {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- event:
		default:
			// slow client — skip
		}
	}
}

// Handler returns an HTTP handler for the SSE endpoint (GET /api/events).
func (h *SSEHub) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		ch := make(chan SSEEvent, 16)
		h.mu.Lock()
		h.clients[ch] = struct{}{}
		h.mu.Unlock()

		defer func() {
			h.mu.Lock()
			delete(h.clients, ch)
			h.mu.Unlock()
		}()

		// Send initial connection event.
		fmt.Fprintf(w, "event: connected\ndata: {}\n\n")
		flusher.Flush()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case event := <-ch:
				data, err := json.Marshal(event.Data)
				if err != nil {
					data = []byte("{}")
				}
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
				flusher.Flush()
			}
		}
	}
}

// Close shuts down the hub. Does not close client channels — context
// cancellation in each handler goroutine handles cleanup.
func (h *SSEHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	// Clear client map; handler goroutines will exit via ctx.Done().
	for ch := range h.clients {
		delete(h.clients, ch)
	}
}
