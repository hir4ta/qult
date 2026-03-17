# Tech: alfred

## Stack
<!-- Primary technology stack -->
- **Language**: Go 1.25 (backend) + TypeScript 5.8 (frontend)
- **Database**: SQLite (ncruces/go-sqlite3, pure-Go via Wasm)
- **Search**: Voyage AI (voyage-4-large embedding, rerank-2.5) + FTS5 fallback
- **HTTP**: chi/v5 router
- **MCP**: mark3labs/mcp-go v0.44
- **Frontend**: React 19 + Vite 8 + TanStack Router/Query + shadcn/ui + Tailwind CSS v4
- **Build**: Task runner (Taskfile.yml) + Bun (frontend)
- **Linting**: go vet (Go) + Biome (TypeScript)

## Dependencies
<!-- Key external dependencies -->
- github.com/go-chi/chi/v5 v5.2.5 — HTTP router
- github.com/mark3labs/mcp-go v0.44.0 — MCP protocol implementation
- github.com/ncruces/go-sqlite3 v0.30.5 — Pure-Go SQLite (no CGO)
- gopkg.in/yaml.v3 v3.0.1 — YAML parsing for specs/epics
- github.com/tetratelabs/wazero v1.11.0 — Wasm runtime (sqlite3 dependency)
- React 19, TanStack Router ^1, TanStack Query ^5, Radix UI, Lucide icons

## API Conventions
<!-- How APIs are structured -->
- MCP tools return structured JSON via `CallToolResult`
- REST API uses chi router with `/api/` prefix
- SSE for real-time updates (EventSource → TanStack Query invalidation)
- Hook protocol: JSON on stdout, notifications on stderr (`[alfred]` prefix)

## Error Handling
<!-- Project-wide error handling patterns -->
- Error as last return value, early returns
- `fmt.Errorf("context: %w", err)` for wrapped errors
- Never log AND return an error; choose one
- Hooks fail-open: stderr warning only, never block user
- No panic for normal error conditions

## Testing Strategy
<!-- How tests are organized and run -->
| Level | Tool | Coverage Target |
|-------|------|----------------|
| Unit | go test + t.Run() | 50%+ (hook handlers excluded) |
| Frontend | Biome lint | Type safety via strict tsconfig |

- Table-driven tests with named subtests
- `t.Parallel()` for independent tests
- `t.Helper()` for test utilities

## Build & Deploy
<!-- How to build, test, and deploy -->
```bash
# Build (React SPA + Go binary)
task build

# Development (Vite HMR + dashboard)
task dev  # terminal 1
ALFRED_DEV=1 alfred dashboard  # terminal 2

# Lint
task check  # go vet + Biome

# Test
task test  # go test ./...

# Release
/release  # auto-version or specified
```

## Environment
<!-- Required environment variables and configuration -->
| Variable | Purpose | Required |
|----------|---------|----------|
| VOYAGE_API_KEY | Voyage AI semantic search + reranking | No (FTS5 fallback) |
| ALFRED_DEV | Enable Vite dev proxy in dashboard | No (dev only) |

## Constraints
<!-- Technical limitations and boundaries -->
- Always `go install ./cmd/alfred` (not `go build` + `cp`; macOS code signing)
- Hook timeouts: SessionStart 5s, PreCompact 10s, UserPromptSubmit 10s, PostToolUse 5s
- DB schema V8: any pre-V8 DB rebuilt from scratch (no incremental migration)
- `internal/` packages are private APIs; no external consumers
- Plugin content source of truth: `internal/install/content/` (plugin/ is generated output)
- Store.DB() is test-only; production code uses Store methods
