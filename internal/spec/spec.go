// Package spec manages Alfred Protocol spec files under .alfred/specs/,
// providing task lifecycle (init, switch, delete) and DB synchronization.
package spec

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

// ValidSlug matches URL-safe task identifiers: lowercase letters, digits, hyphens.
var ValidSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,63}$`)

// SpecFile represents a spec file type.
type SpecFile string

const (
	FileRequirements SpecFile = "requirements.md"
	FileDesign       SpecFile = "design.md"
	FileTasks        SpecFile = "tasks.md"
	FileTestSpecs    SpecFile = "test-specs.md"
	FileDecisions    SpecFile = "decisions.md"
	FileResearch     SpecFile = "research.md"
	FileSession      SpecFile = "session.md"
	FileBugfix       SpecFile = "bugfix.md"
	FileDelta        SpecFile = "delta.md"
)

// SpecSize controls how many spec files are generated.
type SpecSize string

const (
	SizeS     SpecSize = "S"
	SizeM     SpecSize = "M"
	SizeL     SpecSize = "L"
	SizeXL    SpecSize = "XL"
	SizeDelta SpecSize = "D"
)

// SpecType controls which primary template is used.
type SpecType string

const (
	TypeFeature SpecType = "feature"
	TypeBugfix  SpecType = "bugfix"
	TypeDelta   SpecType = "delta"
)

// AllFiles lists all spec file types (v2: 7 files).
var AllFiles = []SpecFile{
	FileRequirements,
	FileDesign,
	FileTasks,
	FileTestSpecs,
	FileDecisions,
	FileResearch,
	FileSession,
}

// CoreFiles lists the original 4 files that must always exist after Init.
var CoreFiles = []SpecFile{
	FileRequirements,
	FileDesign,
	FileDecisions,
	FileSession,
}

// SmallFiles lists the 3 files generated for S-sized feature specs.
var SmallFiles = []SpecFile{
	FileRequirements,
	FileTasks,
	FileSession,
}

// MediumFiles lists the 5 files generated for M-sized feature specs.
var MediumFiles = []SpecFile{
	FileRequirements,
	FileDesign,
	FileTasks,
	FileTestSpecs,
	FileSession,
}

// ParseSize validates and returns a SpecSize from a string.
func ParseSize(s string) (SpecSize, error) {
	switch strings.ToUpper(s) {
	case "S":
		return SizeS, nil
	case "M":
		return SizeM, nil
	case "L":
		return SizeL, nil
	case "XL":
		return SizeXL, nil
	case "D":
		return SizeDelta, nil
	default:
		return "", fmt.Errorf("invalid spec size %q (valid: S, M, L, XL, D)", s)
	}
}

// ParseSpecType validates and returns a SpecType from a string.
func ParseSpecType(s string) (SpecType, error) {
	switch strings.ToLower(s) {
	case "feature", "":
		return TypeFeature, nil
	case "bugfix":
		return TypeBugfix, nil
	case "delta":
		return TypeDelta, nil
	default:
		return "", fmt.Errorf("invalid spec type %q (valid: feature, bugfix, delta)", s)
	}
}

// DetectSize auto-detects spec size from description length.
func DetectSize(description string) SpecSize {
	n := len([]rune(description))
	switch {
	case n < 100:
		return SizeS
	case n < 300:
		return SizeM
	default:
		return SizeL
	}
}

// FilesForSize returns the file list for a given size and spec type combination.
// Size controls file count; type controls which primary file is used
// (requirements.md for feature, bugfix.md for bugfix).
// DeltaFiles lists the 2 files generated for delta-sized specs.
var DeltaFiles = []SpecFile{FileDelta, FileSession}

func FilesForSize(size SpecSize, specType SpecType) []SpecFile {
	if size == SizeDelta {
		return DeltaFiles
	}

	primary := FileRequirements
	if specType == TypeBugfix {
		primary = FileBugfix
	}

	switch size {
	case SizeS:
		return []SpecFile{primary, FileTasks, FileSession}
	case SizeM:
		if specType == TypeBugfix {
			return []SpecFile{primary, FileTasks, FileTestSpecs, FileSession}
		}
		return []SpecFile{primary, FileDesign, FileTasks, FileTestSpecs, FileSession}
	default: // L, XL
		return []SpecFile{
			primary,
			FileDesign,
			FileTasks,
			FileTestSpecs,
			FileDecisions,
			FileResearch,
			FileSession,
		}
	}
}

// SpecDir represents a task's spec directory.
type SpecDir struct {
	ProjectPath string
	TaskSlug    string
}

// Section represents a spec file's content with metadata.
type Section struct {
	File    SpecFile
	Content string
	URL     string
}

// Task lifecycle statuses.
const (
	TaskActive    = "active"
	TaskCompleted = "completed"
)

// ActiveTask represents a task entry in _active.md.
type ActiveTask struct {
	Slug         string       `yaml:"slug"`
	StartedAt    string       `yaml:"started_at"`
	Status       string       `yaml:"status,omitempty"`        // "active" (default), "completed"
	CompletedAt  string       `yaml:"completed_at,omitempty"`  // RFC3339
	ReviewStatus ReviewStatus `yaml:"review_status,omitempty"` // pending, approved, changes_requested
	Size         SpecSize     `yaml:"size,omitempty"`           // S, M, L, XL (default: L for backward compat)
	TaskSpecType SpecType     `yaml:"spec_type,omitempty"`      // feature, bugfix (default: feature)
}

// EffectiveSize returns the task's size, defaulting to L for backward compatibility.
func (t ActiveTask) EffectiveSize() SpecSize {
	if t.Size == "" {
		return SizeL
	}
	return t.Size
}

// EffectiveSpecType returns the task's spec type, defaulting to feature.
func (t ActiveTask) EffectiveSpecType() SpecType {
	if t.TaskSpecType == "" {
		return TypeFeature
	}
	return t.TaskSpecType
}

// ActiveState represents the YAML content of _active.md.
type ActiveState struct {
	Primary string       `yaml:"primary"`
	Tasks   []ActiveTask `yaml:"tasks"`
}

// RootDir returns the .alfred/ directory path.
func RootDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred")
}

// SpecsDir returns the .alfred/specs/ directory path.
func SpecsDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "specs")
}

// ActivePath returns the path to .alfred/specs/_active.md.
func ActivePath(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "specs", "_active.md")
}

// Dir returns the task's spec directory path.
func (s *SpecDir) Dir() string {
	return filepath.Join(SpecsDir(s.ProjectPath), s.TaskSlug)
}

// FilePath returns the full path to a spec file.
func (s *SpecDir) FilePath(f SpecFile) string {
	return filepath.Join(s.Dir(), string(f))
}

// Exists returns true if the spec directory exists.
func (s *SpecDir) Exists() bool {
	info, err := os.Stat(s.Dir())
	return err == nil && info.IsDir()
}

// initConfig holds the resolved options for Init.
type initConfig struct {
	size     SpecSize
	specType SpecType
	autoSize bool // true when size is auto-detected
}

// InitOption configures Init behavior.
type InitOption func(*initConfig)

// WithSize sets the spec size explicitly.
func WithSize(size SpecSize) InitOption {
	return func(c *initConfig) {
		c.size = size
		c.autoSize = false
	}
}

// WithSpecType sets the spec type (feature or bugfix).
func WithSpecType(specType SpecType) InitOption {
	return func(c *initConfig) {
		c.specType = specType
	}
}

// Init creates a new spec directory with template files and sets _active.md.
func Init(projectPath, taskSlug, description string, opts ...InitOption) (*SpecDir, error) {
	if !ValidSlug.MatchString(taskSlug) {
		return nil, fmt.Errorf("invalid task_slug %q: must be lowercase alphanumeric with hyphens (e.g., 'add-auth')", taskSlug)
	}

	cfg := initConfig{
		specType: TypeFeature,
		autoSize: true,
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	if cfg.autoSize {
		cfg.size = DetectSize(description)
	}
	// Delta size implies delta spec type.
	if cfg.size == SizeDelta {
		cfg.specType = TypeDelta
	}

	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	// Refuse to overwrite an existing spec directory.
	if sd.Exists() {
		return nil, fmt.Errorf("spec already exists for '%s'; use spec action=update to modify", taskSlug)
	}

	if err := os.MkdirAll(sd.Dir(), 0o755); err != nil {
		return nil, fmt.Errorf("create spec dir: %w", err)
	}

	data := TemplateData{
		TaskSlug:    taskSlug,
		Description: description,
		Date:        time.Now().UTC().Format("2006-01-02"),
		SpecType:    string(cfg.specType),
	}
	rendered, err := RenderForSize(cfg.size, cfg.specType, data, projectPath)
	if err != nil {
		os.RemoveAll(sd.Dir()) // clean up partial init
		return nil, fmt.Errorf("render templates: %w", err)
	}

	files := FilesForSize(cfg.size, cfg.specType)
	for _, f := range files {
		content := rendered[f]
		if err := os.WriteFile(sd.FilePath(f), []byte(content), 0o644); err != nil {
			os.RemoveAll(sd.Dir()) // clean up partial init
			return nil, fmt.Errorf("write %s: %w", f, err)
		}
	}

	// Write or update _active.md
	now := time.Now().UTC().Format(time.RFC3339)
	state, _ := readActiveState(projectPath) // ignore error — file may not exist
	if state == nil {
		state = &ActiveState{}
	}
	state.Primary = taskSlug
	// Avoid duplicate entries if slug already exists in tasks list (e.g., spec dir was manually deleted).
	alreadyListed := false
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			alreadyListed = true
			break
		}
	}
	if !alreadyListed {
		state.Tasks = append(state.Tasks, ActiveTask{
			Slug:         taskSlug,
			StartedAt:    now,
			Size:         cfg.size,
			TaskSpecType: cfg.specType,
		})
	}
	if err := writeActiveState(projectPath, state); err != nil {
		return nil, err
	}

	return sd, nil
}

// InitResult holds metadata about a completed Init.
type InitResult struct {
	SpecDir  *SpecDir
	Size     SpecSize
	SpecType SpecType
	Files    []SpecFile
}

// InitWithResult creates a new spec and returns full metadata.
func InitWithResult(projectPath, taskSlug, description string, opts ...InitOption) (*InitResult, error) {
	cfg := initConfig{
		specType: TypeFeature,
		autoSize: true,
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	if cfg.autoSize {
		cfg.size = DetectSize(description)
	}

	sd, err := Init(projectPath, taskSlug, description, WithSize(cfg.size), WithSpecType(cfg.specType))
	if err != nil {
		return nil, err
	}

	return &InitResult{
		SpecDir:  sd,
		Size:     cfg.size,
		SpecType: cfg.specType,
		Files:    FilesForSize(cfg.size, cfg.specType),
	}, nil
}

// ReadFile reads the content of a spec file.
func (s *SpecDir) ReadFile(f SpecFile) (string, error) {
	data, err := os.ReadFile(s.FilePath(f))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// lockSpecDir acquires an advisory flock on a .lock file in the spec directory.
// Returns the lock file handle (caller must defer unlock+close) or an error.
// Uses non-blocking lock with exponential backoff (100/200/400/800ms, 1.5s total)
// to handle concurrent hook invocations (e.g., PreCompact + SessionStart overlap).
// Respects context cancellation to avoid wasting budget on tight timeouts.
// Note: 1.5s worst-case is within PreCompact's 9s budget; callers
// fall back to unprotected write if the lock times out.
func (s *SpecDir) lockSpecDir(ctx context.Context) (*os.File, error) {
	lockPath := filepath.Join(s.Dir(), ".lock")
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	// Exponential backoff: short contention resolves faster, total ~1.5s.
	delays := [4]time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond}
	for attempt, delay := range delays {
		err = syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return lf, nil
		}
		if ctx.Err() != nil {
			break
		}
		if attempt < len(delays)-1 {
			select {
			case <-ctx.Done():
				lf.Close()
				return nil, fmt.Errorf("spec lock cancelled: %w", ctx.Err())
			case <-time.After(delay):
			}
		}
	}
	lf.Close()
	return nil, fmt.Errorf("spec lock timeout on %s", lockPath)
}

// unlockSpecDir releases the advisory lock and closes the file.
func unlockSpecDir(lf *os.File) {
	if lf == nil {
		return
	}
	_ = syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)
	lf.Close()
}

// WriteFile writes content to a spec file using atomic rename to prevent
// partial writes from concurrent hook invocations. Protected by advisory flock.
// Pass context to respect cancellation during lock acquisition.
func (s *SpecDir) WriteFile(ctx context.Context, f SpecFile, content string) error {
	lf, err := s.lockSpecDir(ctx)
	if err != nil {
		// Fall back to unprotected write if lock fails (concurrent access risk accepted).
		fmt.Fprintf(os.Stderr, "[alfred] warning: spec lock contention on %s — concurrent write possible\n", f)
		return s.writeFileUnlocked(f, content)
	}
	defer unlockSpecDir(lf)
	return s.writeFileUnlocked(f, content)
}

// writeFileUnlocked performs the actual atomic write (tmp + rename).
// Saves a history snapshot before overwriting (fail-open).
func (s *SpecDir) writeFileUnlocked(f SpecFile, content string) error {
	// Save history before overwriting (fail-open: errors don't prevent the write).
	_ = s.saveHistory(f)
	return s.writeFileRaw(f, content)
}

// writeFileRaw performs atomic write (tmp + rename) without saving history.
func (s *SpecDir) writeFileRaw(f SpecFile, content string) error {
	path := s.FilePath(f)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// AppendFile appends content to a spec file via read-append-rename.
// Protected by advisory flock to prevent lost updates from concurrent callers.
func (s *SpecDir) AppendFile(ctx context.Context, f SpecFile, content string) error {
	lf, err := s.lockSpecDir(ctx)
	if err != nil {
		// Fall back to unprotected append if lock fails (concurrent access risk accepted).
		fmt.Fprintf(os.Stderr, "[alfred] warning: spec lock contention on %s — concurrent write possible\n", f)
		return s.appendFileUnlocked(f, content)
	}
	defer unlockSpecDir(lf)
	return s.appendFileUnlocked(f, content)
}

// appendFileUnlocked performs the actual read-append-rename.
func (s *SpecDir) appendFileUnlocked(f SpecFile, content string) error {
	path := s.FilePath(f)
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return s.writeFileUnlocked(f, string(existing)+content)
}

// ReadActive reads the primary task slug from _active.md.
// Supports both legacy format ("task: slug") and new YAML format.
func ReadActive(projectPath string) (string, error) {
	state, err := readActiveState(projectPath)
	if err != nil {
		return "", err
	}
	if state.Primary == "" {
		return "", fmt.Errorf("no primary task in _active.md")
	}
	return state.Primary, nil
}

// ReadActiveState reads the full active state from _active.md.
func ReadActiveState(projectPath string) (*ActiveState, error) {
	return readActiveState(projectPath)
}

// readActiveState reads and parses _active.md, supporting both legacy and YAML formats.
func readActiveState(projectPath string) (*ActiveState, error) {
	data, err := os.ReadFile(ActivePath(projectPath))
	if err != nil {
		return nil, fmt.Errorf("read _active.md: %w", err)
	}

	// Try YAML first
	var state ActiveState
	if err := yaml.Unmarshal(data, &state); err == nil && state.Primary != "" {
		return &state, nil
	}

	// Legacy format: "task: slug\nstarted_at: time"
	var slug, startedAt string
	for line := range strings.SplitSeq(string(data), "\n") {
		if s, ok := strings.CutPrefix(line, "task: "); ok {
			slug = s
		}
		if s, ok := strings.CutPrefix(line, "started_at: "); ok {
			startedAt = s
		}
	}
	if slug == "" {
		return nil, fmt.Errorf("no task field in _active.md")
	}
	return &ActiveState{
		Primary: slug,
		Tasks:   []ActiveTask{{Slug: slug, StartedAt: startedAt}},
	}, nil
}

// writeActiveState writes the active state as YAML to _active.md.
func writeActiveState(projectPath string, state *ActiveState) error {
	if err := os.MkdirAll(SpecsDir(projectPath), 0o755); err != nil {
		return fmt.Errorf("create specs dir: %w", err)
	}
	data, err := yaml.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal _active.md: %w", err)
	}
	if err := os.WriteFile(ActivePath(projectPath), data, 0o644); err != nil {
		return fmt.Errorf("write _active.md: %w", err)
	}
	return nil
}

// SwitchActive changes the primary task to the given slug.
// Returns an error if the target task is completed.
func SwitchActive(projectPath, taskSlug string) error {
	state, err := readActiveState(projectPath)
	if err != nil {
		return err
	}
	found := false
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			if t.Status == TaskCompleted {
				return fmt.Errorf("task %q is completed", taskSlug)
			}
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("task %q not found in _active.md", taskSlug)
	}
	state.Primary = taskSlug
	return writeActiveState(projectPath, state)
}

// CompleteTask marks a task as completed in _active.md.
// If the completed task was primary, switches primary to the next active task.
// Returns the new primary slug (empty if no active tasks remain).
func CompleteTask(projectPath, taskSlug string) (string, error) {
	state, err := readActiveState(projectPath)
	if err != nil {
		return "", err
	}

	found := false
	for i := range state.Tasks {
		if state.Tasks[i].Slug == taskSlug {
			if state.Tasks[i].Status == TaskCompleted {
				return state.Primary, fmt.Errorf("task %q is already completed", taskSlug)
			}
			state.Tasks[i].Status = TaskCompleted
			state.Tasks[i].CompletedAt = time.Now().UTC().Format(time.RFC3339)
			found = true
			break
		}
	}
	if !found {
		return "", fmt.Errorf("task %q not found in _active.md", taskSlug)
	}

	// If the completed task was primary, switch to the next active task.
	if state.Primary == taskSlug {
		state.Primary = ""
		for _, t := range state.Tasks {
			if t.Status != TaskCompleted && t.Slug != taskSlug {
				state.Primary = t.Slug
				break
			}
		}
	}

	if err := writeActiveState(projectPath, state); err != nil {
		return "", err
	}
	return state.Primary, nil
}

// IsActive returns true if the task status is active (or empty, the default).
func (t ActiveTask) IsActive() bool {
	return t.Status == "" || t.Status == TaskActive
}

// SetReviewStatus updates the review_status for a task in _active.md.
func SetReviewStatus(projectPath, taskSlug string, status ReviewStatus) error {
	state, err := readActiveState(projectPath)
	if err != nil {
		return err
	}
	found := false
	for i := range state.Tasks {
		if state.Tasks[i].Slug == taskSlug {
			state.Tasks[i].ReviewStatus = status
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("task %q not found in _active.md", taskSlug)
	}
	return writeActiveState(projectPath, state)
}

// ReviewStatusFor returns the review_status for a task from _active.md.
func ReviewStatusFor(projectPath, taskSlug string) ReviewStatus {
	state, err := readActiveState(projectPath)
	if err != nil {
		return ""
	}
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			return t.ReviewStatus
		}
	}
	return ""
}

// RemoveTask removes a task from _active.md and its spec directory.
// If the removed task was primary, the next task becomes primary.
// Returns true if _active.md was also removed (no tasks left).
func RemoveTask(projectPath, taskSlug string) (bool, error) {
	state, err := readActiveState(projectPath)
	if err != nil {
		return false, err
	}

	filtered := state.Tasks[:0]
	for _, t := range state.Tasks {
		if t.Slug != taskSlug {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) == len(state.Tasks) {
		return false, fmt.Errorf("task %q not found in _active.md", taskSlug)
	}

	// Remove spec directory
	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if sd.Exists() {
		if err := os.RemoveAll(sd.Dir()); err != nil {
			return false, fmt.Errorf("remove spec dir: %w", err)
		}
	}

	if len(filtered) == 0 {
		// No tasks left — remove _active.md
		os.Remove(ActivePath(projectPath))
		return true, nil
	}

	state.Tasks = filtered
	if state.Primary == taskSlug {
		state.Primary = filtered[0].Slug
	}
	return false, writeActiveState(projectPath, state)
}

// allKnownFiles lists all spec files including bugfix.md and delta.md for AllSections scanning.
var allKnownFiles = append(append(append([]SpecFile{}, AllFiles...), FileBugfix), FileDelta)

// AllSections returns all existing spec files as Sections with content and URL.
// Files that don't exist (e.g., new v2 files in a legacy 4-file spec) are skipped.
// Also checks bugfix.md for bugfix-type specs.
func (s *SpecDir) AllSections() ([]Section, error) {
	projectBase := filepath.Base(s.ProjectPath)
	var sections []Section
	for _, f := range allKnownFiles {
		content, err := s.ReadFile(f)
		if err != nil {
			if os.IsNotExist(err) {
				continue // skip missing files (backward compat for 4-file specs)
			}
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		url := fmt.Sprintf("spec://%s/%s/%s", projectBase, s.TaskSlug, string(f))
		sections = append(sections, Section{
			File:    f,
			Content: content,
			URL:     url,
		})
	}
	return sections, nil
}
