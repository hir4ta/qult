package hookhandler

import (
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// DeepIntent represents a 5-layer understanding of the user's current task.
type DeepIntent struct {
	TaskType      TaskType      // Level 1: bugfix/feature/refactor/test/explore/debug/review/docs
	Domain        string        // Level 2: auth/database/ui/api/config/infra/general
	WorkflowPhase Phase         // Level 3: reused from phases.go
	RiskProfile   string        // Level 4: conservative/balanced/aggressive
	ImplicitGoal  *ImplicitGoal // Level 5: inferred goal from session signals
	Confidence    float64       // overall confidence [0, 1]
}

// ImplicitGoal represents an inferred goal that the user did not explicitly state.
// Derived from session state signals (velocity, errors, file context) combined
// with prompt cues like "faster", "simpler", "clean up".
type ImplicitGoal struct {
	Goal       string   // profiling, indexing, caching, refactor, cleanup, hotfix, integration
	Confidence float64  // 0.0-1.0
	Signals    []string // which signals contributed to the inference
}

// AnalyzeDeepIntent builds a 5-layer intent model from the user prompt and session state.
func AnalyzeDeepIntent(sdb *sessiondb.SessionDB, prompt string, taskType TaskType) *DeepIntent {
	di := &DeepIntent{
		TaskType:    taskType,
		Domain:      detectDomain(prompt),
		RiskProfile: inferRiskProfile(sdb),
		Confidence:  0.5,
	}

	// Level 3: reuse existing phase detection.
	if progress := GetPhaseProgress(sdb); progress != nil {
		di.WorkflowPhase = progress.CurrentPhase
	}

	// Level 5: infer implicit goal from session signals + prompt cues.
	di.ImplicitGoal = inferImplicitGoal(sdb, prompt, di.Domain)

	// Confidence: higher when more layers are populated.
	populated := 0
	if di.TaskType != TaskUnknown {
		populated++
	}
	if di.Domain != "general" {
		populated++
	}
	if di.WorkflowPhase != PhaseUnknown {
		populated++
	}
	if di.RiskProfile != "" {
		populated++
	}
	if di.ImplicitGoal != nil {
		populated++
	}
	di.Confidence = float64(populated) / 5.0

	return di
}

// promptGoalCues maps prompt keywords to candidate implicit goals.
// Each cue can produce different goals depending on session context.
var promptGoalCues = map[string][]string{
	"profiling": {"faster", "slow", "performance", "latency", "throughput", "速く", "遅い", "パフォーマンス", "レイテンシ"},
	"caching":   {"cache", "memoize", "precompute", "キャッシュ", "メモ化"},
	"cleanup":   {"clean", "tidy", "remove", "delete", "unused", "dead code", "掃除", "削除", "不要"},
	"refactor":  {"simplify", "reorganize", "decouple", "extract", "シンプル", "分離", "切り出"},
	"security":  {"secure", "vulnerability", "inject", "xss", "csrf", "sanitize", "セキュリティ", "脆弱性"},
	"scaling":   {"scale", "concurrent", "parallel", "batch", "queue", "スケール", "並行", "並列"},
}

// inferImplicitGoal derives an implicit goal from session signals and prompt cues.
// Uses deterministic heuristics only (no LLM calls) to stay under 1ms.
func inferImplicitGoal(sdb *sessiondb.SessionDB, prompt string, domain string) *ImplicitGoal {
	if prompt == "" {
		return nil
	}
	lower := strings.ToLower(prompt)

	type candidate struct {
		goal       string
		confidence float64
		signals    []string
	}
	var candidates []candidate

	// Signal 1: Prompt cue + domain context refinement.
	for goal, cues := range promptGoalCues {
		for _, cue := range cues {
			if !strings.Contains(lower, cue) {
				continue
			}
			c := candidate{goal: goal, confidence: 0.6, signals: []string{"prompt_cue:" + cue}}

			// Refine based on domain context.
			switch {
			case goal == "profiling" && domain == "database":
				c.goal = "indexing"
				c.confidence = 0.8
				c.signals = append(c.signals, "domain:database")
			case goal == "profiling" && domain == "api":
				c.goal = "latency_optimization"
				c.confidence = 0.7
				c.signals = append(c.signals, "domain:api")
			case goal == "refactor" && domain == "test":
				c.goal = "test_refactor"
				c.confidence = 0.7
				c.signals = append(c.signals, "domain:test")
			}
			candidates = append(candidates, c)
			break // one match per goal group is enough
		}
	}

	// Signals 2-4 require session state.
	if sdb != nil {
		// Signal 2: Unresolved failures → hotfix goal.
		failCount, _ := sdb.GetContext("unresolved_failure_count")
		if failCount != "" && failCount != "0" {
			hasErrorCue := strings.Contains(lower, "fix") || strings.Contains(lower, "error") ||
				strings.Contains(lower, "fail") || strings.Contains(lower, "直") || strings.Contains(lower, "修正")
			if hasErrorCue {
				candidates = append(candidates, candidate{
					goal:       "hotfix",
					confidence: 0.8,
					signals:    []string{"unresolved_failures", "prompt_cue:fix"},
				})
			}
		}

		// Signal 3: Velocity context — slow velocity + performance cue → profiling.
		vel := getFloat(sdb, "ewma_tool_velocity")
		if vel > 0 && vel < 2.0 {
			for _, cue := range promptGoalCues["profiling"] {
				if strings.Contains(lower, cue) {
					for i := range candidates {
						if candidates[i].goal == "profiling" || candidates[i].goal == "indexing" || candidates[i].goal == "latency_optimization" {
							candidates[i].confidence += 0.15
							candidates[i].signals = append(candidates[i].signals, "low_velocity")
						}
					}
					break
				}
			}
		}

		// Signal 4: File context — recent files hint at implicit domain.
		files, _ := sdb.GetWorkingSetFiles()
		if len(files) > 0 {
			for i := range candidates {
				for _, f := range files {
					fl := strings.ToLower(f)
					switch {
					case candidates[i].goal == "profiling" && (strings.Contains(fl, "bench") || strings.Contains(fl, "perf")):
						candidates[i].confidence += 0.1
						candidates[i].signals = append(candidates[i].signals, "file_context:benchmark")
					case candidates[i].goal == "security" && (strings.Contains(fl, "auth") || strings.Contains(fl, "token")):
						candidates[i].confidence += 0.1
						candidates[i].signals = append(candidates[i].signals, "file_context:auth")
					}
				}
			}
		}
	}

	if len(candidates) == 0 {
		return nil
	}

	// Pick highest confidence candidate.
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.confidence > best.confidence {
			best = c
		}
	}

	// Only return if confidence is meaningful.
	if best.confidence < 0.5 {
		return nil
	}
	if best.confidence > 1.0 {
		best.confidence = 1.0
	}

	return &ImplicitGoal{
		Goal:       best.goal,
		Confidence: best.confidence,
		Signals:    best.signals,
	}
}

// domainKeywords maps domain names to detection keywords.
var domainKeywords = map[string][]string{
	"auth":     {"auth", "login", "logout", "password", "token", "jwt", "oauth", "session", "credential", "認証", "ログイン"},
	"database": {"database", "db", "sql", "query", "migration", "schema", "table", "index", "postgres", "sqlite", "mysql", "データベース"},
	"ui":       {"ui", "component", "button", "form", "modal", "layout", "css", "style", "render", "display", "画面", "表示"},
	"api":      {"api", "endpoint", "handler", "route", "request", "response", "rest", "grpc", "middleware", "エンドポイント"},
	"config":   {"config", "setting", "env", "environment", "yaml", "toml", "json config", "設定", "環境"},
	"infra":    {"deploy", "docker", "ci", "cd", "pipeline", "kubernetes", "k8s", "terraform", "nginx", "デプロイ", "インフラ"},
	"test":     {"test", "spec", "mock", "stub", "fixture", "assertion", "coverage", "テスト", "カバレッジ"},
}

// detectDomain classifies the task domain from the user prompt using keyword matching.
func detectDomain(prompt string) string {
	lower := strings.ToLower(prompt)

	bestDomain := "general"
	bestScore := 0

	for domain, keywords := range domainKeywords {
		score := 0
		for _, kw := range keywords {
			if strings.Contains(lower, kw) {
				score++
			}
		}
		if score > bestScore {
			bestScore = score
			bestDomain = domain
		}
	}

	return bestDomain
}

// inferRiskProfile determines the user's risk profile from behavioral data.
// Thresholds are aligned with store.UserCluster() for consistency:
// conservative: read_write_ratio > 3.0, test_frequency > 0.7
// aggressive: read_write_ratio < 1.5, test_frequency < 0.3
// balanced: everything else
// Additionally uses session velocity as a third signal.
func inferRiskProfile(sdb *sessiondb.SessionDB) string {
	st, err := store.OpenDefault()
	if err != nil {
		return "balanced"
	}
	defer st.Close()

	readWriteRatio, rwCount, _ := st.GetUserProfile("read_write_ratio")
	testFreq, tfCount, _ := st.GetUserProfile("test_frequency")

	// Need sufficient data to classify.
	if rwCount < 3 && tfCount < 3 {
		return "balanced"
	}

	conservative := 0
	aggressive := 0

	// Thresholds match store.UserCluster() for consistency.
	if rwCount >= 3 {
		if readWriteRatio > 3.0 {
			conservative++
		} else if readWriteRatio < 1.5 {
			aggressive++
		}
	}

	if tfCount >= 3 {
		if testFreq > 0.7 {
			conservative++
		} else if testFreq < 0.3 {
			aggressive++
		}
	}

	// Velocity can also indicate risk appetite.
	vel := getFloat(sdb, "ewma_tool_velocity")
	if vel > 10.0 {
		aggressive++
	} else if vel < 3.0 && vel > 0 {
		conservative++
	}

	switch {
	case conservative >= 2:
		return "conservative"
	case aggressive >= 2:
		return "aggressive"
	default:
		return "balanced"
	}
}
