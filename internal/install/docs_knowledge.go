package install

import (
	"fmt"
	"os"
	"time"

	"github.com/hir4ta/claude-buddy/internal/store"
)

const docsSessionID = "docs-sync"

type docsEntry struct {
	Title   string
	Content string
	Tags    []string
}

var docsEntries = []docsEntry{
	// --- Hooks: Event Types ---
	{
		Title:   "Hook event lifecycle and available events",
		Content: "Claude Code hooks fire at specific lifecycle points: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Notification, SubagentStart, SubagentStop, Stop, TeammateIdle, TaskCompleted, ConfigChange, WorktreeCreate, WorktreeRemove, PreCompact, SessionEnd. Each receives JSON input via stdin with common fields: session_id, transcript_path, cwd, permission_mode, hook_event_name.",
		Tags:    []string{"claude-code", "hooks", "lifecycle", "events"},
	},
	{
		Title:   "Hook handler types: command, prompt, agent",
		Content: "Three hook types: (1) command: runs shell script, receives JSON on stdin, communicates via exit codes and stdout JSON. (2) prompt: single-turn LLM evaluation, returns {ok:true/false, reason:'...'}. (3) agent: multi-turn subagent with Read/Grep/Glob tools, same response format as prompt. Prompt and agent hooks support: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, UserPromptSubmit, Stop, SubagentStop, TaskCompleted.",
		Tags:    []string{"claude-code", "hooks", "command", "prompt", "agent"},
	},
	// --- Hooks: Async ---
	{
		Title:   "Async hook execution and output delivery",
		Content: "Set async:true on command hooks to run in background without blocking. Only type:command supports async. After background process exits, JSON with systemMessage or additionalContext at top level is delivered to Claude on the next conversation turn. Async hooks cannot block tool calls or return decisions. Each execution creates a separate background process with no deduplication.",
		Tags:    []string{"claude-code", "hooks", "async", "additionalContext"},
	},
	// --- Hooks: PostToolUse ---
	{
		Title:   "PostToolUse hook input and output format",
		Content: "PostToolUse fires after a tool completes successfully. Input includes tool_name, tool_input, tool_response, tool_use_id. Decision control: decision:'block' with reason (sync only). hookSpecificOutput with additionalContext or updatedMCPToolOutput. For async hooks, use top-level additionalContext instead of hookSpecificOutput.",
		Tags:    []string{"claude-code", "hooks", "PostToolUse", "output"},
	},
	// --- Hooks: PreToolUse ---
	{
		Title:   "PreToolUse hook decision control",
		Content: "PreToolUse uses hookSpecificOutput for decisions: permissionDecision (allow/deny/ask), permissionDecisionReason, updatedInput (modify tool params), additionalContext. Return deny to block tool calls, allow to bypass permissions, ask to prompt user. updatedInput can modify tool arguments before execution.",
		Tags:    []string{"claude-code", "hooks", "PreToolUse", "permissions"},
	},
	// --- Hooks: Stop ---
	{
		Title:   "Stop hook prevents Claude from stopping",
		Content: "Stop hooks fire when Claude finishes responding. Does not fire on user interrupt. Input includes stop_hook_active (boolean) and last_assistant_message (text of final response). CRITICAL: Check stop_hook_active to prevent infinite loops - if true, the hook should allow stop. Decision: decision:'block' with reason to continue working. Exit code 2 also blocks stopping.",
		Tags:    []string{"claude-code", "hooks", "Stop", "completion"},
	},
	// --- Hooks: Exit Codes ---
	{
		Title:   "Hook exit codes and their effects",
		Content: "Exit 0: success, stdout parsed for JSON. Exit 2: blocking error, stderr fed to Claude. Other codes: non-blocking error. Exit 2 blocks PreToolUse (tool call), PermissionRequest (permission), UserPromptSubmit (prompt), Stop (stopping), SubagentStop (subagent stop), TeammateIdle (going idle), TaskCompleted (completion), ConfigChange (config change).",
		Tags:    []string{"claude-code", "hooks", "exit-codes"},
	},
	// --- Hooks: JSON Output ---
	{
		Title:   "Hook JSON output universal fields",
		Content: "Universal JSON fields: continue (false stops Claude entirely), stopReason (message when continue is false), suppressOutput (hide stdout from verbose), systemMessage (warning to user). Event-specific: decision:'block' with reason for PostToolUse/Stop/UserPromptSubmit/SubagentStop/ConfigChange. hookSpecificOutput with hookEventName for PreToolUse and PermissionRequest.",
		Tags:    []string{"claude-code", "hooks", "json", "output"},
	},
	// --- Subagents: Configuration ---
	{
		Title:   "Custom subagent definition and frontmatter",
		Content: "Subagents defined as Markdown files with YAML frontmatter. Locations: .claude/agents/ (project), ~/.claude/agents/ (user), plugin agents/ dir, --agents CLI flag. Required fields: name, description. Optional: tools, disallowedTools, model (sonnet/opus/haiku/inherit), permissionMode, maxTurns, skills, mcpServers, hooks, memory, background, isolation.",
		Tags:    []string{"claude-code", "agents", "subagent", "configuration"},
	},
	// --- Subagents: Persistent Memory ---
	{
		Title:   "Subagent persistent memory system",
		Content: "Enable with memory field: user (~/.claude/agent-memory/<name>/), project (.claude/agent-memory/<name>/), local (.claude/agent-memory-local/<name>/). When enabled: system prompt includes memory instructions, MEMORY.md first 200 lines auto-injected, Read/Write/Edit auto-enabled for memory management. Subagent can build knowledge across sessions.",
		Tags:    []string{"claude-code", "agents", "memory", "persistent"},
	},
	// --- Subagents: Tools and Models ---
	{
		Title:   "Subagent tool access and model selection",
		Content: "Tools field controls access: Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task (for spawning). If omitted, inherits all tools. disallowedTools field removes specific tools. Model options: sonnet (balanced), opus (most capable), haiku (fast/cheap), inherit (same as parent). Task(agent_type) syntax restricts which subagents can be spawned.",
		Tags:    []string{"claude-code", "agents", "tools", "model"},
	},
	// --- Subagents: Built-in ---
	{
		Title:   "Built-in subagent types",
		Content: "Explore: Haiku model, read-only tools, for codebase search and analysis. Plan: inherits model, read-only, for plan mode research. General-purpose: inherits model, all tools, for complex multi-step tasks. Bash: inherits model, for terminal commands. Claude Code Guide: Haiku, for answering Claude Code feature questions.",
		Tags:    []string{"claude-code", "agents", "built-in", "Explore", "Plan"},
	},
	// --- Settings: Hook Configuration ---
	{
		Title:   "Hook configuration in settings.json",
		Content: "Hooks defined in settings.json under 'hooks' key. Each event maps to array of matcher groups. Each matcher group has optional 'matcher' (regex) and 'hooks' array of handlers. Hooks captured at startup - mid-session changes require review. disableAllHooks:true disables all hooks. Multiple hooks for same event run in parallel.",
		Tags:    []string{"claude-code", "hooks", "settings", "configuration"},
	},
	// --- Features Overview ---
	{
		Title:   "Choosing between CLAUDE.md, Skills, Hooks, Subagents, MCP",
		Content: "CLAUDE.md: static instructions loaded at session start. Skills: reusable prompts/workflows as slash commands, run in main context. Hooks: automated reactions to lifecycle events, external scripts. Subagents: isolated context with custom tools/model, delegated tasks. MCP: external tool integration via Model Context Protocol. Use CLAUDE.md for conventions, Skills for repeatable workflows, Hooks for automation, Subagents for isolation, MCP for external tools.",
		Tags:    []string{"claude-code", "features", "CLAUDE.md", "skills", "hooks", "agents", "MCP"},
	},
	// --- Hooks: Matcher Patterns ---
	{
		Title:   "Hook matcher patterns and filtering",
		Content: "Matcher is regex for filtering when hooks fire. Tool events match on tool_name (Bash, Edit, Write, Read, Glob, Grep, Task, WebFetch, WebSearch, mcp__*). SessionStart matches on source (startup/resume/clear/compact). SessionEnd on reason. MCP tools: mcp__<server>__<tool> pattern. UserPromptSubmit/Stop/TeammateIdle/TaskCompleted don't support matchers.",
		Tags:    []string{"claude-code", "hooks", "matcher", "regex"},
	},
	// --- Subagents: Background and Isolation ---
	{
		Title:   "Subagent execution modes: foreground, background, worktree",
		Content: "Foreground: blocks main conversation, permission prompts passed through. Background: runs concurrently, pre-approves permissions, auto-denies unapproved. Set background:true in frontmatter or ask Claude to run in background. Isolation: worktree gives isolated git copy. Ctrl+B to background a running task. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 to disable.",
		Tags:    []string{"claude-code", "agents", "background", "worktree", "isolation"},
	},
	// --- Hooks: SubagentStart/Stop ---
	{
		Title:   "SubagentStart and SubagentStop hook events",
		Content: "SubagentStart fires when a subagent spawns. Input: agent_id, agent_type. Can inject additionalContext into subagent. Cannot block creation. SubagentStop fires when subagent finishes. Input: stop_hook_active, agent_id, agent_type, agent_transcript_path, last_assistant_message. Uses same decision control as Stop (decision:'block' prevents stopping).",
		Tags:    []string{"claude-code", "hooks", "SubagentStart", "SubagentStop"},
	},
	// --- Hooks: Scoped Hooks in Agents ---
	{
		Title:   "Defining hooks inside subagent frontmatter",
		Content: "Subagents can define hooks in YAML frontmatter that only run while that subagent is active. All hook events supported. Stop hooks in frontmatter auto-convert to SubagentStop. Hooks use same format as settings-based hooks. Scoped to component lifetime and cleaned up when finished.",
		Tags:    []string{"claude-code", "hooks", "agents", "scoped"},
	},
}

func syncDocsKnowledge(st *store.Store) error {
	if err := st.DeletePatternsBySession(docsSessionID); err != nil {
		return fmt.Errorf("delete old docs: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	inserted := 0
	for _, doc := range docsEntries {
		_, err := st.InsertPattern(&store.PatternRow{
			SessionID:   docsSessionID,
			PatternType: "reference",
			Title:       doc.Title,
			Content:     doc.Content,
			EmbedText:   doc.Title + " " + doc.Content,
			Language:    "en",
			Scope:       "global",
			Timestamp:   now,
			Tags:        doc.Tags,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: insert doc pattern %q: %v\n", doc.Title, err)
			continue
		}
		inserted++
	}

	fmt.Printf("✓ Synced %d documentation knowledge entries\n", inserted)
	return nil
}
