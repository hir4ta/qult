import { describe, it, expect } from 'vitest';
import { extractSection } from '../dispatcher.js';

describe('extractSection', () => {
  it('extracts section content between headings', () => {
    const md = '## Intro\nHello\n## Next Steps\n- [ ] Todo\n- [x] Done\n## Other\nStuff';
    expect(extractSection(md, '## Next Steps')).toBe('- [ ] Todo\n- [x] Done');
  });

  it('extracts section at end of document', () => {
    const md = '## First\nA\n## Last\nFinal content';
    expect(extractSection(md, '## Last')).toBe('Final content');
  });

  it('returns empty string when section not found', () => {
    const md = '## Intro\nHello';
    expect(extractSection(md, '## Missing')).toBe('');
  });

  it('handles heading with extra text after match', () => {
    const md = '## Next Steps (updated)\nContent here\n## Other\n';
    expect(extractSection(md, '## Next Steps')).toBe('Content here');
  });

  it('returns empty for empty content', () => {
    expect(extractSection('', '## Anything')).toBe('');
  });
});
