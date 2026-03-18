import { resolve } from 'node:path';

export interface HookEvent {
  cwd: string;
  source?: string;
  transcript_path?: string;
  trigger?: string;
  custom_instructions?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export function notifyUser(format: string, ...args: unknown[]): void {
  let i = 0;
  const msg = format.replace(/%[svd]/g, () => (i < args.length ? String(args[i++]) : ''));
  process.stderr.write(`[alfred] ${msg}\n`);
}

export function emitAdditionalContext(eventName: string, context: string): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
  try {
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch { /* stdout errors are non-recoverable */ }
}

export function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === heading || line.startsWith(heading + ' ')) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('## ')) break;
    if (inSection) result.push(line);
  }
  return result.join('\n').trim();
}

export async function runHook(event: string): Promise<void> {
  // Read hook event from stdin.
  const chunks: Buffer[] = [];
  let totalLen = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    totalLen += (chunk as Buffer).length;
    if (totalLen > 2 * 1024 * 1024) break; // 2MB limit
  }
  const input = Buffer.concat(chunks).toString('utf-8');

  let ev: HookEvent;
  try {
    ev = JSON.parse(input) as HookEvent;
  } catch {
    return; // fail-open
  }

  // stop_hook_active: skip non-enforcement events only. Stop + PreToolUse must still run.
  if (ev.stop_hook_active && event !== 'Stop' && event !== 'PreToolUse') return;

  if (ev.cwd) {
    ev.cwd = resolve(ev.cwd);
  }

  const timeouts: Record<string, number> = {
    SessionStart: 4500,
    PreCompact: 9000,
    UserPromptSubmit: 9000,
    PostToolUse: 5000,
    PreToolUse: 4500,
    Stop: 4500,
  };
  const timeout = timeouts[event] ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    switch (event) {
      case 'SessionStart':
        await handleSessionStart(ev, controller.signal);
        break;
      case 'PreCompact':
        if (ev.cwd) await handlePreCompact(ev, controller.signal);
        break;
      case 'UserPromptSubmit':
        await handleUserPromptSubmit(ev, controller.signal);
        break;
      case 'PostToolUse':
        await handlePostToolUse(ev, controller.signal);
        break;
      case 'PreToolUse':
        await handlePreToolUse(ev, controller.signal);
        break;
      case 'Stop':
        await handleStop(ev, controller.signal);
        break;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Import handlers lazily to minimize cold start for unused events.

async function handleSessionStart(ev: HookEvent, signal: AbortSignal): Promise<void> {
  const { sessionStart } = await import('./session-start.js');
  await sessionStart(ev, signal);
}

async function handlePreCompact(ev: HookEvent, signal: AbortSignal): Promise<void> {
  const { preCompact } = await import('./pre-compact.js');
  await preCompact(ev, signal);
}

async function handleUserPromptSubmit(ev: HookEvent, signal: AbortSignal): Promise<void> {
  const { userPromptSubmit } = await import('./user-prompt.js');
  await userPromptSubmit(ev, signal);
}

async function handlePostToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
  const { postToolUse } = await import('./post-tool.js');
  await postToolUse(ev, signal);
}

async function handlePreToolUse(ev: HookEvent, _signal: AbortSignal): Promise<void> {
  const { preToolUse } = await import('./pre-tool.js');
  await preToolUse(ev);
}

async function handleStop(ev: HookEvent, _signal: AbortSignal): Promise<void> {
  const { stop } = await import('./stop.js');
  await stop(ev);
}
