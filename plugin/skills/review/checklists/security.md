# Security Review Checklist

Profile: `security`
Trigger: auth/permission code, .claude/settings*, secrets, user input handling

Before evaluating, call `knowledge` with:
- "security best practices permissions allow deny"
- "hooks security command injection"

## Input Validation

| # | Check | Severity | What to look for |
|---|---|---|---|
| IV1 | Trust boundary validation | CRITICAL | User input, external API responses, file contents used without validation |
| IV2 | SQL injection | CRITICAL | String concatenation in queries; missing parameterized queries |
| IV3 | Command injection | CRITICAL | User input in shell commands, os.exec, subprocess |
| IV4 | Path traversal | CRITICAL | User-supplied paths without sanitization (../../etc/passwd) |
| IV5 | XSS | HIGH | User content rendered in HTML without escaping |
| IV6 | SSRF | HIGH | User-supplied URLs fetched without allowlist |

## Authentication & Authorization

| # | Check | Severity | What to look for |
|---|---|---|---|
| AA1 | IDOR | CRITICAL | URL/path parameters used in DB queries without ownership check |
| AA2 | Missing auth on endpoints | CRITICAL | State-changing endpoints without authentication |
| AA3 | CSRF protection | HIGH | State-changing POST/PUT/DELETE without CSRF tokens |
| AA4 | Session management | HIGH | Missing token regeneration, weak entropy, insecure cookie flags |
| AA5 | JWT validation | HIGH | "none" algorithm accepted, missing signature verification |
| AA6 | Rate limiting | MEDIUM | Authentication endpoints without rate limiting |

## Secrets & Credentials

| # | Check | Severity | What to look for |
|---|---|---|---|
| SC1 | Hardcoded secrets | CRITICAL | API keys, passwords, tokens in source code or tests |
| SC2 | Secrets in logs | HIGH | PII, tokens, passwords leaked into log output |
| SC3 | Secrets in config files | CRITICAL | Credentials in .mcp.json, hooks.json, settings.json |
| SC4 | .gitignore coverage | HIGH | .env, credentials.json, *.key not in .gitignore |

## Cryptography

| # | Check | Severity | What to look for |
|---|---|---|---|
| CR1 | Deprecated algorithms | HIGH | MD5, SHA-1 for security purposes |
| CR2 | Weak parameters | MEDIUM | Short key lengths, insufficient iterations |
| CR3 | Predictable randomness | HIGH | math/rand for security-sensitive operations |

## Concurrency Safety

| # | Check | Severity | What to look for |
|---|---|---|---|
| CS1 | TOCTOU | HIGH | Check-then-act without synchronization (file exists → open) |
| CS2 | Race in auth | CRITICAL | Race condition in authentication/authorization checks |

## Claude Code Specific

| # | Check | Severity | What to look for |
|---|---|---|---|
| CC1 | bypassPermissions | CRITICAL | Agents with bypassPermissions: true |
| CC2 | Over-permissive allow | HIGH | Bash(*) or broad tool access in settings.json |
| CC3 | Hook command safety | HIGH | Hook commands that could be exploited (eval, curl pipe sh) |
| CC4 | XML injection in frontmatter | HIGH | Angle brackets in skill/agent YAML frontmatter |
| CC5 | MCP env secrets | CRITICAL | API keys directly in .mcp.json env field |
