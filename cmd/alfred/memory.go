package main

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strconv"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// defaultMemoryMaxAgeDays is the default maximum age for memory pruning.
const defaultMemoryMaxAgeDays = 180

func memoryMaxAgeDays() int {
	if v := os.Getenv("ALFRED_MEMORY_MAX_AGE_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultMemoryMaxAgeDays
}

func runMemory() error {
	if len(os.Args) < 3 {
		fmt.Println(`alfred memory — manage persistent memories

Commands:
  prune [--confirm]    Remove old memories (default: dry-run preview)
  stats                Show memory statistics

Options:
  --max-age DAYS       Maximum age in days (default: 180, env: ALFRED_MEMORY_MAX_AGE_DAYS)`)
		return nil
	}

	switch os.Args[2] {
	case "prune":
		return runMemoryPrune()
	case "stats":
		return runMemoryStats()
	default:
		return fmt.Errorf("unknown memory command: %s", os.Args[2])
	}
}

func runMemoryPrune() error {
	confirm := slices.Contains(os.Args[2:], "--confirm")
	maxAge := memoryMaxAgeDays()

	// Parse --max-age flag.
	for i := 2; i < len(os.Args)-1; i++ {
		if os.Args[i] == "--max-age" {
			if n, err := strconv.Atoi(os.Args[i+1]); err == nil && n > 0 {
				maxAge = n
			}
		}
	}

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()
	cutoff := time.Now().AddDate(0, 0, -maxAge).Format(time.RFC3339)

	count, err := st.CountDocsBySourceTypeAndAge(ctx, store.SourceMemory, cutoff)
	if err != nil {
		return fmt.Errorf("count: %w", err)
	}

	if count == 0 {
		fmt.Printf("No memories older than %d days.\n", maxAge)
		return nil
	}

	warnStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))

	if !confirm {
		// Dry-run: show what would be deleted.
		fmt.Printf("Found %s older than %d days:\n\n",
			warnStyle.Render(fmt.Sprintf("%d memories", count)), maxAge)

		items, err := st.ListMemoriesBefore(ctx, cutoff, 20)
		if err != nil {
			return fmt.Errorf("list: %w", err)
		}
		for _, item := range items {
			dateStr := item.CrawledAt
			if len(item.CrawledAt) >= 10 {
				dateStr = item.CrawledAt[:10]
			}
			fmt.Printf("  %s  %s\n", mutedStyle.Render(dateStr), item.SectionPath)
		}
		if count > 20 {
			fmt.Printf("  %s\n", mutedStyle.Render(fmt.Sprintf("... and %d more", count-20)))
		}
		fmt.Printf("\nRun with --confirm to delete. Consider 'alfred export' first.\n")
		return nil
	}

	// Actually delete (with embedding cleanup).
	deleted, err := st.DeleteMemoriesBefore(ctx, cutoff)
	if err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	fmt.Printf("Deleted %d memories older than %d days.\n", deleted, maxAge)
	return nil
}

func runMemoryStats() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()

	total, err := st.CountDocsBySourceType(ctx, store.SourceMemory)
	if err != nil {
		return fmt.Errorf("count: %w", err)
	}

	fmt.Printf("Total memories: %d\n", total)

	stats, err := st.MemoryStatsByProject(ctx, 0)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}

	fmt.Println()
	for _, s := range stats {
		oldDate := s.Oldest
		if len(s.Oldest) >= 10 {
			oldDate = s.Oldest[:10]
		}
		newDate := s.Newest
		if len(s.Newest) >= 10 {
			newDate = s.Newest[:10]
		}
		fmt.Printf("  %-30s %3d memories  (%s — %s)\n", s.Project, s.Count, oldDate, newDate)
	}
	return nil
}
