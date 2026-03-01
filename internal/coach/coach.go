package coach

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// ErrClaudeNotFound indicates that the claude CLI is not in PATH.
var ErrClaudeNotFound = errors.New("coach: claude command not found in PATH")

// defaultTimeout is used when the caller passes zero Duration.
const defaultTimeout = 5 * time.Second

// cacheMaxAge controls how long cached LLM responses are considered valid.
const cacheMaxAge = 1 * time.Hour

// Generate calls `claude -p` with the given prompt and returns the response.
// If sdb is non-nil, responses are cached in the llm_cache table keyed by
// SHA-256 of the prompt. A zero timeout defaults to 5s.
func Generate(ctx context.Context, sdb *sessiondb.SessionDB, prompt string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	hash := promptHash(prompt)

	// Check cache.
	if sdb != nil {
		if cached, ok := sdb.GetCachedLLMResponse(hash, cacheMaxAge); ok {
			return cached, nil
		}
	}

	// Verify claude is available.
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		return "", ErrClaudeNotFound
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, claudePath, "-p", prompt)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("coach: claude -p: %w", err)
	}

	response := strings.TrimSpace(string(out))

	// Store in cache.
	if sdb != nil && response != "" {
		_ = sdb.SetCachedLLMResponse(hash, response, "claude-cli")
	}

	return response, nil
}

// promptHash returns the hex-encoded SHA-256 of prompt.
func promptHash(prompt string) string {
	h := sha256.Sum256([]byte(prompt))
	return fmt.Sprintf("%x", h)
}
