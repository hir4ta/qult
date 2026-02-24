package install

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

const claudeMDMarker = "claude-buddy (session companion)"

const claudeMDBlock = `
## claude-buddy (session companion)
- Call ` + "`buddy_resume`" + ` at session start to restore previous context
- Use ` + "`buddy_recall`" + ` to search for details lost after auto-compact
- Use ` + "`buddy_decisions`" + ` to review past design decisions
`

// Run executes the install command. All steps are idempotent.
func Run() error {
	// Step 1: MCP registration
	registerMCP()

	// Step 2: CLAUDE.md update
	if err := updateClaudeMD(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: CLAUDE.md update failed: %v\n", err)
	}

	// Step 3: Hooks setup info
	printHooksInfo()

	// Step 4: Initial sync
	if err := initialSync(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: initial sync failed: %v\n", err)
	}

	// Step 5: Generate embeddings (if Ollama available)
	generateEmbeddings()

	return nil
}

func registerMCP() {
	binPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not determine binary path: %v\n", err)
		return
	}

	cmd := exec.Command("claude", "mcp", "add", "-s", "user", "claude-buddy", "--", binPath, "serve")
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("Warning: MCP registration: %v (%s)\n", err, strings.TrimSpace(string(output)))
	} else {
		fmt.Println("✓ MCP server registered")
	}
}

func updateClaudeMD() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}
	return updateClaudeMDAt(filepath.Join(home, ".claude", "CLAUDE.md"))
}

func updateClaudeMDAt(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", path, err)
	}

	if strings.Contains(string(existing), claudeMDMarker) {
		fmt.Println("✓ CLAUDE.md already configured")
		return nil
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	if _, err := f.WriteString(claudeMDBlock); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}

	fmt.Println("✓ CLAUDE.md updated")
	return nil
}

func printHooksInfo() {
	fmt.Println(`
ℹ Hooks setup (optional):
  To auto-call buddy_resume on SessionStart,
  add the following to ~/.claude/settings.json:

  {
    "hooks": {
      "SessionStart": [{
        "type": "tool_call",
        "tool": "buddy_resume"
      }]
    }
  }`)
}

func initialSync() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	if err := st.SyncAll(); err != nil {
		return fmt.Errorf("sync: %w", err)
	}

	// Count sessions and events for summary.
	var sessionCount, eventCount int
	row := st.DB().QueryRow("SELECT COUNT(*) FROM sessions")
	row.Scan(&sessionCount)
	row = st.DB().QueryRow("SELECT COUNT(*) FROM events")
	row.Scan(&eventCount)

	fmt.Printf("✓ Initial sync complete (%d sessions, %d events)\n", sessionCount, eventCount)
	return nil
}

func generateEmbeddings() {
	lang := locale.Detect()
	model := embedder.ModelForLocale(lang.Code)
	emb := embedder.NewEmbedder("", model)

	ctx := context.Background()
	if !emb.EnsureAvailable(ctx) {
		fmt.Println("ℹ Ollama not available — skipping embedding generation (FTS5 search only)")
		return
	}

	fmt.Printf("⏳ Generating embeddings (%s)...\n", model)

	st, err := store.OpenDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: embedding generation failed: %v\n", err)
		return
	}
	defer st.Close()

	count, err := st.EmbedPending(func(text string) ([]float32, error) {
		return emb.EmbedForStorage(ctx, text)
	}, model)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: embedding generation failed: %v\n", err)
		return
	}

	fmt.Printf("✓ Embeddings generated (%d patterns, model: %s)\n", count, model)
}
