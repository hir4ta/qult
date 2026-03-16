package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

const maxLimit = 500

func clampLimit(v, def int) int {
	if v <= 0 {
		return def
	}
	return min(v, maxLimit)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// validateSlug checks the slug URL parameter against spec.ValidSlug.
func validateSlug(w http.ResponseWriter, slug string) bool {
	if !spec.ValidSlug.MatchString(slug) {
		writeError(w, http.StatusBadRequest, "invalid slug")
		return false
	}
	return true
}

func (s *Server) handleGetVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"version": s.version})
}

func (s *Server) handleGetProject(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"path": s.ds.ProjectPath()})
}

func (s *Server) handleGetTasks(w http.ResponseWriter, _ *http.Request) {
	active := s.ds.ActiveTask()
	tasks := s.ds.TaskDetails()
	writeJSON(w, http.StatusOK, map[string]any{
		"active": active,
		"tasks":  tasks,
	})
}

func (s *Server) handleGetSpecs(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if !validateSlug(w, slug) {
		return
	}
	all := s.ds.Specs()
	var filtered []any
	for _, sp := range all {
		if sp.TaskSlug == slug {
			filtered = append(filtered, sp)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"specs": filtered})
}

// validSpecFiles is the allowlist of spec file names that can be read via the API.
var validSpecFiles = map[string]bool{
	"requirements.md": true,
	"design.md":       true,
	"tasks.md":        true,
	"test-specs.md":   true,
	"decisions.md":    true,
	"research.md":     true,
	"session.md":      true,
	"bugfix.md":       true,
	"delta.md":        true,
}

func (s *Server) handleGetSpecContent(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if !validateSlug(w, slug) {
		return
	}
	file := chi.URLParam(r, "file")
	if !validSpecFiles[file] {
		writeError(w, http.StatusBadRequest, "invalid spec file name")
		return
	}
	content, err := s.ds.SpecContent(slug, file)
	if err != nil {
		writeError(w, http.StatusNotFound, "spec file not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

func (s *Server) handleGetSpecHistory(w http.ResponseWriter, r *http.Request) {
	// TODO: implement spec history via spec.SpecDir.ListHistory
	writeJSON(w, http.StatusOK, map[string]any{"versions": []any{}})
}

func (s *Server) handleGetValidation(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if !validateSlug(w, slug) {
		return
	}
	report := s.ds.Validation(slug)
	if report == nil {
		writeError(w, http.StatusNotFound, "validation not available")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleGetConfidence(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if !validateSlug(w, slug) {
		return
	}
	stats := s.ds.ConfidenceStats(slug)
	if stats == nil {
		writeError(w, http.StatusNotFound, "confidence stats not available")
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handleGetKnowledge(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if v, err := strconv.Atoi(limitStr); err == nil {
		limit = clampLimit(v, 50)
	}
	entries := s.ds.RecentKnowledge(limit)
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) handleSearchKnowledge(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		writeError(w, http.StatusBadRequest, "query parameter 'q' is required")
		return
	}
	limitStr := r.URL.Query().Get("limit")
	limit := 10
	if v, err := strconv.Atoi(limitStr); err == nil {
		limit = clampLimit(v, 10)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 9*time.Second)
	defer cancel()

	entries := s.ds.SemanticSearch(ctx, query, limit)
	// Return whatever we got (possibly partial) even if timeout fired.
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"method":  "vector",
		"partial": ctx.Err() != nil,
	})
}

func (s *Server) handleGetKnowledgeStats(w http.ResponseWriter, _ *http.Request) {
	stats := s.ds.KnowledgeStats()
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handlePatchKnowledgeEnabled(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.ds.ToggleEnabled(id, body.Enabled); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.sse.Broadcast(SSEEvent{Type: "memory_changed", Data: map[string]any{"id": id, "action": "toggle"}})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleGetActivity(w http.ResponseWriter, r *http.Request) {
	filter := r.URL.Query().Get("filter")
	limit := 100
	entries := s.ds.RecentActivity(limit)
	if filter != "" && filter != "all" {
		var filtered []any
		for _, e := range entries {
			if e.Action == filter {
				filtered = append(filtered, e)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": filtered})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) handleGetEpics(w http.ResponseWriter, _ *http.Request) {
	epics := s.ds.Epics()
	writeJSON(w, http.StatusOK, map[string]any{"epics": epics})
}

func (s *Server) handleGetDecisions(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if v, err := strconv.Atoi(limitStr); err == nil {
		limit = clampLimit(v, 50)
	}
	decisions := s.ds.AllDecisions(limit)
	writeJSON(w, http.StatusOK, map[string]any{"decisions": decisions})
}

func (s *Server) handleGetHealth(w http.ResponseWriter, _ *http.Request) {
	stats := s.ds.MemoryHealth()
	writeJSON(w, http.StatusOK, stats)
}
