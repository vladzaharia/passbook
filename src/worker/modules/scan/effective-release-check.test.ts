import { describe, expect, it } from 'vitest';
import { Binds } from '../../platform/authority-principal.ts';
import { assertReleaseCheckText, effectiveReleaseCheck } from './repo-scan-checks.ts';

const RAW = JSON.stringify({
  release: { id: 'r1', generation: 2, version: 'v1', candidateHash: 'h' },
});

describe('effectiveReleaseCheck', () => {
  it('pins its pass by the grant tenant and binds exactly the pass and the release', () => {
    const b = new Binds();
    const text = effectiveReleaseCheck('pass-1', RAW).ok(b, 'org_mode');
    expect(b.params).toEqual(['pass-1', 'r1']);
    expect([...text.matchAll(/\b(?:FROM|JOIN)\s+passes\s+(\w+)/gi)].map((m) => m[1])).toEqual([
      'p',
    ]);
    expect(text).toContain('p.org_id = a.org_id');
    expect(text).toContain('p.mode = a.mode');
    expect(text.match(/\?/g)).toHaveLength(2);
    expect(text).not.toMatch(/\bg\./);
    expect([...text.matchAll(/\ba\.(\w+)/g)].map((m) => m[1])).toEqual(['org_id', 'mode']);
  });

  it('binds null for a pass without a release, and is false without a snapshot', () => {
    const b = new Binds();
    effectiveReleaseCheck('pass-1', JSON.stringify({ release: null })).ok(b, 'org_mode');
    expect(b.params).toEqual(['pass-1', null]);
    expect(effectiveReleaseCheck('pass-1', undefined).ok(new Binds(), 'org_mode')).toBe('0');
  });

  it('refuses text that is not pinned, binds a tenant column, or names a reserved alias', () => {
    const ok = effectiveReleaseCheck('p', RAW).ok(new Binds(), 'org_mode');
    expect(() => assertReleaseCheckText(ok, 2, 'org_mode')).not.toThrow();
    const cases: [string, string, number][] = [
      ['unpinned pass', ok.replace('p.org_id = a.org_id', '1 = 1'), 2],
      ['unpinned mode', ok.replace('p.mode = a.mode', '1 = 1'), 2],
      ['bound org', `${ok} AND p.org_id = ?`, 3],
      ['grant alias', `${ok} AND g.org_id = p.org_id`, 2],
      ['actor column', `${ok} AND a.status = 1`, 2],
      ['second passes alias', `${ok} AND EXISTS (SELECT 1 FROM passes q WHERE q.id = p.id)`, 2],
      ['wrong bind count', ok, 3],
    ];
    for (const [, text, bound] of cases)
      expect(() => assertReleaseCheckText(text, bound, 'org_mode')).toThrow();
  });

  it('is refused without a tenant', () => {
    expect(() => effectiveReleaseCheck('pass-1', RAW).ok(new Binds(), 'platform')).toThrow();
  });
});
