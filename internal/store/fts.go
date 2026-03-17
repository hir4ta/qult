package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Sub-type constants used across the store package.
const (
	SubTypeGeneral  = "general"
	SubTypeDecision = "decision"
	SubTypePattern  = "pattern"
	SubTypeRule     = "rule"
)

// SearchKnowledgeFTS searches knowledge using FTS5 with tag alias expansion.
// Falls back to keyword LIKE search if FTS5 fails.
func (s *Store) SearchKnowledgeFTS(ctx context.Context, query string, limit int) ([]KnowledgeRow, error) {
	if limit <= 0 {
		limit = 10
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return s.SearchKnowledgeKeyword(ctx, "", limit)
	}

	// Expand query terms with aliases.
	words := strings.Fields(query)
	expanded, err := s.ExpandAliases(ctx, words)
	if err != nil {
		expanded = words
	}

	// Build FTS5 OR query.
	var ftsTerms []string
	for _, w := range expanded {
		w = sanitizeFTSTerm(w)
		if w != "" {
			ftsTerms = append(ftsTerms, `"`+w+`"`)
		}
	}
	if len(ftsTerms) == 0 {
		return s.SearchKnowledgeKeyword(ctx, query, limit)
	}
	ftsQuery := strings.Join(ftsTerms, " OR ")

	docs, err := s.searchFTSKnowledge(ctx, ftsQuery, limit)
	if err != nil {
		return s.SearchKnowledgeKeyword(ctx, query, limit)
	}

	// Supplement with fuzzy matching if too few results.
	if len(docs) < limit {
		fuzzyDocs := s.fuzzySearchKnowledge(ctx, words, limit-len(docs), docs)
		docs = append(docs, fuzzyDocs...)
	}

	return docs, nil
}

// searchFTSKnowledge runs FTS5 search on knowledge_fts.
func (s *Store) searchFTSKnowledge(ctx context.Context, ftsQuery string, limit int) ([]KnowledgeRow, error) {
	sqlQuery := `SELECT k.id, k.file_path, k.content_hash, k.title, k.content, k.sub_type,
		k.project_remote, k.project_path, k.project_name, k.branch,
		k.created_at, k.updated_at, k.hit_count, k.last_accessed, k.enabled,
		bm25(knowledge_fts, 3.0, 1.0, 1.0) AS rank
	FROM knowledge_fts f
	JOIN knowledge_index k ON k.id = f.rowid
	WHERE knowledge_fts MATCH ? AND k.enabled = 1
	ORDER BY rank
	LIMIT ?`

	rows, err := s.db.QueryContext(ctx, sqlQuery, ftsQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var docs []KnowledgeRow
	for rows.Next() {
		var r KnowledgeRow
		var rank float64
		if err := rows.Scan(
			&r.ID, &r.FilePath, &r.ContentHash, &r.Title, &r.Content, &r.SubType,
			&r.ProjectRemote, &r.ProjectPath, &r.ProjectName, &r.Branch,
			&r.CreatedAt, &r.UpdatedAt, &r.HitCount, &r.LastAccessed, &r.Enabled,
			&rank,
		); err != nil {
			continue
		}
		docs = append(docs, r)
	}
	return docs, rows.Err()
}

// fuzzySearchKnowledge scans knowledge and returns those matching via fuzzy distance.
func (s *Store) fuzzySearchKnowledge(ctx context.Context, queryWords []string, limit int, exclude []KnowledgeRow) []KnowledgeRow {
	if limit <= 0 {
		return nil
	}
	excludeIDs := make(map[int64]bool, len(exclude))
	for _, d := range exclude {
		excludeIDs[d.ID] = true
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index WHERE enabled = 1 LIMIT 500`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var docs []KnowledgeRow
	for rows.Next() {
		var r KnowledgeRow
		if err := rows.Scan(
			&r.ID, &r.FilePath, &r.ContentHash, &r.Title, &r.Content, &r.SubType,
			&r.ProjectRemote, &r.ProjectPath, &r.ProjectName, &r.Branch,
			&r.CreatedAt, &r.UpdatedAt, &r.HitCount, &r.LastAccessed, &r.Enabled,
		); err != nil {
			continue
		}

		if excludeIDs[r.ID] {
			continue
		}

		// Fuzzy match against title words.
		targetWords := strings.Fields(strings.ToLower(r.Title))
		for _, qw := range queryWords {
			matched := false
			for _, tw := range targetWords {
				if FuzzyMatch(qw, tw) {
					matched = true
					break
				}
			}
			if matched {
				docs = append(docs, r)
				if len(docs) >= limit {
					return docs
				}
				break
			}
		}
	}
	return docs
}

// KnowledgeConflict represents a pair of potentially contradictory or duplicate knowledge entries.
type KnowledgeConflict struct {
	A          KnowledgeRow
	B          KnowledgeRow
	Similarity float64
	Type       string // "potential_duplicate" or "potential_contradiction"
}

// DetectKnowledgeConflicts finds pairs of knowledge entries with high cosine similarity.
func (s *Store) DetectKnowledgeConflicts(ctx context.Context, threshold float64) ([]KnowledgeConflict, error) {
	if threshold <= 0 {
		threshold = 0.70
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT e.source_id, e.vector FROM embeddings e
		 JOIN knowledge_index k ON k.id = e.source_id
		 WHERE e.source = 'knowledge' AND k.enabled = 1
		 LIMIT 1000`)
	if err != nil {
		return nil, fmt.Errorf("store: detect conflicts query: %w", err)
	}
	defer rows.Close()

	type embeddedDoc struct {
		id  int64
		vec []float32
	}
	var docs []embeddedDoc
	for rows.Next() {
		var ed embeddedDoc
		var blob []byte
		if err := rows.Scan(&ed.id, &blob); err != nil {
			continue
		}
		ed.vec = deserializeFloat32(blob)
		docs = append(docs, ed)
	}

	// Pairwise cosine similarity.
	var conflicts []KnowledgeConflict
	for i := 0; i < len(docs); i++ {
		for j := i + 1; j < len(docs); j++ {
			if len(docs[i].vec) != len(docs[j].vec) {
				continue
			}
			sim := cosineSimilarity(docs[i].vec, docs[j].vec)
			if sim >= threshold {
				conflicts = append(conflicts, KnowledgeConflict{
					A:          KnowledgeRow{ID: docs[i].id},
					B:          KnowledgeRow{ID: docs[j].id},
					Similarity: sim,
				})
			}
		}
	}

	// Hydrate and classify.
	if len(conflicts) > 0 {
		var allIDs []int64
		for _, c := range conflicts {
			allIDs = append(allIDs, c.A.ID, c.B.ID)
		}
		hydrated, err := s.GetKnowledgeByIDs(ctx, allIDs)
		if err == nil {
			docMap := make(map[int64]KnowledgeRow, len(hydrated))
			for _, d := range hydrated {
				docMap[d.ID] = d
			}
			for i := range conflicts {
				if d, ok := docMap[conflicts[i].A.ID]; ok {
					conflicts[i].A = d
				}
				if d, ok := docMap[conflicts[i].B.ID]; ok {
					conflicts[i].B = d
				}
				conflicts[i].Type = classifyConflict(conflicts[i].A.Content, conflicts[i].B.Content)
			}
		}
	}

	sort.Slice(conflicts, func(i, j int) bool {
		return conflicts[i].Similarity > conflicts[j].Similarity
	})

	return conflicts, nil
}

// ExpandAliases expands search terms using the tag_aliases table.
func (s *Store) ExpandAliases(ctx context.Context, terms []string) ([]string, error) {
	if len(terms) == 0 {
		return nil, nil
	}

	seen := make(map[string]bool, len(terms)*2)
	for _, t := range terms {
		seen[strings.ToLower(t)] = true
	}

	for _, t := range terms {
		lower := strings.ToLower(t)

		rows, err := s.db.QueryContext(ctx,
			`SELECT alias FROM tag_aliases WHERE LOWER(tag) = ?`, lower)
		if err != nil {
			return nil, fmt.Errorf("store: expand aliases: %w", err)
		}
		for rows.Next() {
			var alias string
			if err := rows.Scan(&alias); err != nil {
				continue
			}
			seen[strings.ToLower(alias)] = true
		}
		rows.Close()

		rows, err = s.db.QueryContext(ctx,
			`SELECT tag FROM tag_aliases WHERE LOWER(alias) = ?`, lower)
		if err != nil {
			return nil, fmt.Errorf("store: expand aliases: %w", err)
		}
		for rows.Next() {
			var tag string
			if err := rows.Scan(&tag); err != nil {
				continue
			}
			seen[strings.ToLower(tag)] = true
		}
		rows.Close()
	}

	result := make([]string, 0, len(seen))
	for t := range seen {
		result = append(result, t)
	}
	return result, nil
}

// SubTypeHalfLife returns the recency decay half-life in days for a sub_type.
func SubTypeHalfLife(subType string) float64 {
	switch subType {
	case "assumption":
		return 30.0
	case "inference":
		return 45.0
	case SubTypeGeneral:
		return 60.0
	case SubTypePattern:
		return 90.0
	case SubTypeDecision:
		return 90.0
	case SubTypeRule:
		return 120.0
	default:
		return 60.0
	}
}

// SubTypeBoost returns a relevance multiplier based on sub_type.
func SubTypeBoost(subType string) float64 {
	switch subType {
	case SubTypeRule:
		return 2.0
	case SubTypeDecision:
		return 1.5
	case SubTypePattern:
		return 1.3
	default:
		return 1.0
	}
}

// buildFTSQuery converts a query into FTS5 syntax (AND-joined quoted terms).
func buildFTSQuery(query string) string {
	words := strings.Fields(query)
	var terms []string
	for _, w := range words {
		w = sanitizeFTSTerm(w)
		if w == "" {
			continue
		}
		terms = append(terms, `"`+w+`"`)
	}
	return strings.Join(terms, " AND ")
}

// sanitizeFTSTerm removes FTS5 special characters.
func sanitizeFTSTerm(term string) string {
	var b strings.Builder
	for _, r := range term {
		if r == '"' || r == '*' || r == '^' || r == '{' || r == '}' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// classifyConflict determines if a high-similarity pair is a duplicate or contradiction.
func classifyConflict(contentA, contentB string) string {
	lowerA := strings.ToLower(contentA)
	lowerB := strings.ToLower(contentB)

	for _, pair := range contradictionPairs {
		aHas0 := strings.Contains(lowerA, pair[0])
		aHas1 := strings.Contains(lowerA, pair[1])
		bHas0 := strings.Contains(lowerB, pair[0])
		bHas1 := strings.Contains(lowerB, pair[1])

		if (aHas0 && bHas1 && !aHas1) || (aHas1 && bHas0 && !bHas1) {
			return "potential_contradiction"
		}
	}
	return "potential_duplicate"
}

var contradictionPairs = [][2]string{
	{"always", "never"},
	{"must", "must not"},
	{"use", "avoid"},
	{"enable", "disable"},
	{"allow", "deny"},
	{"required", "optional"},
	{"do", "don't"},
	{"add", "remove"},
	{"include", "exclude"},
}

// Levenshtein computes the Levenshtein distance between two strings.
func Levenshtein(a, b string) int {
	ra := []rune(a)
	rb := []rune(b)
	la := len(ra)
	lb := len(rb)

	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	prev := make([]int, lb+1)
	for j := range prev {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr := make([]int, lb+1)
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			curr[j] = min(curr[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev = curr
	}
	return prev[lb]
}

// FuzzyMatch returns true if query is within acceptable edit distance of target.
func FuzzyMatch(query, target string) bool {
	qLen := utf8.RuneCountInString(query)
	if qLen < 3 {
		return false
	}
	maxDist := min(2, qLen/3)
	if maxDist == 0 {
		maxDist = 1
	}
	return Levenshtein(strings.ToLower(query), strings.ToLower(target)) <= maxDist
}
