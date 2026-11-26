import { describe, expect, it } from 'vitest';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { changedLines, snippetsFor } from './snippets.ts';

describe('playground snippets', () => {
  const input = { name: 'Casey River', points: 180 };
  const all = snippetsFor('baked:starter-store-card', input, 'https://passbook.mobile/api/v1');

  it('writes POST /passes in four languages, with the key from the environment', () => {
    expect(all.map((s) => s.lang)).toEqual(['ts', 'curl', 'py', 'go']);
    for (const s of all) {
      expect(s.code).toContain(
        {
          ts: SDK_STATUS.typescript ? 'pb.passes.create' : '/passes',
          curl: '/passes',
          py: SDK_STATUS.python ? 'pb.passes.create' : '/passes',
          go: SDK_STATUS.go ? 'pb.Passes.Create' : '/passes',
        }[s.lang],
      );
      expect(s.code).toContain('baked:starter-store-card');
      expect(s.code).toContain('PASSBOOK_KEY');
      expect(s.code).not.toMatch(/pb[a-z]*_(test|live)_/);
    }
    expect(all[0]?.code).toContain('points: 180');
    expect(all[1]?.code).toContain('"points": 180');
    expect(all[2]?.code).toContain('"points": 180');
  });

  it('marks only the line an edit changed, in every language', () => {
    const edited = snippetsFor(
      'baked:starter-store-card',
      { ...input, points: 190 },
      'https://passbook.mobile/api/v1',
    );
    for (const [i, s] of all.entries()) {
      const marks = changedLines(s.code, edited[i]?.code ?? '');
      expect(marks).toHaveLength(1);
      expect((edited[i]?.code ?? '').split('\n')[(marks[0] ?? 1) - 1]).toContain('190');
    }
  });

  it('marks an added field and nothing when nothing changed', () => {
    expect(changedLines('a\nb\nc', 'a\nb\nc')).toEqual([]);
    expect(changedLines('a\nc', 'a\nb\nc')).toEqual([2]);
    expect(changedLines('a\na', 'a\na\na')).toEqual([3]);
  });
});
