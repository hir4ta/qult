---
name: archive
description: >
  Ingest reference materials (CSV, TXT, PDF, docs) into structured knowledge
  that survives compaction and session boundaries. Summarizes, structures, and
  saves to spec or memory. Use when the user passes large reference files or
  wants to onboard context for a task. NOT for code review (use /alfred:inspect).
  NOT for implementation (just ask directly).
user-invocable: true
argument-hint: "file-paths or topic"
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
context: current
---

# /alfred:archive — Reference Material Processor

Turn raw materials (CSV, TXT, PDF, docs, URLs) into structured, persistent knowledge
that survives compaction and session boundaries.

## When this skill fires

- User passes multiple files (CSV, TXT, docs) for context
- User says "read these", "review this material", "catch up on this"
- User starts a new task with reference documents

## Phase 1: Detect & Read Materials

If `$ARGUMENTS` contains file paths:
1. Read each file (use Read tool, handle CSV/TXT/PDF)
2. For each file, extract: key entities, relationships, constraints, numbers

If `$ARGUMENTS` is a topic/description:
1. Search knowledge base for existing context
2. Ask user what materials to ingest

## Phase 2: Structure & Summarize

Create a structured summary with these sections:

```markdown
# Ingested Context: <topic>

## Key Facts
- [fact 1]
- [fact 2]

## Entities & Relationships
- [entity A] → [relationship] → [entity B]

## Constraints & Rules
- [constraint 1]

## Numbers & Metrics
- [metric]: [value]

## Open Questions
- [what's unclear or needs confirmation]
```

## Phase 3: Persist

Choose the best storage based on context:

**If an active spec exists:**
1. Call `dossier` with action=update, file=requirements.md, mode=append
2. Append the structured summary under a `## Reference Materials` section

**If no spec but task-oriented:**
1. Call `ledger` with action=save
2. Save as permanent memory with label="Ingested: <topic>"

**Always:**
- Confirm what was saved and where
- Suggest next step: "/alfred:brief to create a spec from this" or "describe what you want to build"

## Phase 4: Summary to User

```
Ingested X files (Y total lines):
- Key facts: N items
- Entities: N relationships mapped
- Constraints: N rules identified
- Saved to: [spec requirements.md | memory]

Ready for next step. Suggest:
- Describe what you want to build → I'll implement
- /alfred:brief <task> → structured development plan
- /alfred:salon <theme> → explore options
```

## Example

User: `/alfred:archive docs/api-spec.pdf docs/schema.csv`

```
Ingested 2 files (340 total lines):
- Key facts: 12 items
- Entities: 8 relationships mapped
- Constraints: 5 rules identified
- Saved to: spec requirements.md (## Reference Materials)

Ready for next step. Suggest:
- /alfred:brief api-redesign → structured development plan
- /alfred:salon api-patterns → explore options
```

## Troubleshooting

- **PDF too large to read**: Use the `pages` parameter to read in chunks (max 20 pages per request).
- **File path doesn't exist**: Ask the user to confirm the path. Check with Glob for similar filenames.
- **Spec save fails**: Fall back to `ledger` action=save as permanent memory.
- **Content is too large (>2000 words)**: Split into multiple summaries by section/topic.

## Guardrails

- Do NOT skip reading files — always read the actual content
- Do NOT invent facts — only extract what's in the materials
- Do NOT save raw file contents — always structure and summarize
- Keep summaries concise (under 2000 words per file)
- For CSV: extract schema + sample rows + aggregate stats, not raw data
