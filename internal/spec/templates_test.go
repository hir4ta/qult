package spec

import (
	"strings"
	"testing"
)

func TestRenderForSizeFeature(t *testing.T) {
	t.Parallel()
	data := TemplateData{
		TaskSlug:    "test-render",
		Description: "Test rendering",
		Date:        "2026-03-16",
		SpecType:    "feature",
	}

	tests := []struct {
		name    string
		size    SpecSize
		wantLen int
	}{
		{"S", SizeS, 3},
		{"M", SizeM, 5},
		{"L", SizeL, 7},
		{"XL", SizeXL, 7},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rendered, err := RenderForSize(tc.size, TypeFeature, data)
			if err != nil {
				t.Fatalf("RenderForSize(%s, feature) = error %v", tc.size, err)
			}
			if len(rendered) != tc.wantLen {
				t.Errorf("RenderForSize(%s, feature) = %d files, want %d", tc.size, len(rendered), tc.wantLen)
			}
			// All rendered files should have content.
			for f, content := range rendered {
				if content == "" {
					t.Errorf("RenderForSize(%s, feature) file %s is empty", tc.size, f)
				}
			}
		})
	}
}

func TestRenderForSizeBugfix(t *testing.T) {
	t.Parallel()
	data := TemplateData{
		TaskSlug:    "fix-crash",
		Description: "Fix null pointer crash",
		Date:        "2026-03-16",
		SpecType:    "bugfix",
	}

	tests := []struct {
		name    string
		size    SpecSize
		wantLen int
	}{
		{"S", SizeS, 3},
		{"M", SizeM, 4},
		{"L", SizeL, 7},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rendered, err := RenderForSize(tc.size, TypeBugfix, data)
			if err != nil {
				t.Fatalf("RenderForSize(%s, bugfix) = error %v", tc.size, err)
			}
			if len(rendered) != tc.wantLen {
				t.Errorf("RenderForSize(%s, bugfix) = %d files, want %d", tc.size, len(rendered), tc.wantLen)
			}
			// Must have bugfix.md, not requirements.md.
			if _, ok := rendered[FileBugfix]; !ok {
				t.Errorf("RenderForSize(%s, bugfix) missing bugfix.md", tc.size)
			}
			if _, ok := rendered[FileRequirements]; ok {
				t.Errorf("RenderForSize(%s, bugfix) should not contain requirements.md", tc.size)
			}
		})
	}
}

func TestRenderForSizeBugfixTemplate(t *testing.T) {
	t.Parallel()
	data := TemplateData{
		TaskSlug:    "fix-race",
		Description: "Fix race condition in worker pool",
		Date:        "2026-03-16",
		SpecType:    "bugfix",
	}

	rendered, err := RenderForSize(SizeS, TypeBugfix, data)
	if err != nil {
		t.Fatalf("RenderForSize(S, bugfix) = error %v", err)
	}

	bugfix := rendered[FileBugfix]
	requiredSections := []string{
		"## Bug Summary",
		"## Reproduction Steps",
		"## Current Behavior",
		"## Expected Behavior",
		"## Unchanged Behavior",
		"## Root Cause Analysis",
		"## Fix Strategy",
	}
	for _, section := range requiredSections {
		if !strings.Contains(bugfix, section) {
			t.Errorf("bugfix.md missing section %q", section)
		}
	}
	if !strings.Contains(bugfix, "SHALL CONTINUE TO") {
		t.Error("bugfix.md Unchanged Behavior should use EARS 'SHALL CONTINUE TO' pattern")
	}
	if !strings.Contains(bugfix, "fix-race") {
		t.Error("bugfix.md should contain task slug")
	}
	if !strings.Contains(bugfix, "Fix race condition") {
		t.Error("bugfix.md should contain description")
	}
}
