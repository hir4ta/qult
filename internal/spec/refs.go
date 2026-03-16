package spec

import (
	"os"
	"regexp"
	"strings"
)

// refRe matches @spec:task-slug or @spec:task-slug/file.md references.
// File component matches [a-z][\-a-z]*\.md to support all spec files
// including hyphenated names like test-specs.md.
var refRe = regexp.MustCompile(`@spec:([a-z0-9][a-z0-9\-]{0,63})(?:/([a-z][\-a-z]*\.md))?`)

// SpecRef represents a parsed cross-reference to another spec.
type SpecRef struct {
	TaskSlug string // referenced task slug
	File     string // optional: specific file (e.g., "design.md"), empty for whole spec
	Raw      string // original matched text
}

// ResolvedRef is a SpecRef with existence validation.
type ResolvedRef struct {
	SpecRef
	Exists         bool   // true if the referenced spec/file exists
	DanglingReason string // reason if not exists (e.g., "spec deleted", "file not found")
}

// ParseRefs extracts all @spec: references from content.
func ParseRefs(content string) []SpecRef {
	matches := refRe.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool)
	var refs []SpecRef
	for _, m := range matches {
		raw := m[0]
		if seen[raw] {
			continue
		}
		seen[raw] = true
		refs = append(refs, SpecRef{
			TaskSlug: m[1],
			File:     m[2],
			Raw:      raw,
		})
	}
	return refs
}

// ResolveRefs validates each SpecRef against the filesystem.
func ResolveRefs(projectPath string, refs []SpecRef) []ResolvedRef {
	resolved := make([]ResolvedRef, len(refs))
	for i, r := range refs {
		resolved[i].SpecRef = r
		sd := &SpecDir{ProjectPath: projectPath, TaskSlug: r.TaskSlug}
		if !sd.Exists() {
			resolved[i].Exists = false
			resolved[i].DanglingReason = "spec deleted"
			continue
		}
		if r.File != "" {
			if _, err := os.Stat(sd.FilePath(SpecFile(r.File))); err != nil {
				resolved[i].Exists = false
				resolved[i].DanglingReason = "file not found"
				continue
			}
		}
		resolved[i].Exists = true
	}
	return resolved
}

// outgoingRef is an outgoing reference from a specific file.
type outgoingRef struct {
	Target   string `json:"target"`   // e.g., "auth-refactor/design.md" or "auth-refactor"
	FromFile string `json:"from_file"`
	Exists   bool   `json:"exists"`
	Reason   string `json:"reason,omitempty"` // dangling reason
}

// incomingRef is an incoming reference from another spec.
type incomingRef struct {
	Source string `json:"source"` // e.g., "api-v2/requirements.md"
	ToFile string `json:"to_file"`
}

// CollectOutgoing parses all spec files for the given task and returns outgoing references.
func CollectOutgoing(projectPath, taskSlug string) []outgoingRef {
	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	var out []outgoingRef
	for _, f := range AllFiles {
		content, err := sd.ReadFile(f)
		if err != nil {
			continue
		}
		refs := ParseRefs(content)
		resolved := ResolveRefs(projectPath, refs)
		for _, r := range resolved {
			target := r.TaskSlug
			if r.File != "" {
				target += "/" + r.File
			}
			out = append(out, outgoingRef{
				Target:   target,
				FromFile: string(f),
				Exists:   r.Exists,
				Reason:   r.DanglingReason,
			})
		}
	}
	return out
}

// CollectIncoming scans all specs to find references pointing to the given task.
func CollectIncoming(projectPath, taskSlug string) []incomingRef {
	specsDir := SpecsDir(projectPath)
	entries, err := os.ReadDir(specsDir)
	if err != nil {
		return nil
	}

	var incoming []incomingRef
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), "_") || e.Name() == taskSlug {
			continue
		}
		otherSlug := e.Name()
		if !ValidSlug.MatchString(otherSlug) {
			continue // skip invalid directory names
		}
		otherSD := &SpecDir{ProjectPath: projectPath, TaskSlug: otherSlug}
		for _, f := range AllFiles {
			content, err := otherSD.ReadFile(f)
			if err != nil {
				continue
			}
			refs := ParseRefs(content)
			for _, r := range refs {
				if r.TaskSlug == taskSlug {
					toFile := ""
					if r.File != "" {
						toFile = r.File
					}
					incoming = append(incoming, incomingRef{
						Source: otherSlug + "/" + string(f),
						ToFile: toFile,
					})
				}
			}
		}
	}
	return incoming
}
