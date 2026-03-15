package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Structured knowledge types matching mneme's format.

// StructuredDecision represents a design decision with full context.
type StructuredDecision struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Context      string   `json:"context"`
	Decision     string   `json:"decision"`
	Reasoning    string   `json:"reasoning"`
	Alternatives []string `json:"alternatives"`
	Tags         []string `json:"tags"`
	Status       string   `json:"status"` // draft, approved, rejected
	SessionRef   string   `json:"sessionRef,omitempty"`
	TaskRef      string   `json:"taskRef,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt,omitempty"`
}

// StructuredPattern represents a reusable practice.
type StructuredPattern struct {
	ID                    string     `json:"id"`
	Type                  string     `json:"type"` // good, bad, error-solution
	Title                 string     `json:"title"`
	Context               string     `json:"context,omitempty"`
	Pattern               string     `json:"pattern,omitempty"`
	ApplicationConditions string     `json:"applicationConditions,omitempty"`
	ExpectedOutcomes      string     `json:"expectedOutcomes,omitempty"`
	Tags                  []string   `json:"tags,omitempty"`
	Status                string     `json:"status"` // draft, approved
	SessionRef            string     `json:"sessionRef,omitempty"`
	SourceRef             *SourceRef `json:"sourceRef,omitempty"`
	CreatedAt             string     `json:"createdAt"`
	UpdatedAt             string     `json:"updatedAt,omitempty"`
}

// StructuredRule represents an enforced development standard.
type StructuredRule struct {
	ID         string     `json:"id"`
	Key        string     `json:"key"`
	Text       string     `json:"text"`
	Category   string     `json:"category,omitempty"`
	Priority   string     `json:"priority,omitempty"` // p0, p1, p2
	Rationale  string     `json:"rationale,omitempty"`
	Tags       []string   `json:"tags,omitempty"`
	Status     string     `json:"status"` // draft, approved
	SourceRef  *SourceRef `json:"sourceRef,omitempty"`
	SessionRef string     `json:"sessionRef,omitempty"`
	CreatedAt  string     `json:"createdAt"`
	UpdatedAt  string     `json:"updatedAt,omitempty"`
}

// StructuredSession represents a work session memory.
type StructuredSession struct {
	ID            string          `json:"id"`
	SessionID     string          `json:"sessionId,omitempty"`
	Title         string          `json:"title"`
	CreatedAt     string          `json:"createdAt"`
	Context       SessionContext  `json:"context,omitempty"`
	Summary       SessionSummary  `json:"summary,omitempty"`
	Discussions   []Discussion    `json:"discussions,omitempty"`
	Technologies  []string        `json:"technologies,omitempty"`
	FilesModified []FileChange    `json:"filesModified,omitempty"`
	Errors        []SessionError  `json:"errors,omitempty"`
	Handoff       *SessionHandoff `json:"handoff,omitempty"`
}

// SourceRef links to an originating pattern or decision.
type SourceRef struct {
	Type string `json:"type"` // "pattern" or "decision"
	ID   string `json:"id"`
}

// SessionContext holds project-level context for a session.
type SessionContext struct {
	ProjectName string `json:"projectName,omitempty"`
	Branch      string `json:"branch,omitempty"`
	TaskSlug    string `json:"taskSlug,omitempty"`
}

// SessionSummary holds the goal and outcome of a session.
type SessionSummary struct {
	Goal        string `json:"goal,omitempty"`
	Outcome     string `json:"outcome,omitempty"` // success, partial, blocked
	Description string `json:"description,omitempty"`
}

// Discussion represents a topic discussed during a session.
type Discussion struct {
	Topic     string `json:"topic"`
	Decision  string `json:"decision,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
}

// FileChange records a file modification during a session.
type FileChange struct {
	Path   string `json:"path"`
	Action string `json:"action,omitempty"` // create, edit, delete
}

// SessionError records an error encountered and its resolution.
type SessionError struct {
	Error    string `json:"error"`
	Solution string `json:"solution,omitempty"`
}

// SessionHandoff holds next steps and notes for session continuity.
type SessionHandoff struct {
	NextSteps []string `json:"nextSteps,omitempty"`
	Notes     []string `json:"notes,omitempty"`
}

// PatternFile wraps a list of patterns (stored in user.json).
type PatternFile struct {
	SchemaVersion int                 `json:"schemaVersion"`
	CreatedAt     string              `json:"createdAt"`
	UpdatedAt     string              `json:"updatedAt"`
	Items         []StructuredPattern `json:"items"`
}

// RuleFile wraps a list of rules (stored in dev-rules.json).
type RuleFile struct {
	SchemaVersion int              `json:"schemaVersion"`
	CreatedAt     string           `json:"createdAt"`
	UpdatedAt     string           `json:"updatedAt"`
	Items         []StructuredRule `json:"items"`
}

// KnowledgeDir returns the path to the knowledge directory.
func KnowledgeDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "knowledge")
}

// SaveDecision writes a decision JSON file and returns the file path.
// Writes to .alfred/knowledge/decisions/YYYY/MM/dec-{id}.json.
func SaveDecision(projectPath string, dec *StructuredDecision) (string, error) {
	t, err := parseCreatedAt(dec.CreatedAt)
	if err != nil {
		return "", fmt.Errorf("store: save decision: %w", err)
	}
	dir := filepath.Join(KnowledgeDir(projectPath), "decisions",
		t.Format("2006"), t.Format("01"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("store: save decision mkdir: %w", err)
	}
	path := filepath.Join(dir, "dec-"+dec.ID+".json")
	data, err := json.MarshalIndent(dec, "", "  ")
	if err != nil {
		return "", fmt.Errorf("store: save decision marshal: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return "", fmt.Errorf("store: save decision write: %w", err)
	}
	return path, nil
}

// LoadDecisions reads all decision files from .alfred/knowledge/decisions/.
// Returns sorted by CreatedAt descending. Returns empty slice if directory does not exist.
func LoadDecisions(projectPath string) ([]StructuredDecision, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "decisions")
	var decisions []StructuredDecision
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if info.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil // skip unreadable files
		}
		var dec StructuredDecision
		if err := json.Unmarshal(data, &dec); err != nil {
			return nil // skip malformed files
		}
		decisions = append(decisions, dec)
		return nil
	})
	if err != nil {
		// Walk returns error only for root dir access — treat as empty.
		return nil, nil
	}
	sort.Slice(decisions, func(i, j int) bool {
		return decisions[i].CreatedAt > decisions[j].CreatedAt
	})
	return decisions, nil
}

// SavePattern appends a pattern to .alfred/knowledge/patterns/user.json.
func SavePattern(projectPath string, pat *StructuredPattern) error {
	dir := filepath.Join(KnowledgeDir(projectPath), "patterns")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("store: save pattern mkdir: %w", err)
	}
	path := filepath.Join(dir, "user.json")
	pf, err := loadPatternFile(path)
	if err != nil {
		return err
	}
	pf.Items = append(pf.Items, *pat)
	pf.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(path, pf)
}

// LoadPatterns reads patterns from .alfred/knowledge/patterns/user.json.
func LoadPatterns(projectPath string) ([]StructuredPattern, error) {
	path := filepath.Join(KnowledgeDir(projectPath), "patterns", "user.json")
	pf, err := loadPatternFile(path)
	if err != nil {
		return nil, err
	}
	return pf.Items, nil
}

// SaveRule appends a rule to .alfred/knowledge/rules/dev-rules.json.
func SaveRule(projectPath string, rule *StructuredRule) error {
	dir := filepath.Join(KnowledgeDir(projectPath), "rules")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("store: save rule mkdir: %w", err)
	}
	path := filepath.Join(dir, "dev-rules.json")
	rf, err := loadRuleFile(path)
	if err != nil {
		return err
	}
	rf.Items = append(rf.Items, *rule)
	rf.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(path, rf)
}

// LoadRules reads rules from .alfred/knowledge/rules/dev-rules.json.
func LoadRules(projectPath string) ([]StructuredRule, error) {
	path := filepath.Join(KnowledgeDir(projectPath), "rules", "dev-rules.json")
	rf, err := loadRuleFile(path)
	if err != nil {
		return nil, err
	}
	return rf.Items, nil
}

// SaveSession writes a session memory JSON file and returns the file path.
// Writes to .alfred/knowledge/sessions/YYYY/MM/{id}.json.
func SaveSession(projectPath string, sess *StructuredSession) (string, error) {
	t, err := parseCreatedAt(sess.CreatedAt)
	if err != nil {
		return "", fmt.Errorf("store: save session: %w", err)
	}
	dir := filepath.Join(KnowledgeDir(projectPath), "sessions",
		t.Format("2006"), t.Format("01"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("store: save session mkdir: %w", err)
	}
	path := filepath.Join(dir, sess.ID+".json")
	data, err := json.MarshalIndent(sess, "", "  ")
	if err != nil {
		return "", fmt.Errorf("store: save session marshal: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return "", fmt.Errorf("store: save session write: %w", err)
	}
	return path, nil
}

// LoadSessions reads all session files from .alfred/knowledge/sessions/.
// Returns sorted by CreatedAt descending. Returns empty slice if directory does not exist.
func LoadSessions(projectPath string) ([]StructuredSession, error) {
	dir := filepath.Join(KnowledgeDir(projectPath), "sessions")
	var sessions []StructuredSession
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var sess StructuredSession
		if err := json.Unmarshal(data, &sess); err != nil {
			return nil
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

// ToContent returns a human-readable content string for the DB content field.
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

// ToContent returns a human-readable content string for the DB content field.
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

// ToContent returns a human-readable content string for the DB content field.
func (r *StructuredRule) ToContent() string {
	var b strings.Builder
	b.WriteString(r.Text)
	if r.Rationale != "" {
		b.WriteString("\n根拠: ")
		b.WriteString(r.Rationale)
	}
	return b.String()
}

// ToContent returns a human-readable content string for the DB content field.
func (s *StructuredSession) ToContent() string {
	var b strings.Builder
	b.WriteString(s.Title)
	if s.Summary.Goal != "" {
		b.WriteString("\n目標: ")
		b.WriteString(s.Summary.Goal)
	}
	if s.Summary.Outcome != "" {
		b.WriteString("\n結果: ")
		b.WriteString(s.Summary.Outcome)
	}
	if len(s.Discussions) > 0 {
		b.WriteString("\n議論: ")
		topics := make([]string, len(s.Discussions))
		for i, d := range s.Discussions {
			topics[i] = d.Topic
		}
		b.WriteString(strings.Join(topics, ", "))
	}
	return b.String()
}

// --- internal helpers ---

// parseCreatedAt parses a CreatedAt string in RFC3339 format.
func parseCreatedAt(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid createdAt %q: %w", s, err)
	}
	return t, nil
}

// loadPatternFile reads an existing pattern file or returns a new empty one.
func loadPatternFile(path string) (*PatternFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &PatternFile{
				SchemaVersion: 1,
				CreatedAt:     time.Now().UTC().Format(time.RFC3339),
				UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
			}, nil
		}
		return nil, fmt.Errorf("store: load pattern file: %w", err)
	}
	var pf PatternFile
	if err := json.Unmarshal(data, &pf); err != nil {
		return nil, fmt.Errorf("store: parse pattern file: %w", err)
	}
	return &pf, nil
}

// loadRuleFile reads an existing rule file or returns a new empty one.
func loadRuleFile(path string) (*RuleFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &RuleFile{
				SchemaVersion: 1,
				CreatedAt:     time.Now().UTC().Format(time.RFC3339),
				UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
			}, nil
		}
		return nil, fmt.Errorf("store: load rule file: %w", err)
	}
	var rf RuleFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return nil, fmt.Errorf("store: parse rule file: %w", err)
	}
	return &rf, nil
}

// writeJSONFile marshals v to indented JSON and writes it to path.
func writeJSONFile(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("store: marshal json: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("store: write json file: %w", err)
	}
	return nil
}
