import { emitAdditionalContext } from './dispatcher.js';

export type DirectiveLevel = 'DIRECTIVE' | 'WARNING' | 'CONTEXT';

export interface DirectiveItem {
  level: DirectiveLevel;
  message: string;
}

const LEVEL_ORDER: Record<DirectiveLevel, number> = {
  DIRECTIVE: 0,
  WARNING: 1,
  CONTEXT: 2,
};

const MAX_DIRECTIVES = 3;

/**
 * Build a single additionalContext string from directive items.
 * Order: DIRECTIVE → WARNING → CONTEXT.
 * Max 3 DIRECTIVE items (NFR-5). Excess DIRECTIVEs downgraded to WARNING.
 */
export function buildDirectiveOutput(items: DirectiveItem[]): string {
  if (items.length === 0) return '';

  // Enforce max DIRECTIVE count.
  let directiveCount = 0;
  const normalized = items.map(item => {
    if (item.level === 'DIRECTIVE') {
      directiveCount++;
      if (directiveCount > MAX_DIRECTIVES) {
        return { level: 'WARNING' as DirectiveLevel, message: item.message };
      }
    }
    return item;
  });

  // Sort by level order, stable.
  const sorted = normalized.slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  return sorted.map(item => `[${item.level}] ${item.message}`).join('\n');
}

/**
 * Emit directives via single emitAdditionalContext call (NFR-4).
 */
export function emitDirectives(eventName: string, items: DirectiveItem[]): void {
  const output = buildDirectiveOutput(items);
  if (output) {
    emitAdditionalContext(eventName, output);
  }
}
