package main

import (
	"context"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// contextBoostCap is the maximum additive boost from spec/session context.
const contextBoostCap = 0.15

// contextBoostTiebreakerRange limits context boost to candidates whose
// base score is within this range of each other (prevents low-scoring docs
// from being promoted above high-scoring ones).
const contextBoostTiebreakerRange = 0.10

// specContext holds extracted spec/session keywords for contextual boosting.
type specContext struct {
	keywords []string // significant keywords from session.md context
}

// loadSpecContext reads the active spec's session.md and extracts keywords
// from "Currently Working On" and "Next Steps" sections.
// Returns nil if no spec is active or on any error (fail-open).
func loadSpecContext(projectPath string) *specContext {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return nil
	}
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		return nil
	}

	// Extract keywords from "Currently Working On" and "Next Steps".
	workingOn := extractSection(session, "## Currently Working On")
	nextSteps := extractSectionFallback(session, "## Next Steps", "## Pending")

	combined := workingOn
	if nextSteps != "" {
		combined += " " + nextSteps
	}
	combined = strings.TrimSpace(combined)
	if combined == "" {
		return nil
	}

	keywords := extractSearchKeywords(combined, 8)
	if keywords == "" {
		return nil
	}

	return &specContext{
		keywords: strings.Fields(keywords),
	}
}

// searchSpecContext performs a supplemental FTS search using spec/session keywords.
// Returns additional doc candidates (up to 5) that may be relevant to the current task.
//
// Note: This intentionally bypasses the Claude Code keyword gate (Gate 1) used by
// the main injection pipeline. Spec/session keywords may include non-Claude-Code terms.
// The tiebreaker semantics in applyContextBoost prevent these from dominating results.
func searchSpecContext(ctx context.Context, sc *specContext, st *store.Store) []store.DocRow {
	if sc == nil || len(sc.keywords) == 0 {
		return nil
	}

	query := store.JoinFTS5Terms(sc.keywords)
	docs, err := st.SearchDocsFTS(ctx, query, store.SourceDocs, 5)
	if err != nil {
		debugf("searchSpecContext: FTS search failed: %v", err)
		return nil
	}
	debugf("searchSpecContext: found %d candidates for keywords=%v", len(docs), sc.keywords)
	return docs
}

// applyContextBoost adds a post-scoring boost to candidates based on spec context.
// Uses tiebreaker semantics: boost only applies when the candidate's base score
// is within contextBoostTiebreakerRange of the top score.
// Candidates must be sorted by score descending (highest first).
//
// Returns the set of boosted doc IDs for labeling in output.
func applyContextBoost(candidates []scored, sc *specContext) map[int64]bool {
	if sc == nil || len(sc.keywords) == 0 || len(candidates) == 0 {
		return nil
	}

	topScore := candidates[0].score
	boostedIDs := make(map[int64]bool)

	for i := range candidates {
		// Only boost candidates in tiebreaker range of the top score.
		if topScore-candidates[i].score > contextBoostTiebreakerRange {
			continue
		}

		doc := candidates[i].doc
		contentLower := strings.ToLower(doc.Content)
		pathLower := strings.ToLower(doc.SectionPath)

		// Count keyword hits in doc content and path.
		hits := 0
		for _, kw := range sc.keywords {
			kwLower := strings.ToLower(kw)
			if strings.Contains(contentLower, kwLower) || strings.Contains(pathLower, kwLower) {
				hits++
			}
		}

		if hits == 0 {
			continue
		}

		// Proportional boost: more keyword hits = stronger boost, capped.
		boost := float64(hits) / float64(len(sc.keywords)) * contextBoostCap
		if boost > contextBoostCap {
			boost = contextBoostCap
		}
		candidates[i].score += boost
		boostedIDs[doc.ID] = true
	}

	return boostedIDs
}
