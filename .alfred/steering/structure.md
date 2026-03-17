# Structure: alfred

## Directory Layout
<!-- Top-level directory overview -->
```
cmd/alfred/          — CLI entry point + hook handlers + dashboard launcher
internal/mcpserver/  — MCP server (3 tools: dossier, roster, ledger)
internal/store/      — SQLite persistence (knowledge_index, embeddings, FTS5)
internal/embedder/   — Voyage AI client (embedding + reranking)
internal/spec/       — Spec lifecycle (init/update/complete/delete, validation, templates)
internal/epic/       — Epic management (YAML task grouping + dependencies)
internal/dashboard/  — DataSource interface + shared types
internal/api/        — HTTP API server (chi router, REST, SSE, SPA serving)
internal/install/    — Plugin bundle generation (skills, agents, rules)
web/                 — React SPA (Vite 8 + TanStack Router + shadcn/ui)
.claude/             — Claude Code project config (rules, skills, agents)
```

## Module Boundaries
<!-- Which packages are public API vs internal? -->
| Package | Role | Visibility |
|---------|------|------------|
| cmd/alfred | CLI dispatch, hooks, dashboard | Entry point |
| internal/mcpserver | MCP tool handlers (dossier, roster, ledger) | Internal |
| internal/store | SQLite + knowledge file I/O | Internal |
| internal/embedder | Voyage AI embedding/reranking | Internal |
| internal/spec | Spec CRUD, validation, templates, confidence | Internal |
| internal/epic | Epic CRUD, topological sort | Internal |
| internal/dashboard | DataSource interface, type definitions | Internal |
| internal/api | HTTP server, SSE hub, SPA serving | Internal |
| internal/install | Plugin content + bundle generation | Internal |

## Naming Conventions
<!-- Project-specific naming patterns -->
- Go packages: single lowercase word (mcpserver, embedder, store)
- Go types: PascalCase (Store, SpecDir, Embedder, DataSource)
- Go receivers: 1-2 letter abbreviation (s *Store, sd *SpecDir, e *Embedder)
- Handler files: `handlers_*.go` (handlers_spec.go, handlers_epic.go)
- Hook files: `hooks_*.go` (hooks_session.go, hooks_compact.go)
- Test files: `*_test.go` paired with source
- Web components: PascalCase .tsx (ReviewPanel.tsx, SpecContent.tsx)
- Routes: file-based via TanStack Router (tasks.tsx, tasks.$slug.tsx)
- Butler theme: skill names (brief, attend, inspect, mend, valet, concierge)

## Key Files
<!-- Files that newcomers should read first -->
| File | Purpose |
|------|---------|
| README.md / README.ja.md | Project overview and user guide |
| CLAUDE.md | AI assistant rules and project constraints |
| cmd/alfred/main.go | CLI entry point (subcommand dispatch) |
| internal/mcpserver/server.go | MCP server setup and tool registration |
| internal/store/schema.go | DB schema V8 definition |
| internal/spec/spec.go | Spec types, sizes, lifecycle operations |
| Taskfile.yml | Build commands (build, dev, check, test) |

## Data Flow
<!-- How data moves through the system -->
```
Claude Code → Hook events → cmd/alfred/hooks*.go → internal/store + internal/spec
Claude Code → MCP tools → internal/mcpserver → internal/store + internal/spec + internal/epic
Browser → HTTP API → internal/api → internal/dashboard → internal/store + internal/spec
.alfred/knowledge/*.md → SessionStart sync → SQLite (knowledge_index + embeddings + FTS5)
```

## Extension Points
<!-- Where to add new features -->
- New MCP tool: Add handler in internal/mcpserver/, register in server.go
- New skill: Add SKILL.md in internal/install/content/skills/{name}/
- New hook event: Add handler function in cmd/alfred/hooks_*.go
- New dashboard tab: Add route in web/src/routes/, API endpoint in internal/api/
- New validation check: Add to internal/spec/validate.go
- New knowledge sub-type: Add to internal/store/knowledge.go, update boost weights
