package store

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// Structured knowledge types for Markdown+frontmatter persistence.

// StructuredDecision represents a design decision.
type StructuredDecision struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Context      string   `json:"context"`
	Decision     string   `json:"decision"`
	Reasoning    string   `json:"reasoning"`
	Alternatives []string `json:"alternatives"`
	Tags         []string `json:"tags"`
	Status       string   `json:"status"`
	SessionRef   string   `json:"sessionRef,omitempty"`
	TaskRef      string   `json:"taskRef,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt,omitempty"`
}

// StructuredPattern represents a reusable practice.
type StructuredPattern struct {
	ID                    string   `json:"id"`
	Type                  string   `json:"type"`
	Title                 string   `json:"title"`
	Context               string   `json:"context,omitempty"`
	Pattern               string   `json:"pattern,omitempty"`
	ApplicationConditions string   `json:"applicationConditions,omitempty"`
	ExpectedOutcomes      string   `json:"expectedOutcomes,omitempty"`
	Tags                  []string `json:"tags,omitempty"`
	Status                string   `json:"status"`
	SessionRef            string   `json:"sessionRef,omitempty"`
	CreatedAt             string   `json:"createdAt"`
	UpdatedAt             string   `json:"updatedAt,omitempty"`
}

// StructuredRule represents an enforced development standard.
type StructuredRule struct {
	ID        string   `json:"id"`
	Key       string   `json:"key"`
	Text      string   `json:"text"`
	Category  string   `json:"category,omitempty"`
	Priority  string   `json:"priority,omitempty"`
	Rationale string   `json:"rationale,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Status    string   `json:"status"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt,omitempty"`
}

// StructuredSession represents a work session memory.
type StructuredSession struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId,omitempty"`
	Title     string `json:"title"`
	CreatedAt string `json:"createdAt"`
	Goal      string `json:"goal,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
	Summary   string `json:"summary,omitempty"`
}

// KnowledgeDir returns the path to the knowledge directory.
func KnowledgeDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "knowledge")
}

// SaveDecision writes a decision as a Markdown file with YAML frontmatter.
func SaveDecision(projectPath string, dec *StructuredDecision) (string, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "decisions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("store: save decision mkdir: %w", err)
	}
	filename := sanitizeFilename(dec.ID) + ".md"
	path := filepath.Join(dir, filename)

	var b strings.Builder
	b.WriteString("---\n")
	writeFrontmatter(&b, "id", dec.ID)
	writeFrontmatter(&b, "type", "decision")
	writeFrontmatter(&b, "status", dec.Status)
	writeFrontmatter(&b, "created_at", dec.CreatedAt)
	if len(dec.Tags) > 0 {
		fmt.Fprintf(&b, "tags: [%s]\n", strings.Join(dec.Tags, ", "))
	}
	if dec.TaskRef != "" {
		writeFrontmatter(&b, "task_ref", dec.TaskRef)
	}
	b.WriteString("---\n\n")
	fmt.Fprintf(&b, "# %s\n\n", dec.Title)
	if dec.Context != "" {
		fmt.Fprintf(&b, "## Context\n%s\n\n", dec.Context)
	}
	if dec.Decision != "" {
		fmt.Fprintf(&b, "## Decision\n%s\n\n", dec.Decision)
	}
	if dec.Reasoning != "" {
		fmt.Fprintf(&b, "## Rationale\n%s\n\n", dec.Reasoning)
	}
	if len(dec.Alternatives) > 0 {
		b.WriteString("## Alternatives\n")
		for _, alt := range dec.Alternatives {
			fmt.Fprintf(&b, "- %s\n", alt)
		}
		b.WriteString("\n")
	}

	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", fmt.Errorf("store: save decision write: %w", err)
	}
	return path, nil
}

// LoadDecisions reads all decision Markdown files from .alfred/knowledge/decisions/.
func LoadDecisions(projectPath string) ([]StructuredDecision, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "decisions")
	var decisions []StructuredDecision
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fm, body := parseFrontmatter(string(data))
		dec := StructuredDecision{
			ID:        fm["id"],
			Status:    fm["status"],
			CreatedAt: fm["created_at"],
			TaskRef:   fm["task_ref"],
			Title:     extractHeading(body),
			Tags:      parseTags(fm["tags"]),
		}
		dec.Context = extractSection(body, "Context")
		dec.Decision = extractSection(body, "Decision")
		dec.Reasoning = extractSection(body, "Rationale")
		dec.Alternatives = extractListSection(body, "Alternatives")
		decisions = append(decisions, dec)
		return nil
	})
	if err != nil {
		return nil, nil
	}
	sort.Slice(decisions, func(i, j int) bool {
		return decisions[i].CreatedAt > decisions[j].CreatedAt
	})
	return decisions, nil
}

// SavePattern writes a pattern as a Markdown file.
func SavePattern(projectPath string, pat *StructuredPattern) error {
	dir := filepath.Join(KnowledgeDir(projectPath), "patterns")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("store: save pattern mkdir: %w", err)
	}
	filename := sanitizeFilename(pat.ID) + ".md"
	path := filepath.Join(dir, filename)

	unlock, err := lockKnowledgeFile(path)
	if err != nil {
		return err
	}
	defer unlock()

	var b strings.Builder
	b.WriteString("---\n")
	writeFrontmatter(&b, "id", pat.ID)
	writeFrontmatter(&b, "type", "pattern")
	writeFrontmatter(&b, "pattern_type", pat.Type)
	writeFrontmatter(&b, "status", pat.Status)
	writeFrontmatter(&b, "created_at", pat.CreatedAt)
	if len(pat.Tags) > 0 {
		fmt.Fprintf(&b, "tags: [%s]\n", strings.Join(pat.Tags, ", "))
	}
	b.WriteString("---\n\n")
	fmt.Fprintf(&b, "# %s\n\n", pat.Title)
	if pat.Context != "" {
		fmt.Fprintf(&b, "## Context\n%s\n\n", pat.Context)
	}
	if pat.Pattern != "" {
		fmt.Fprintf(&b, "## Pattern\n%s\n\n", pat.Pattern)
	}
	if pat.ApplicationConditions != "" {
		fmt.Fprintf(&b, "## Application Conditions\n%s\n\n", pat.ApplicationConditions)
	}
	if pat.ExpectedOutcomes != "" {
		fmt.Fprintf(&b, "## Expected Outcomes\n%s\n\n", pat.ExpectedOutcomes)
	}

	return os.WriteFile(path, []byte(b.String()), 0o644)
}

// LoadPatterns reads all pattern Markdown files.
func LoadPatterns(projectPath string) ([]StructuredPattern, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "patterns")
	var patterns []StructuredPattern
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fm, body := parseFrontmatter(string(data))
		pat := StructuredPattern{
			ID:                    fm["id"],
			Type:                  fm["pattern_type"],
			Status:                fm["status"],
			CreatedAt:             fm["created_at"],
			Tags:                  parseTags(fm["tags"]),
			Title:                 extractHeading(body),
			Context:               extractSection(body, "Context"),
			Pattern:               extractSection(body, "Pattern"),
			ApplicationConditions: extractSection(body, "Application Conditions"),
			ExpectedOutcomes:      extractSection(body, "Expected Outcomes"),
		}
		patterns = append(patterns, pat)
		return nil
	})
	if err != nil {
		return nil, nil
	}
	return patterns, nil
}

// SaveRule writes a rule as a Markdown file.
func SaveRule(projectPath string, rule *StructuredRule) error {
	dir := filepath.Join(KnowledgeDir(projectPath), "rules")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("store: save rule mkdir: %w", err)
	}
	filename := sanitizeFilename(rule.ID) + ".md"
	path := filepath.Join(dir, filename)

	unlock, err := lockKnowledgeFile(path)
	if err != nil {
		return err
	}
	defer unlock()

	var b strings.Builder
	b.WriteString("---\n")
	writeFrontmatter(&b, "id", rule.ID)
	writeFrontmatter(&b, "type", "rule")
	writeFrontmatter(&b, "status", rule.Status)
	writeFrontmatter(&b, "priority", rule.Priority)
	writeFrontmatter(&b, "category", rule.Category)
	writeFrontmatter(&b, "created_at", rule.CreatedAt)
	if len(rule.Tags) > 0 {
		fmt.Fprintf(&b, "tags: [%s]\n", strings.Join(rule.Tags, ", "))
	}
	b.WriteString("---\n\n")
	fmt.Fprintf(&b, "# %s\n\n", rule.Key)
	if rule.Text != "" {
		fmt.Fprintf(&b, "%s\n\n", rule.Text)
	}
	if rule.Rationale != "" {
		fmt.Fprintf(&b, "## Rationale\n%s\n\n", rule.Rationale)
	}

	return os.WriteFile(path, []byte(b.String()), 0o644)
}

// LoadRules reads all rule Markdown files.
func LoadRules(projectPath string) ([]StructuredRule, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "rules")
	var rules []StructuredRule
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fm, body := parseFrontmatter(string(data))
		rule := StructuredRule{
			ID:        fm["id"],
			Status:    fm["status"],
			Priority:  fm["priority"],
			Category:  fm["category"],
			CreatedAt: fm["created_at"],
			Tags:      parseTags(fm["tags"]),
			Key:       extractHeading(body),
			Text:      extractFirstParagraph(body),
			Rationale: extractSection(body, "Rationale"),
		}
		rules = append(rules, rule)
		return nil
	})
	if err != nil {
		return nil, nil
	}
	return rules, nil
}

// SaveSession writes a session memory as a Markdown file.
func SaveSession(projectPath string, sess *StructuredSession) (string, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("store: save session mkdir: %w", err)
	}
	filename := sanitizeFilename(sess.ID) + ".md"
	path := filepath.Join(dir, filename)

	var b strings.Builder
	b.WriteString("---\n")
	writeFrontmatter(&b, "id", sess.ID)
	writeFrontmatter(&b, "type", "session")
	writeFrontmatter(&b, "session_id", sess.SessionID)
	writeFrontmatter(&b, "created_at", sess.CreatedAt)
	writeFrontmatter(&b, "outcome", sess.Outcome)
	b.WriteString("---\n\n")
	fmt.Fprintf(&b, "# %s\n\n", sess.Title)
	if sess.Goal != "" {
		fmt.Fprintf(&b, "## Goal\n%s\n\n", sess.Goal)
	}
	if sess.Summary != "" {
		fmt.Fprintf(&b, "## Summary\n%s\n\n", sess.Summary)
	}

	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", fmt.Errorf("store: save session write: %w", err)
	}
	return path, nil
}

// LoadSessions reads all session Markdown files.
func LoadSessions(projectPath string) ([]StructuredSession, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "sessions")
	var sessions []StructuredSession
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fm, body := parseFrontmatter(string(data))
		sess := StructuredSession{
			ID:        fm["id"],
			SessionID: fm["session_id"],
			CreatedAt: fm["created_at"],
			Outcome:   fm["outcome"],
			Title:     extractHeading(body),
			Goal:      extractSection(body, "Goal"),
			Summary:   extractSection(body, "Summary"),
		}
		sessions = append(sessions, sess)
		return nil
	})
	if err != nil {
		return nil, nil
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].CreatedAt > sessions[j].CreatedAt
	})
	return sessions, nil
}

// ToContent returns a human-readable content string for DB indexing.
func (d *StructuredDecision) ToContent() string {
	var b strings.Builder
	b.WriteString(d.Title)
	if d.Reasoning != "" {
		b.WriteString("\n理由: ")
		b.WriteString(d.Reasoning)
	}
	if len(d.Alternatives) > 0 {
		b.WriteString("\n代替案: ")
		b.WriteString(strings.Join(d.Alternatives, ", "))
	}
	return b.String()
}

// ToContent returns a human-readable content string for DB indexing.
func (p *StructuredPattern) ToContent() string {
	var b strings.Builder
	b.WriteString(p.Title)
	if p.Pattern != "" {
		b.WriteString("\nパターン: ")
		b.WriteString(p.Pattern)
	}
	if p.ApplicationConditions != "" {
		b.WriteString("\n適用条件: ")
		b.WriteString(p.ApplicationConditions)
	}
	return b.String()
}

// ToContent returns a human-readable content string for DB indexing.
func (r *StructuredRule) ToContent() string {
	var b strings.Builder
	b.WriteString(r.Text)
	if r.Rationale != "" {
		b.WriteString("\n根拠: ")
		b.WriteString(r.Rationale)
	}
	return b.String()
}

// ToContent returns a human-readable content string for DB indexing.
func (s *StructuredSession) ToContent() string {
	var b strings.Builder
	b.WriteString(s.Title)
	if s.Goal != "" {
		b.WriteString("\n目標: ")
		b.WriteString(s.Goal)
	}
	if s.Outcome != "" {
		b.WriteString("\n結果: ")
		b.WriteString(s.Outcome)
	}
	return b.String()
}

// --- Markdown parsing helpers ---

// parseFrontmatter splits a Markdown file into frontmatter key-value pairs and body.
func parseFrontmatter(content string) (map[string]string, string) {
	fm := make(map[string]string)
	if !strings.HasPrefix(content, "---\n") {
		return fm, content
	}
	rest := content[4:]
	endIdx := strings.Index(rest, "\n---\n")
	if endIdx < 0 {
		return fm, content
	}
	fmBlock := rest[:endIdx]
	body := rest[endIdx+5:] // skip "\n---\n"

	for _, line := range strings.Split(fmBlock, "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fm[strings.TrimSpace(key)] = strings.TrimSpace(val)
	}
	return fm, body
}

// extractHeading returns the first # heading from body.
func extractHeading(body string) string {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "# ") {
			return strings.TrimPrefix(line, "# ")
		}
	}
	return ""
}

// extractSection returns the content of a ## section.
func extractSection(body, heading string) string {
	marker := "## " + heading
	idx := strings.Index(body, marker)
	if idx < 0 {
		return ""
	}
	rest := body[idx+len(marker):]
	// Skip to next line.
	if nl := strings.Index(rest, "\n"); nl >= 0 {
		rest = rest[nl+1:]
	}
	// Find next ## heading or end.
	endIdx := strings.Index(rest, "\n## ")
	if endIdx >= 0 {
		rest = rest[:endIdx]
	}
	return strings.TrimSpace(rest)
}

// extractListSection returns bullet items from a ## section.
func extractListSection(body, heading string) []string {
	content := extractSection(body, heading)
	if content == "" {
		return nil
	}
	var items []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- ") {
			items = append(items, strings.TrimPrefix(trimmed, "- "))
		}
	}
	return items
}

// extractFirstParagraph returns text between heading and first ## or empty line.
func extractFirstParagraph(body string) string {
	// Skip past the # heading.
	lines := strings.Split(body, "\n")
	var result []string
	pastHeading := false
	for _, line := range lines {
		if strings.HasPrefix(line, "# ") {
			pastHeading = true
			continue
		}
		if !pastHeading {
			continue
		}
		if strings.TrimSpace(line) == "" && len(result) > 0 {
			break
		}
		if strings.HasPrefix(line, "## ") {
			break
		}
		if strings.TrimSpace(line) != "" {
			result = append(result, line)
		}
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

// parseTags parses "[a, b, c]" into a string slice.
func parseTags(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	if s == "" {
		return nil
	}
	var tags []string
	for _, t := range strings.Split(s, ",") {
		t = strings.TrimSpace(t)
		if t != "" {
			tags = append(tags, t)
		}
	}
	return tags
}

// writeFrontmatter writes a key: value line if value is non-empty.
func writeFrontmatter(b *strings.Builder, key, value string) {
	if value != "" {
		fmt.Fprintf(b, "%s: %s\n", key, value)
	}
}

// sanitizeFilename creates a safe filename from an ID.
func sanitizeFilename(id string) string {
	s := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		if r >= 'A' && r <= 'Z' {
			return r + 32 // lowercase
		}
		return '-'
	}, id)
	// Collapse multiple hyphens.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return strings.Trim(s, "-")
}

// lockKnowledgeFile acquires an advisory flock on {path}.lock.
func lockKnowledgeFile(path string) (func(), error) {
	lockPath := path + ".lock"
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("store: open lock file: %w", err)
	}
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		lf.Close()
		return nil, fmt.Errorf("store: acquire lock: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)
		lf.Close()
	}, nil
}

// ScanKnowledgeFiles returns all .md files in .alfred/knowledge/ with their relative paths.
// Used by SessionStart to sync files to the DB index.
func ScanKnowledgeFiles(projectPath string) ([]string, error) {
	kDir := KnowledgeDir(projectPath)
	var files []string
	err := filepath.Walk(kDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		rel, err := filepath.Rel(kDir, path)
		if err != nil {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, nil
	}
	return files, nil
}

// ParseKnowledgeFile reads a Markdown knowledge file and returns metadata for DB indexing.
func ParseKnowledgeFile(projectPath, relPath string) (*KnowledgeRow, error) {
	fullPath := filepath.Join(KnowledgeDir(projectPath), relPath)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, err
	}
	content := string(data)
	fm, body := parseFrontmatter(content)

	subType := fm["type"]
	if subType == "" {
		subType = SubTypeGeneral
	}

	title := extractHeading(body)
	if title == "" {
		title = fm["id"]
	}

	return &KnowledgeRow{
		FilePath:    relPath,
		ContentHash: ContentHash(content),
		Title:       title,
		Content:     content,
		SubType:     subType,
		CreatedAt:   fm["created_at"],
	}, nil
}
