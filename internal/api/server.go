// Package api provides the HTTP API server for the alfred dashboard.
package api

import (
	"context"
	"io/fs"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/hir4ta/claude-alfred/internal/dashboard"
)

// Server is the HTTP API server for the dashboard.
type Server struct {
	ds      dashboard.DataSource
	specDir string
	version string
	router  chi.Router
	sse     *SSEHub
	httpSrv *http.Server

	// Cancels all request contexts on shutdown (drains SSE connections).
	cancelAll context.CancelFunc

	// options
	devProxyURL string
	embedFS     fs.FS
}

// Option configures the Server.
type Option func(*Server)

// WithDevProxy enables reverse-proxy to a Vite dev server.
func WithDevProxy(viteURL string) Option {
	return func(s *Server) { s.devProxyURL = viteURL }
}

// WithEmbedFS sets the embedded filesystem for SPA serving.
func WithEmbedFS(fsys fs.FS) Option {
	return func(s *Server) { s.embedFS = fsys }
}

// WithVersion sets the version string for /api/version.
func WithVersion(v string) Option {
	return func(s *Server) { s.version = v }
}

// New creates a new API server.
func New(ds dashboard.DataSource, specDir string, opts ...Option) *Server {
	s := &Server{
		ds:      ds,
		specDir: specDir,
		sse:     NewSSEHub(),
	}
	for _, opt := range opts {
		opt(s)
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.Timeout(30 * time.Second))

		r.Get("/version", s.handleGetVersion)
		r.Get("/project", s.handleGetProject)
		r.Get("/tasks", s.handleGetTasks)
		r.Get("/tasks/{slug}/specs", s.handleGetSpecs)
		r.Get("/tasks/{slug}/specs/{file}", s.handleGetSpecContent)
		r.Get("/tasks/{slug}/specs/{file}/history", s.handleGetSpecHistory)
		r.Get("/tasks/{slug}/validation", s.handleGetValidation)
		r.Get("/tasks/{slug}/confidence", s.handleGetConfidence)
		r.Get("/tasks/{slug}/review", s.handleGetReview)
		r.Post("/tasks/{slug}/review", s.handlePostReview)
		r.Get("/tasks/{slug}/review/history", s.handleGetReviewHistory)
		r.Get("/knowledge", s.handleGetKnowledge)
		r.Get("/knowledge/search", s.handleSearchKnowledge)
		r.Get("/knowledge/stats", s.handleGetKnowledgeStats)
		r.Patch("/knowledge/{id}/enabled", s.handlePatchKnowledgeEnabled)
		r.Get("/activity", s.handleGetActivity)
		r.Get("/epics", s.handleGetEpics)
		r.Get("/decisions", s.handleGetDecisions)
		r.Get("/health", s.handleGetHealth)
	})

	// SSE endpoint outside timeout middleware (long-lived connection).
	r.Get("/api/events", s.sse.Handler())

	// SPA serving: dev proxy or embedded static files
	if s.devProxyURL != "" {
		r.Handle("/*", devProxyHandler(s.devProxyURL))
	} else if s.embedFS != nil {
		r.Handle("/*", SPAHandler(s.embedFS))
	}

	s.router = r
	return s
}

// ListenAndServe starts the HTTP server on the given address.
func (s *Server) ListenAndServe(addr string) error {
	baseCtx, cancel := context.WithCancel(context.Background())
	s.cancelAll = cancel
	s.httpSrv = &http.Server{
		Addr:              addr,
		Handler:           s.router,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(_ net.Listener) context.Context { return baseCtx },
	}
	return s.httpSrv.ListenAndServe()
}

// Serve starts the HTTP server on a pre-opened listener (avoids TOCTOU race).
func (s *Server) Serve(ln net.Listener) error {
	baseCtx, cancel := context.WithCancel(context.Background())
	s.cancelAll = cancel
	s.httpSrv = &http.Server{
		Handler:           s.router,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(_ net.Listener) context.Context { return baseCtx },
	}
	return s.httpSrv.Serve(ln)
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	s.sse.Close()
	// Cancel base context to drain SSE connections before httpSrv.Shutdown waits.
	if s.cancelAll != nil {
		s.cancelAll()
	}
	if s.httpSrv != nil {
		return s.httpSrv.Shutdown(ctx)
	}
	return nil
}
