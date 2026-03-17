package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/mcpserver"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// evalConfig defines the search-eval benchmark file format.
type evalConfig struct {
	Threshold float64    `yaml:"threshold"`
	Cases     []evalCase `yaml:"cases"`
}

type evalCase struct {
	Query    string   `yaml:"query"`
	Expected []string `yaml:"expected"`
}

// evalResult holds per-case metrics.
type evalResult struct {
	Query      string
	Expected   []string
	Got        []string
	Recall3    float64
	Recall5    float64
	Precision3 float64
	RR         float64 // reciprocal rank
}

// evalSummary aggregates all case results.
type evalSummary struct {
	Cases      int
	AvgRecall3 float64
	AvgRecall5 float64
	AvgPrec3   float64
	MRR        float64
	Pass       bool
}

func runSearchEval(evalFile string) error {
	data, err := os.ReadFile(evalFile)
	if err != nil {
		return fmt.Errorf("read eval file: %w", err)
	}

	var cfg evalConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("parse eval file: %w", err)
	}
	if cfg.Threshold <= 0 {
		cfg.Threshold = 0.6
	}
	if len(cfg.Cases) == 0 {
		return fmt.Errorf("no test cases found in %s", evalFile)
	}

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	var emb *embedder.Embedder
	if e, err := embedder.NewEmbedder(); err != nil {
		fmt.Fprintln(os.Stderr, "Warning: VOYAGE_API_KEY not set — evaluating keyword search only")
	} else {
		emb = e
		st.ExpectedDims = e.Dims()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	results := make([]evalResult, 0, len(cfg.Cases))
	for _, tc := range cfg.Cases {
		sr := mcpserver.SearchPipeline(ctx, st, emb, tc.Query, 5, 20)
		got := make([]string, 0, len(sr.Docs))
		for _, d := range sr.Docs {
			got = append(got, d.Title)
		}

		r := evalResult{
			Query:    tc.Query,
			Expected: tc.Expected,
			Got:      got,
		}

		// Compute metrics.
		r.Recall3 = recall(tc.Expected, got, 3)
		r.Recall5 = recall(tc.Expected, got, 5)
		r.Precision3 = precision(tc.Expected, got, 3)
		r.RR = reciprocalRank(tc.Expected, got)

		results = append(results, r)
	}

	// Compute summary.
	summary := evalSummary{Cases: len(results)}
	for _, r := range results {
		summary.AvgRecall3 += r.Recall3
		summary.AvgRecall5 += r.Recall5
		summary.AvgPrec3 += r.Precision3
		summary.MRR += r.RR
	}
	n := float64(summary.Cases)
	summary.AvgRecall3 /= n
	summary.AvgRecall5 /= n
	summary.AvgPrec3 /= n
	summary.MRR /= n
	summary.Pass = summary.AvgRecall3 >= cfg.Threshold

	// Print results.
	fmt.Printf("%-40s  R@3   R@5   P@3   MRR\n", "Query")
	fmt.Println(strings.Repeat("-", 72))
	for _, r := range results {
		q := r.Query
		if len([]rune(q)) > 38 {
			q = string([]rune(q)[:35]) + "..."
		}
		fmt.Printf("%-40s  %.2f  %.2f  %.2f  %.2f\n", q, r.Recall3, r.Recall5, r.Precision3, r.RR)
	}
	fmt.Println(strings.Repeat("-", 72))
	fmt.Printf("%-40s  %.2f  %.2f  %.2f  %.2f\n", "Average", summary.AvgRecall3, summary.AvgRecall5, summary.AvgPrec3, summary.MRR)

	verdict := "PASS"
	if !summary.Pass {
		verdict = "FAIL"
	}
	fmt.Printf("Threshold (R@3 >= %.2f)                  %s\n", cfg.Threshold, verdict)

	mcpserver.WaitBackground()

	if !summary.Pass {
		return fmt.Errorf("search quality below threshold: recall@3 = %.2f (threshold: %.2f)", summary.AvgRecall3, cfg.Threshold)
	}
	return nil
}

// recall computes recall@k: |expected ∩ got[:k]| / |expected|.
func recall(expected, got []string, k int) float64 {
	if len(expected) == 0 {
		return 1.0
	}
	top := got
	if len(top) > k {
		top = top[:k]
	}
	hits := 0
	for _, e := range expected {
		for _, g := range top {
			if strings.Contains(g, e) || strings.Contains(e, g) {
				hits++
				break
			}
		}
	}
	return float64(hits) / float64(len(expected))
}

// precision computes precision@k: |expected ∩ got[:k]| / k.
func precision(expected, got []string, k int) float64 {
	top := got
	if len(top) > k {
		top = top[:k]
	}
	if len(top) == 0 {
		return 0
	}
	hits := 0
	for _, g := range top {
		for _, e := range expected {
			if strings.Contains(g, e) || strings.Contains(e, g) {
				hits++
				break
			}
		}
	}
	return float64(hits) / float64(k)
}

// reciprocalRank returns 1/rank of the first expected item found in got.
func reciprocalRank(expected, got []string) float64 {
	for i, g := range got {
		for _, e := range expected {
			if strings.Contains(g, e) || strings.Contains(e, g) {
				return 1.0 / float64(i+1)
			}
		}
	}
	return 0
}
