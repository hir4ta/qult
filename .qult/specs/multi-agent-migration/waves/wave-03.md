# Wave 3: MCP Server 移植

**Goal**: `src/mcp/server.ts` に stdio JSON-RPC ループを Node.js 版で移植し、全 19 ツールが `npx qult mcp` 経由で動作する状態にする。
**Verify**: `bun run typecheck && bun run build && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp-server.mjs | grep -q '"tools"'`
**Started at**: 2026-04-25T11:50:00Z
**Scaffold**: false

## Commits
(populated on /qult:wave-complete)

**Range**:

## Notes
**Start commit**: 086d0d8c6038fefd7f8d5373138384c813170c12
