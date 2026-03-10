package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/hir4ta/claude-alfred/internal/install"
)

// configWarned ensures config validation warnings are emitted at most once per process.
var configWarned sync.Once

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

// knownConfigKeys lists all valid keys in .alfred/config.json for schema validation.
var knownConfigKeys = map[string]bool{
	"relevance_threshold":       true,
	"high_confidence_threshold": true,
	"single_keyword_dampen":     true,
	"crawl_interval_days":       true,
	"quiet":                     true,
	"custom_sources":            true,
}

// loadProjectConfig reads .alfred/config.json from the project root.
// Returns nil on any error (fail-open). Warns on parse errors and unknown keys.
func loadProjectConfig(projectPath string) *ProjectConfig {
	if projectPath == "" {
		return nil
	}
	path := filepath.Join(projectPath, ".alfred", "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			notifyUser("warning: failed to read %s: %v", path, err)
		}
		return nil
	}
	var cfg ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		configWarned.Do(func() {
			notifyUser("warning: invalid .alfred/config.json: %v", err)
		})
		return nil
	}
	// Validate unknown keys and value ranges (once per process).
	configWarned.Do(func() {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err == nil {
			for key := range raw {
				if !knownConfigKeys[key] {
					notifyUser("warning: unknown key %q in .alfred/config.json", key)
				}
			}
		}
		validateConfigRanges(&cfg)
	})
	return &cfg
}

// validateConfigRanges warns about out-of-range config values and clamps them.
func validateConfigRanges(cfg *ProjectConfig) {
	clampFloat := func(name string, v *float64) {
		if v != nil && (*v < 0 || *v > 1) {
			notifyUser("warning: %s=%.2f out of range [0,1], clamping", name, *v)
			clamped := max(0, min(1, *v))
			*v = clamped
		}
	}
	clampFloat("relevance_threshold", cfg.RelevanceThreshold)
	clampFloat("high_confidence_threshold", cfg.HighConfidenceThreshold)
	clampFloat("single_keyword_dampen", cfg.SingleKeywordDampen)
	if cfg.CrawlIntervalDays != nil && *cfg.CrawlIntervalDays <= 0 {
		notifyUser("warning: crawl_interval_days=%d must be positive, ignoring", *cfg.CrawlIntervalDays)
		cfg.CrawlIntervalDays = nil
	}
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

// resolveBool returns the first available value from: project config > env var.
func resolveBool(project *bool, envKey string) bool {
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
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		debugf("envInt: invalid %s=%q, using default %d", key, v, defaultVal)
		return defaultVal
	}
	return n
}
