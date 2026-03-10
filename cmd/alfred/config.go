package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/hir4ta/claude-alfred/internal/install"
)

// ProjectConfig holds per-project threshold overrides.
// Loaded from .alfred/config.json. All fields are pointers so absent vs zero is distinguishable.
type ProjectConfig struct {
	RelevanceThreshold      *float64       `json:"relevance_threshold,omitempty"`
	HighConfidenceThreshold *float64       `json:"high_confidence_threshold,omitempty"`
	SingleKeywordDampen     *float64       `json:"single_keyword_dampen,omitempty"`
	CrawlIntervalDays       *int           `json:"crawl_interval_days,omitempty"`
	Quiet                   *bool          `json:"quiet,omitempty"`
	CustomSources           []CustomSource `json:"custom_sources,omitempty"`
}

// CustomSource defines a user-provided documentation URL for knowledge ingestion.
type CustomSource struct {
	URL   string `json:"url"`
	Label string `json:"label,omitempty"`
}

// loadProjectConfig reads .alfred/config.json from the project root.
// Returns nil on any error (fail-open).
func loadProjectConfig(projectPath string) *ProjectConfig {
	if projectPath == "" {
		return nil
	}
	path := filepath.Join(projectPath, ".alfred", "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			debugf("loadProjectConfig: read error: %v", err)
		}
		return nil
	}
	var cfg ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		debugf("loadProjectConfig: parse error: %v", err)
		return nil
	}
	return &cfg
}

// resolveFloat returns the first available value from: project config > env var > default.
func resolveFloat(project *float64, envKey string, defaultVal float64) float64 {
	if project != nil {
		return *project
	}
	return envFloat(envKey, defaultVal)
}

// resolveInt returns the first available value from: project config > env var > default.
func resolveInt(project *int, envKey string, defaultVal int) int {
	if project != nil && *project > 0 {
		return *project
	}
	return envInt(envKey, defaultVal)
}

// resolveBool returns the first available value from: project config > env var > default.
func resolveBool(project *bool, envKey, defaultVal string) bool {
	if project != nil {
		return *project
	}
	return os.Getenv(envKey) == "1"
}

// loadGlobalCustomSources reads ~/.claude-alfred/sources.json for global custom knowledge sources.
func loadGlobalCustomSources() []install.CustomSource {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	path := filepath.Join(home, ".claude-alfred", "sources.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var sources []CustomSource
	if err := json.Unmarshal(data, &sources); err != nil {
		return nil
	}
	result := make([]install.CustomSource, len(sources))
	for i, s := range sources {
		result[i] = install.CustomSource{URL: s.URL, Label: s.Label}
	}
	return result
}

// envInt returns the environment variable as int or the default value.
func envInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return defaultVal
		}
		n = n*10 + int(c-'0')
	}
	if n <= 0 {
		return defaultVal
	}
	return n
}
