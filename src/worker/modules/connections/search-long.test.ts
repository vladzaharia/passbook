import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { listConnections } from './repo-list.ts';

describe('connection search at any length', () => {
  it('matches long, multi-byte and literal %/_ terms without a D1 pattern error', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const names = {
      ascii: `Nightly ${'member sheet '.repeat(5)}sync`,
      wide: `Café ${'日本 sheet '.repeat(8)}sync`,
      literal: 'Promo 100%_off',
    };
    const ids: Record<string, string> = {};
    for (const [key, name] of Object.entries(names)) {
      const id = f.ids.id();
      ids[key] = id;
      await run(
        env.DB,
        "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, 1)",
        [id, org.id, name],
      );
    }
    const search = async (q: string) =>
      (await listConnections(env.DB, { orgId: org.id, q, limit: 10 })).map((c) => c.id);
    expect(names.ascii.length).toBeGreaterThan(50);
    expect(await search(names.ascii.slice(3, 63).toUpperCase())).toEqual([ids.ascii]);
    expect(await search(`${names.ascii.slice(3, 62)}X`)).toEqual([]);
    expect(await search(names.wide.slice(4, 48))).toEqual([ids.wide]);
    expect(await search(`${names.wide.slice(4, 47)}X`)).toEqual([]);
    expect(await search('100%_')).toEqual([ids.literal]);
    expect(await search('100%x')).toEqual([]);
  });
});
