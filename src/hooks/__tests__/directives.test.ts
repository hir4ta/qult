import { describe, it, expect } from 'vitest';
import { buildDirectiveOutput, type DirectiveItem } from '../directives.js';

describe('buildDirectiveOutput', () => {
  it('formats basic DIRECTIVE without rationalizations', () => {
    const items: DirectiveItem[] = [{ level: 'DIRECTIVE', message: 'Do X' }];
    const out = buildDirectiveOutput(items);
    expect(out).toBe('[DIRECTIVE] Do X');
    expect(out).not.toContain('Adapting or shortcutting');
  });

  it('includes rationalizations as bullet points', () => {
    const items: DirectiveItem[] = [{
      level: 'DIRECTIVE',
      message: 'Create a spec first.',
      rationalizations: ['Excuse A → Counter A', 'Excuse B → Counter B'],
    }];
    const out = buildDirectiveOutput(items);
    expect(out).toContain('[DIRECTIVE] Create a spec first.');
    expect(out).toContain('- Excuse A → Counter A');
    expect(out).toContain('- Excuse B → Counter B');
  });

  it('appends Spirit vs Letter only when spiritVsLetter=true', () => {
    const withFlag: DirectiveItem[] = [{
      level: 'DIRECTIVE', message: 'Do X', spiritVsLetter: true,
    }];
    const withoutFlag: DirectiveItem[] = [{
      level: 'DIRECTIVE', message: 'Do X',
    }];
    expect(buildDirectiveOutput(withFlag)).toContain('Adapting or shortcutting');
    expect(buildDirectiveOutput(withoutFlag)).not.toContain('Adapting or shortcutting');
  });

  it('ignores rationalizations and spiritVsLetter for WARNING/CONTEXT', () => {
    const items: DirectiveItem[] = [{
      level: 'WARNING',
      message: 'Check this',
      rationalizations: ['A → B'],
      spiritVsLetter: true,
    }];
    const out = buildDirectiveOutput(items);
    expect(out).toBe('[WARNING] Check this');
    expect(out).not.toContain('- A → B');
    expect(out).not.toContain('Adapting or shortcutting');
  });

  it('truncates by dropping rationalizations to preserve Spirit vs Letter (NFR-1)', () => {
    const longRat = 'x'.repeat(200) + ' → ' + 'y'.repeat(200);
    const items: DirectiveItem[] = [{
      level: 'DIRECTIVE',
      message: 'Short message.',
      rationalizations: [longRat, longRat, longRat],
      spiritVsLetter: true,
    }];
    const out = buildDirectiveOutput(items);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('Adapting or shortcutting');
  });

  it('downgrades 4th DIRECTIVE to WARNING (NFR-5)', () => {
    const items: DirectiveItem[] = [
      { level: 'DIRECTIVE', message: 'A' },
      { level: 'DIRECTIVE', message: 'B' },
      { level: 'DIRECTIVE', message: 'C' },
      { level: 'DIRECTIVE', message: 'D' },
    ];
    const out = buildDirectiveOutput(items);
    const directiveCount = (out.match(/\[DIRECTIVE\]/g) ?? []).length;
    const warningCount = (out.match(/\[WARNING\]/g) ?? []).length;
    expect(directiveCount).toBe(3);
    expect(warningCount).toBe(1);
  });

  it('sorts DIRECTIVE before WARNING before CONTEXT', () => {
    const items: DirectiveItem[] = [
      { level: 'CONTEXT', message: 'info' },
      { level: 'DIRECTIVE', message: 'must' },
      { level: 'WARNING', message: 'check' },
    ];
    const out = buildDirectiveOutput(items);
    const lines = out.split('\n');
    expect(lines[0]).toContain('[DIRECTIVE]');
    // WARNING should come after DIRECTIVE block, CONTEXT after WARNING
    const warningIdx = lines.findIndex(l => l.startsWith('[WARNING]'));
    const contextIdx = lines.findIndex(l => l.startsWith('[CONTEXT]'));
    expect(warningIdx).toBeGreaterThan(0);
    expect(contextIdx).toBeGreaterThan(warningIdx);
  });

  it('returns empty string for empty items', () => {
    expect(buildDirectiveOutput([])).toBe('');
  });

  it('handles rationalizations + spiritVsLetter together within 500 chars', () => {
    const items: DirectiveItem[] = [{
      level: 'DIRECTIVE',
      message: 'MUST create a spec first.',
      rationalizations: [
        '"I have enough context" → Specs catch hidden assumptions',
        '"Spec restates the request" → Specs add traceability',
        '"Too slow" → S-size adds <2min',
      ],
      spiritVsLetter: true,
    }];
    const out = buildDirectiveOutput(items);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('MUST create a spec first.');
    expect(out).toContain('Adapting or shortcutting');
    // At least some rationalizations should be present.
    expect(out).toContain('- ');
  });
});
