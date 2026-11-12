import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { listOrgRows } from './repo.ts';

describe('org search at any length', () => {
  it('matches long, multi-byte and literal %/_ terms without a D1 pattern error', async () => {
    const f = fixtures(await makeEnv());
    const longName = `Grand ${'Harbor 日本 '.repeat(7)}Club`;
    const longSlug = `${'slug-part-'.repeat(6)}end`;
    const a = await makeOrg(f, { name: longName });
    const b = await makeOrg(f, { slug: longSlug });
    const c = await makeOrg(f, { name: '100%_off Club' });
    const search = async (q: string) =>
      (await listOrgRows(env.DB, undefined, 10, q)).map((o) => o.id);
    expect(longName.length).toBeGreaterThan(50);
    expect(await search(longName.slice(2, 62))).toEqual([a.id]);
    expect(await search(longName.slice(2, 62).toUpperCase())).toEqual([a.id]);
    expect(await search(`${longName.slice(2, 61)}X`)).toEqual([]);
    expect(await search(longSlug)).toEqual([b.id]);
    expect(await search(`${longSlug}x`)).toEqual([]);
    expect(await search('100%_off')).toEqual([c.id]);
    expect(await search('100%xoff')).toEqual([]);
  });
});
