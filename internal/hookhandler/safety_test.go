package hookhandler

import (
	"encoding/json"
	"testing"
)

func TestInjectRmInteractive(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		cmd  string
		want string
	}{
		{"bare rm", "rm foo.txt", "rm -i foo.txt"},
		{"rm with -r", "rm -r dir/", "rm -ri dir/"},
		{"rm with -rf unchanged", "rm -rf dir/", "rm -rf dir/"},
		{"rm already has -i", "rm -i foo.txt", "rm -i foo.txt"},
		{"rm -ri already", "rm -ri dir/", "rm -ri dir/"},
		{"no rm", "ls -la", "ls -la"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := injectRmInteractive(tt.cmd)
			if got != tt.want {
				t.Errorf("injectRmInteractive(%q) = %q, want %q", tt.cmd, got, tt.want)
			}
		})
	}
}

func TestCheckBashSafety(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name          string
		command       string
		wantUpdated   bool
		wantWarning   bool
	}{
		{"bare rm gets updatedInput", "rm foo.txt", true, true},
		{"rm -f no update", "rm -f foo.txt", false, false},
		{"rm -i no update", "rm -i foo.txt", false, false},
		{"git stash drop warns", "git stash drop", false, true},
		{"safe command no action", "go build .", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			input, _ := json.Marshal(map[string]string{"command": tt.command})
			result := checkBashSafety(input)

			if tt.wantUpdated {
				if result == nil || result.UpdatedInput == nil {
					t.Errorf("checkBashSafety(%q): want updatedInput, got nil", tt.command)
				}
			} else if tt.wantWarning {
				if result == nil || result.Warning == "" {
					t.Errorf("checkBashSafety(%q): want warning, got nil", tt.command)
				}
				if result != nil && result.UpdatedInput != nil {
					t.Errorf("checkBashSafety(%q): want no updatedInput, got %s", tt.command, result.UpdatedInput)
				}
			} else {
				if result != nil {
					t.Errorf("checkBashSafety(%q): want nil, got %+v", tt.command, result)
				}
			}
		})
	}
}
