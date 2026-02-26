package hookhandler

import "testing"

func TestClassifyIntent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prompt string
		want   TaskType
	}{
		{"bugfix english", "fix the login error", TaskBugfix},
		{"bugfix japanese", "ログインのバグを修正して", TaskBugfix},
		{"feature english", "add a new export button", TaskFeature},
		{"feature japanese", "新しいボタンを追加して", TaskFeature},
		{"refactor english", "refactor the auth module", TaskRefactor},
		{"refactor japanese", "認証モジュールをリファクタして", TaskRefactor},
		{"test english", "add test coverage for parser", TaskTest},
		{"test japanese", "パーサーのテストを書いて", TaskTest},
		{"unknown", "hello", TaskUnknown},
		{"empty", "", TaskUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyIntent(tt.prompt)
			if got != tt.want {
				t.Errorf("classifyIntent(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestClassifyIntentLLM_FallsBackToKeyword(t *testing.T) {
	t.Parallel()
	// Without a valid sessiondb, classifyIntentLLM should fall back to keyword matching.
	// Pass nil-safe: NewFromSessionDB returns nil → keyword fallback.
	tests := []struct {
		name   string
		prompt string
		want   TaskType
	}{
		{"bugfix fallback", "fix the crash on startup", TaskBugfix},
		{"feature fallback", "implement dark mode", TaskFeature},
		{"unknown fallback", "what time is it", TaskUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyIntentLLM(nil, tt.prompt)
			if got != tt.want {
				t.Errorf("classifyIntentLLM(nil, %q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}
