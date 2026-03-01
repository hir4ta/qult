package hookhandler

import (
	"strings"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// domainKeywords maps domain names to detection keywords.
var domainKeywords = map[string][]string{
	"auth":     {"auth", "login", "logout", "password", "token", "jwt", "oauth", "session", "credential"},
	"database": {"database", "db", "sql", "query", "migration", "schema", "table", "index", "postgres", "sqlite", "mysql"},
	"ui":       {"ui", "component", "button", "form", "modal", "layout", "css", "style", "render", "display"},
	"api":      {"api", "endpoint", "handler", "route", "request", "response", "rest", "grpc", "middleware"},
	"config":   {"config", "setting", "env", "environment", "yaml", "toml", "json config"},
	"infra":    {"deploy", "docker", "ci", "cd", "pipeline", "kubernetes", "k8s", "terraform", "nginx"},
	"test":     {"test", "spec", "mock", "stub", "fixture", "assertion", "coverage"},
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

// inferDomainFromFiles determines domain from recently touched files
// when the prompt text alone doesn't reveal it.
func inferDomainFromFiles(sdb *sessiondb.SessionDB) string {
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return "general"
	}

	scores := make(map[string]int)
	for _, f := range files {
		fl := strings.ToLower(f)
		for domain, keywords := range domainKeywords {
			for _, kw := range keywords {
				if strings.Contains(fl, kw) {
					scores[domain]++
				}
			}
		}
	}

	best := "general"
	bestScore := 0
	for domain, score := range scores {
		if score > bestScore {
			bestScore = score
			best = domain
		}
	}
	return best
}
