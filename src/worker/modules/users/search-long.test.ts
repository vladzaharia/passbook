import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { listUsers } from './repo.ts';

describe('user search at any length', () => {
  it('matches long, multi-byte and literal %/_ prefixes without a D1 pattern error', async () => {
    const f = fixtures(await makeEnv());
    const longEmail = `${'long.address.part-'.repeat(4)}@example.com`;
    const longName = `${'Zoë 日本 '.repeat(8)}Quinn`;
    const a = await makeUser(f, { primaryEmail: longEmail });
    const b = await makeUser(f);
    const c = await makeUser(f);
    await run(env.DB, 'UPDATE users SET name = ? WHERE id = ?', [longName, b.id]);
    await run(env.DB, 'UPDATE users SET name = ? WHERE id = ?', ['Promo 100%_off', c.id]);
    const search = async (q: string) =>
      (await listUsers(env.DB, { q, limit: 10 })).map((u) => u.id);
    expect(longEmail.length).toBeGreaterThan(50);
    expect(await search(longEmail)).toEqual([a.id]);
    expect(await search(longEmail.toUpperCase())).toEqual([a.id]);
    expect(await search(`${longEmail.slice(0, -1)}x`)).toEqual([]);
    expect(await search(longName.slice(0, 45))).toEqual([b.id]);
    expect(await search(`${longName.slice(0, 44)}X`)).toEqual([]);
    expect(await search('Promo 100%_')).toEqual([c.id]);
    expect(await search('Promo 100%x')).toEqual([]);
  });
});
