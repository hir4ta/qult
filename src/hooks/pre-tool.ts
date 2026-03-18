import type { HookEvent } from './dispatcher.js';
import { tryReadActiveSpec, isSpecFilePath, denyTool } from './spec-guard.js';

const BLOCKABLE_TOOLS = new Set(['Edit', 'Write']);

/**
 * PreToolUse handler: block Edit/Write when active M/L/XL spec is not approved.
 * Fail-open: any error results in allowing the tool (NFR-2).
 */
export async function preToolUse(ev: HookEvent): Promise<void> {
  const toolName = ev.tool_name ?? '';

  // FR-2/FR-3: Only block Edit/Write. Everything else passes through.
  if (!BLOCKABLE_TOOLS.has(toolName)) return;

  // FR-7: .alfred/ edits are always allowed (spec creation/update).
  const toolInput = (ev.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (filePath && isSpecFilePath(ev.cwd, filePath)) return;

  // DEC-2: No active spec = free coding, no block.
  const spec = tryReadActiveSpec(ev.cwd);
  if (!spec) return;

  // FR-1: M/L/XL with unapproved review → deny.
  if (['M', 'L', 'XL'].includes(spec.size) && spec.reviewStatus !== 'approved') {
    const reason = [
      `Spec '${spec.slug}' (size ${spec.size}) is not approved. Submit review via \`alfred dashboard\` or run self-review before implementation.`,
      '- "I\'ll get the review after implementation" → The Stop hook will block you from finishing anyway',
      '- "This edit is trivial" → All M/L/XL edits are gated. Use dossier init size=S for trivial changes',
    ].join('\n');
    denyTool(reason);
  }
}
