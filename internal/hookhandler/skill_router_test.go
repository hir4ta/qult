package hookhandler

import (
	"strings"
	"testing"
)

func TestSkillHintForPattern(t *testing.T) {
	t.Parallel()

	tests := []struct {
		pattern    string
		wantSkill  string
		wantEmpty  bool
		wantDeny   bool
	}{
		{pattern: "retry-loop", wantSkill: "alfred-recover"},
		{pattern: "code-quality", wantSkill: "alfred-recover"},
		{pattern: "test-correlation", wantSkill: "alfred-recover"},
		{pattern: "stale-read", wantEmpty: true},
		{pattern: "past-solution", wantSkill: "alfred-recover"},
		{pattern: "file-knowledge", wantSkill: "alfred-recover"},
		{pattern: "workflow", wantSkill: "alfred-gate"},
		{pattern: "strategic", wantEmpty: true},
		{pattern: "playbook", wantEmpty: true},
		{pattern: "unknown-pattern", wantEmpty: true},
	}

	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			t.Parallel()
			got := SkillHintForPattern(tt.pattern)
			if tt.wantEmpty {
				if got != "" {
					t.Errorf("SkillHintForPattern(%q) = %q, want empty", tt.pattern, got)
				}
				return
			}
			if !strings.Contains(got, tt.wantSkill) {
				t.Errorf("SkillHintForPattern(%q) = %q, want skill %q", tt.pattern, got, tt.wantSkill)
			}
			if !strings.Contains(got, "Recommended: invoke skill=") {
				t.Errorf("SkillHintForPattern(%q) missing standard hint prefix", tt.pattern)
			}
		})
	}
}

func TestSkillHintForEpisode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		episode   string
		wantSkill string
		wantEmpty bool
		wantDeny  bool
	}{
		{episode: "retry_cascade", wantSkill: "alfred-recover", wantDeny: true},
		{episode: "edit_fail_spiral", wantSkill: "alfred-recover", wantDeny: true},
		{episode: "test_fail_fixup", wantSkill: "alfred-recover", wantDeny: true},
		{episode: "explore_to_stuck", wantSkill: "alfred-gate"},
		{episode: "context_overload", wantSkill: "alfred-context-recovery", wantDeny: true},
		{episode: "learned_episode", wantSkill: "alfred-recover"},
		{episode: "trajectory_match", wantSkill: "alfred-recover"},
		{episode: "unknown_episode", wantEmpty: true},
	}

	for _, tt := range tests {
		t.Run(tt.episode, func(t *testing.T) {
			t.Parallel()
			got := SkillHintForEpisode(tt.episode)
			if tt.wantEmpty {
				if got != "" {
					t.Errorf("SkillHintForEpisode(%q) = %q, want empty", tt.episode, got)
				}
				return
			}
			if !strings.Contains(got, tt.wantSkill) {
				t.Errorf("SkillHintForEpisode(%q) = %q, want skill %q", tt.episode, got, tt.wantSkill)
			}
			if tt.wantDeny {
				if !strings.Contains(got, "before continuing") {
					t.Errorf("SkillHintForEpisode(%q) should contain 'before continuing', got %q", tt.episode, got)
				}
			} else {
				if !strings.Contains(got, "Recommended:") {
					t.Errorf("SkillHintForEpisode(%q) should use standard hint (Recommended), got %q", tt.episode, got)
				}
			}
		})
	}
}

func TestSkillHintForPhase(t *testing.T) {
	t.Parallel()

	tests := []struct {
		phase     string
		wantSkill string
		wantEmpty bool
	}{
		{phase: "explore", wantSkill: "alfred-forecast"},
		{phase: "read", wantSkill: "alfred-forecast"},
		{phase: "implement", wantSkill: "alfred-analyze"},
		{phase: "write", wantSkill: "alfred-analyze"},
		{phase: "test", wantSkill: "alfred-gate"},
		{phase: "verify", wantSkill: "alfred-gate"},
		{phase: "compile", wantSkill: "alfred-gate"},
		{phase: "unknown", wantEmpty: true},
		{phase: "", wantEmpty: true},
	}

	for _, tt := range tests {
		name := tt.phase
		if name == "" {
			name = "empty"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got := SkillHintForPhase(tt.phase)
			if tt.wantEmpty {
				if got != "" {
					t.Errorf("SkillHintForPhase(%q) = %q, want empty", tt.phase, got)
				}
				return
			}
			if !strings.Contains(got, tt.wantSkill) {
				t.Errorf("SkillHintForPhase(%q) = %q, want skill %q", tt.phase, got, tt.wantSkill)
			}
		})
	}
}
