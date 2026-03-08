package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// KatakanaToEnglish maps Japanese technical terms to their English equivalents
// for FTS query translation. Covers common Claude Code terminology.
// Exported for use by hook handlers that need pre-translation.
var KatakanaToEnglish = map[string]string{
	// Katakana
	"フック":      "hook",
	"スキル":      "skill",
	"ルール":      "rule",
	"エージェント":   "agent",
	"プラグイン":    "plugin",
	"コンパクト":    "compact",
	"メモリ":       "memory",
	"ショートカット":  "shortcut",
	"ワークツリー":   "worktree",
	"コンテキスト":   "context",
	"サーバー":     "server",
	"セキュリティ":   "security",
	"パフォーマンス": "performance",
	"ワークフロー":   "workflow",
	"キーバインド":   "keybinding",
	"コマンド":     "command",
	"テンプレート":   "template",
	"テスト":      "test",
	"デプロイ":     "deploy",
	"サンドボックス":  "sandbox",
	"セッション":    "session",
	"トークン":     "token",
	"モデル":      "model",
	"ツール":      "tool",
	"レイアウト":    "layout",
	// Kanji
	"設定":   "settings",
	"権限":   "permission",
	"自動化":  "automation",
	"検索":   "search",
	"設定ファイル": "settings",
}

var (
	mergedDictOnce sync.Once
	mergedDict     map[string]string
)

// mergedKatakanaDict returns the KatakanaToEnglish map merged with any
// user-defined dictionary at ~/.claude-alfred/dictionary.json.
// The user dictionary overrides built-in entries.
func mergedKatakanaDict() map[string]string {
	mergedDictOnce.Do(func() {
		mergedDict = make(map[string]string, len(KatakanaToEnglish))
		for k, v := range KatakanaToEnglish {
			mergedDict[k] = v
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		data, err := os.ReadFile(filepath.Join(home, ".claude-alfred", "dictionary.json"))
		if err != nil {
			return // file not found is normal
		}
		var userDict map[string]string
		if err := json.Unmarshal(data, &userDict); err != nil {
			return
		}
		for k, v := range userDict {
			mergedDict[k] = v
		}
	})
	return mergedDict
}

// TranslateTerm returns the English equivalent for a Japanese term,
// checking both the built-in and user-defined dictionaries.
// Returns the term unchanged and false if no translation exists.
func TranslateTerm(term string) (string, bool) {
	dict := mergedKatakanaDict()
	en, ok := dict[term]
	return en, ok
}

// TranslateQuery replaces Japanese terms with English equivalents.
// ASCII-only input is returned unchanged (fast path).
// Uses the merged built-in + user-defined dictionary.
func TranslateQuery(query string) string {
	if isAllASCII(query) {
		return query
	}
	dict := mergedKatakanaDict()
	result := query
	for ja, en := range dict {
		if strings.Contains(result, ja) {
			result = strings.ReplaceAll(result, ja, en)
		}
	}
	return strings.TrimSpace(result)
}

func isAllASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// CorrectTypos attempts to fix misspelled words using the vocabulary
// extracted from docs section_paths. Returns the corrected query.
// Words already in the vocabulary are left unchanged.
func (s *Store) CorrectTypos(query string) string {
	vocab := s.loadVocab()
	if len(vocab) == 0 {
		return query
	}

	words := strings.Fields(query)
	changed := false
	for i, w := range words {
		lw := strings.ToLower(w)
		if len(lw) < 3 || vocab[lw] {
			continue
		}
		// Strip trailing wildcard for vocab check.
		bare := strings.TrimSuffix(lw, "*")
		if vocab[bare] {
			continue
		}

		// Max edit distance scales with word length.
		maxDist := 2
		if len(bare) <= 4 {
			maxDist = 1
		}

		best := ""
		bestDist := maxDist + 1
		for term := range vocab {
			ld := intAbs(len(term) - len(bare))
			if ld >= bestDist {
				continue // can't be closer
			}
			d := levenshtein(bare, term)
			if d < bestDist {
				bestDist = d
				best = term
				if d == 1 {
					break // good enough
				}
			}
		}
		if best != "" && bestDist <= maxDist {
			words[i] = best
			changed = true
		}
	}
	if !changed {
		return query
	}
	return strings.Join(words, " ")
}

// loadVocab lazily builds the vocabulary from docs section_paths.
func (s *Store) loadVocab() map[string]bool {
	s.vocabMu.Lock()
	defer s.vocabMu.Unlock()
	if !s.vocabReady {
		s.vocabTerms = s.buildVocab()
		s.vocabReady = true
	}
	return s.vocabTerms
}

func (s *Store) buildVocab() map[string]bool {
	terms := make(map[string]bool, 2000)

	rows, err := s.db.Query(`SELECT section_path FROM docs`)
	if err != nil {
		return terms
	}
	defer rows.Close()

	for rows.Next() {
		var sp string
		if err := rows.Scan(&sp); err != nil {
			continue
		}
		for _, w := range extractTerms(sp) {
			lw := strings.ToLower(w)
			if len(lw) >= 2 {
				terms[lw] = true
			}
		}
	}
	return terms
}

// extractTerms splits text into word tokens (letters and digits).
func extractTerms(s string) []string {
	var words []string
	var buf strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			buf.WriteRune(r)
		} else if buf.Len() > 0 {
			words = append(words, buf.String())
			buf.Reset()
		}
	}
	if buf.Len() > 0 {
		words = append(words, buf.String())
	}
	return words
}

// levenshtein computes the edit distance between two strings.
func levenshtein(a, b string) int {
	la := utf8.RuneCountInString(a)
	lb := utf8.RuneCountInString(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	ra := []rune(a)
	rb := []rune(b)

	prev := make([]int, lb+1)
	curr := make([]int, lb+1)

	for j := 0; j <= lb; j++ {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			del := prev[j] + 1
			ins := curr[j-1] + 1
			sub := prev[j-1] + cost
			curr[j] = min(del, ins, sub)
		}
		prev, curr = curr, prev
	}
	return prev[lb]
}

func intAbs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// ResetVocabCache clears the cached vocabulary, forcing a rebuild on next use.
// Used in tests to ensure fresh vocabulary after inserting new docs.
func (s *Store) ResetVocabCache() {
	s.vocabMu.Lock()
	defer s.vocabMu.Unlock()
	s.vocabReady = false
	s.vocabTerms = nil
}
