package main

import "strings"

// claudeCodeKeywords are terms indicating a prompt is about Claude Code features.
// Proactive knowledge injection only fires when these are detected.
var claudeCodeKeywords = []string{
	// English
	"hook", "hooks", "skill", "skills",
	"rule", "rules", "subagent", "mcp", "claude.md",
	"memory.md", "claude code", "compact", "compaction",
	"plugin", "worktree", "slash command", "claude-code",
	"settings.json", "frontmatter", "permission",
	// Hook event names (unambiguous)
	"pretooluse", "sessionstart", "precompact", "userpromptsubmit",
	// Japanese — specific to Claude Code context.
	"フック", "スキル", "ルール", "エージェント",
	"プラグイン", "設定ファイル", "コンパクト",
}

// katakanaToEnglish maps Japanese katakana Claude Code terms to their English equivalents.
// Used to translate FTS queries so Japanese keywords find English documents.
var katakanaToEnglish = map[string]string{
	"フック":    "hook",
	"スキル":    "skill",
	"ルール":    "rule",
	"エージェント": "agent",
	"プラグイン":  "plugin",
	"コンパクト":  "compact",
	"設定ファイル": "settings",
}

// ambiguousKeywords maps keywords that are shared with other frameworks
// to framework identifiers that negate the Claude Code interpretation.
// Only well-known framework names are listed — not features or concepts.
var ambiguousKeywords = map[string][]string{
	"hook":       {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit"},
	"hooks":      {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit"},
	"フック":        {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit", "git hook"},
	"plugin":     {"webpack", "vite", "rollup", "babel", "eslint", "vim", "neovim", "wordpress", "jquery", "gradle", "maven"},
	"プラグイン":      {"webpack", "vite", "rollup", "babel", "eslint", "vim", "neovim", "wordpress", "jquery", "gradle", "maven"},
	"rule":       {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"rules":      {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"ルール":        {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"compact":    {"css", "json.stringify"},
	"compaction": {"leveldb", "rocksdb", "cassandra"},
	"コンパクト":      {"css", "json.stringify"},
	"skill":      {"alexa"},
	"skills":     {"alexa"},
	"スキル":        {"alexa"},
}

// claudeCodeKeywordsLower is the pre-lowered version of claudeCodeKeywords.
// Japanese keywords are unaffected by ToLower but included for consistency.
var claudeCodeKeywordsLower = func() []string {
	out := make([]string, len(claudeCodeKeywords))
	for i, kw := range claudeCodeKeywords {
		out[i] = strings.ToLower(kw)
	}
	return out
}()

// isASCIIString reports whether s contains only ASCII characters.
func isASCIIString(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// isWordBoundary reports whether byte b is a word boundary (not letter/digit).
func isWordBoundary(b byte) bool {
	return !((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_')
}

// containsWord checks if text contains word at a word boundary.
// For ASCII keywords only — prevents "hook" matching "hooking" or "webhook".
func containsWord(text, word string) bool {
	wlen := len(word)
	for i := 0; ; {
		pos := strings.Index(text[i:], word)
		if pos < 0 {
			return false
		}
		pos += i
		startOK := pos == 0 || isWordBoundary(text[pos-1])
		endOK := pos+wlen >= len(text) || isWordBoundary(text[pos+wlen])
		if startOK && endOK {
			return true
		}
		i = pos + 1
	}
}

// detectClaudeCodeKeywords returns Claude Code keywords found in the prompt.
// Uses word boundary matching for ASCII keywords, substring for CJK.
func detectClaudeCodeKeywords(prompt string) []string {
	lower := strings.ToLower(prompt)
	var found []string
	seen := make(map[string]bool)
	for _, kw := range claudeCodeKeywordsLower {
		if seen[kw] {
			continue
		}
		var matched bool
		if isASCIIString(kw) {
			matched = containsWord(lower, kw)
		} else {
			matched = strings.Contains(lower, kw)
		}
		if !matched {
			continue
		}
		// For ambiguous keywords (hook, plugin, rule, etc.), check if the prompt
		// mentions a specific framework that uses the same term. If so, skip —
		// UNLESS the prompt also contains explicit Claude Code context signals,
		// which indicates the user is discussing both topics.
		if frameworks, ok := ambiguousKeywords[kw]; ok {
			frameworkFound := false
			for _, fw := range frameworks {
				if strings.Contains(lower, fw) {
					frameworkFound = true
					break
				}
			}
			if frameworkFound && !hasClaudeCodeContext(lower) {
				continue
			}
		}
		seen[kw] = true
		found = append(found, kw)
	}
	return found
}

// claudeCodeContextSignals are unambiguous terms that confirm the user is
// discussing Claude Code, even when ambiguous keywords (hook, plugin, etc.)
// co-occur with framework names like "react" or "webpack".
var claudeCodeContextSignals = []string{
	"claude code", "claude-code", "alfred",
	"sessionstart", "precompact", "pretooluse", "userpromptsubmit",
	"claude.md", ".claude/", "compaction",
}

// hasClaudeCodeContext reports whether the lowercased prompt contains
// unambiguous Claude Code context signals.
func hasClaudeCodeContext(lower string) bool {
	for _, sig := range claudeCodeContextSignals {
		if strings.Contains(lower, sig) {
			return true
		}
	}
	return false
}

// isClaudeCodeRelated reports whether the prompt mentions Claude Code features.
func isClaudeCodeRelated(prompt string) bool {
	return len(detectClaudeCodeKeywords(prompt)) > 0
}
