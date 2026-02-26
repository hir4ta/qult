package hookhandler

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// depGraph is an adjacency list: package → list of packages that import it (reverse deps).
type depGraph map[string][]string

// buildGoDepGraph runs `go list -json ./...` and builds a reverse dependency graph.
// Caches the result in sessiondb. Returns nil on failure.
func buildGoDepGraph(sdb *sessiondb.SessionDB, cwd string) depGraph {
	// Check cache first.
	if cached, _ := sdb.GetContext("dep_graph_json"); cached != "" {
		var graph depGraph
		if json.Unmarshal([]byte(cached), &graph) == nil {
			return graph
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "go", "list", "-json", "./...")
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	// Parse the stream of JSON objects (one per package).
	graph := make(depGraph)
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for dec.More() {
		var pkg struct {
			ImportPath string   `json:"ImportPath"`
			Imports    []string `json:"Imports"`
		}
		if err := dec.Decode(&pkg); err != nil {
			break
		}
		for _, imp := range pkg.Imports {
			graph[imp] = append(graph[imp], pkg.ImportPath)
		}
	}

	// Cache for the session.
	if data, err := json.Marshal(graph); err == nil {
		_ = sdb.SetContext("dep_graph_json", string(data))
	}

	return graph
}

// transitiveImporters returns all packages that transitively depend on pkgPath.
// BFS traversal with max depth 3 to keep it bounded.
func transitiveImporters(graph depGraph, pkgPath string, maxDepth int) []string {
	if graph == nil {
		return nil
	}

	visited := map[string]bool{pkgPath: true}
	queue := []string{pkgPath}
	var result []string

	for depth := 0; depth < maxDepth && len(queue) > 0; depth++ {
		var next []string
		for _, pkg := range queue {
			for _, importer := range graph[pkg] {
				if visited[importer] {
					continue
				}
				visited[importer] = true
				result = append(result, importer)
				next = append(next, importer)
			}
		}
		queue = next
	}
	return result
}

// Python/JS import patterns for cross-language dep graph.
var (
	pyImportPattern = regexp.MustCompile(`(?m)^(?:import\s+(\S+)|from\s+(\S+)\s+import)`)
	jsImportPattern = regexp.MustCompile(`(?m)(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))`)
)

// buildGenericDepGraph scans Python/JS files for import statements and builds a reverse dep graph.
// Keys are module names (not full paths), values are files that import them.
func buildGenericDepGraph(sdb *sessiondb.SessionDB, cwd string) depGraph {
	if cached, _ := sdb.GetContext("generic_dep_graph_json"); cached != "" {
		var graph depGraph
		if json.Unmarshal([]byte(cached), &graph) == nil {
			return graph
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Find Python and JS/TS files.
	cmd := exec.CommandContext(ctx, "find", cwd,
		"-maxdepth", "4",
		"(", "-name", "*.py", "-o", "-name", "*.js", "-o", "-name", "*.ts", "-o", "-name", "*.tsx", ")",
		"-not", "-path", "*/node_modules/*",
		"-not", "-path", "*/.venv/*",
		"-not", "-path", "*/__pycache__/*",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	graph := make(depGraph)
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		filePath := strings.TrimSpace(scanner.Text())
		if filePath == "" {
			continue
		}
		ext := filepath.Ext(filePath)
		rel, _ := filepath.Rel(cwd, filePath)
		if rel == "" {
			rel = filePath
		}

		content, err := readFileLimited(filePath, 10000)
		if err != nil {
			continue
		}

		var pattern *regexp.Regexp
		switch ext {
		case ".py":
			pattern = pyImportPattern
		case ".js", ".ts", ".tsx", ".jsx":
			pattern = jsImportPattern
		default:
			continue
		}

		matches := pattern.FindAllStringSubmatch(content, -1)
		for _, m := range matches {
			for _, group := range m[1:] {
				if group != "" {
					module := normalizeModule(group)
					graph[module] = append(graph[module], rel)
				}
			}
		}
	}

	if data, err := json.Marshal(graph); err == nil {
		_ = sdb.SetContext("generic_dep_graph_json", string(data))
	}
	return graph
}

// normalizeModule strips leading dots and path prefixes to get a canonical module name.
func normalizeModule(module string) string {
	module = strings.TrimPrefix(module, "./")
	for strings.HasPrefix(module, "../") {
		module = strings.TrimPrefix(module, "../")
	}
	// Remove file extension.
	for _, ext := range []string{".py", ".js", ".ts", ".tsx", ".jsx"} {
		module = strings.TrimSuffix(module, ext)
	}
	return module
}

// readFileLimited reads at most maxBytes from a file.
func readFileLimited(path string, maxBytes int) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > maxBytes {
		data = data[:maxBytes]
	}
	return string(data), nil
}
