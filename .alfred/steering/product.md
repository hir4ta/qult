# Product: alfred

## Purpose
<!-- What does this project do? Who is it for? -->
Development butler for Claude Code — MCP server + Hook handler that solves three core problems:
1. **Memory loss**: Context disappears across sessions and compacts
2. **Planning by vibes**: No structured specs or design documentation
3. **No code review**: Shipping without second opinions

alfred provides persistent specs, adaptive architectural documentation, semantic knowledge search, reliability signals (grounding levels), and intelligent skill suggestions.

## Users & Stakeholders
<!-- Who uses this? Who cares about it? -->
- Primary users: Claude Code developers building solo or in small teams
- Secondary users: Teams doing spec-first design (requirements → implementation → commit)
- Stakeholders: Anthropic plugin marketplace consumers

## Business Rules
<!-- Core domain rules that drive behavior -->
- Knowledge files (`.alfred/knowledge/*.md`) are the source of truth; DB is a derived search index
- Specs require approval gates for M/L/XL sizes before completion
- Hook handlers must complete within strict timeouts (5s-10s per event)
- Plugin installs via marketplace; configuration is zero-touch after install

## Key Workflows
<!-- The main user-facing flows -->
1. **Spec-driven development**: `/alfred:brief` → spec creation → review in dashboard → `/alfred:attend` → implementation → commit
2. **Knowledge persistence**: Hook auto-extracts decisions → ledger saves → semantic search in future sessions
3. **Bug fixing**: `/alfred:mend` → reproduce → root cause analysis → fix → verify → commit
4. **Project onboarding**: `/alfred:init` → steering docs + templates + knowledge sync

## Quality Attributes
<!-- What "-ilities" matter most? -->
| Attribute | Priority | Notes |
|-----------|----------|-------|
| Reliability | Critical | Hook failures silently degrade (fail-open); never block user workflow |
| Performance | High | Hooks have 5-10s timeouts; search must be sub-second |
| Extensibility | High | Skills, agents, rules are modular and user-customizable |
| Usability | Medium | Zero-config after install; dashboard for visual management |

## Principles
<!-- Guiding principles for design decisions -->
- Butler theme: skills named after service roles (brief, attend, inspect, mend, valet, concierge)
- Knowledge-first: Markdown files are git-friendly, team-shareable, diff-reviewable
- Graceful degradation: Voyage AI optional; FTS5 fallback always available
- Fail-open hooks: Never block the user; stderr warnings only

## Out of Scope
<!-- What this project explicitly does NOT do -->
- Not a general-purpose AI coding assistant (it augments Claude Code, not replaces it)
- Not a CI/CD system or deployment tool
- Not a project management tool (epics are lightweight, not Jira)
- Does not act as a standalone coding tool (it augments Claude Code's workflow with specs, memory, and review)
