package spec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AuditEntry represents a single auditable action.
type AuditEntry struct {
	Timestamp string `json:"timestamp"`
	Action    string `json:"action"`  // "spec.init", "spec.delete", "spec.complete", "review.submit", "epic.link", etc.
	Target    string `json:"target"`  // task_slug, epic_slug, or memory label
	Detail    string `json:"detail"`  // JSON or free-text detail
	User      string `json:"user"`    // "tui" or "mcp" (source of action)
}

// AuditPath returns the path to the audit log file.
func AuditPath(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "audit.jsonl")
}

// AppendAudit appends an audit entry to .alfred/audit.jsonl.
// Best-effort: errors are silently ignored.
func AppendAudit(projectPath string, entry AuditEntry) {
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	dir := filepath.Join(projectPath, ".alfred")
	_ = os.MkdirAll(dir, 0o755)

	f, err := os.OpenFile(AuditPath(projectPath), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "%s\n", data)
}

// ReadAuditLog reads all audit entries from .alfred/audit.jsonl.
// Returns an empty slice if the file doesn't exist.
func ReadAuditLog(projectPath string, limit int) ([]AuditEntry, error) {
	data, err := os.ReadFile(AuditPath(projectPath))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read audit log: %w", err)
	}

	var entries []AuditEntry
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e AuditEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		entries = append(entries, e)
	}

	// Return last N entries (most recent).
	if limit > 0 && len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}
	return entries, nil
}
