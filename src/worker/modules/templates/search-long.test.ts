import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { listTemplates } from './repo-list.ts';

describe('template search at any length', () => {
  it('matches long, multi-byte and literal %/_ terms without a D1 pattern error', async () => {
    const f = fixtures(await makeEnv());
    const rows = {
      ascii: { name: `Conference ${'badge layout '.repeat(5)}final`, slug: 'conf-badge' },
      wide: { name: `Café ${'日本 badge '.repeat(8)}final`, slug: 'cafe-badge' },
      slug: { name: 'Plain', slug: `${'slug-part-'.repeat(7)}end` },
      literal: { name: 'Promo 100%_off', slug: 'promo' },
    };
    const ids: Record<string, string> = {};
    for (const [key, row] of Object.entries(rows)) {
      const id = f.ids.id();
      ids[key] = id;
      await run(
        env.DB,
        "INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at) VALUES (?, NULL, ?, ?, 'uploaded', 'v1', 1, 1)",
        [id, row.slug, row.name],
      );
    }
    const search = async (q: string) =>
      (await listTemplates(env.DB, { orgId: null, q, limit: 10 }))
        .map((t) => t.id)
        .filter((id) => Object.values(ids).includes(id));
    expect(rows.ascii.name.length).toBeGreaterThan(50);
    expect(await search(rows.ascii.name.slice(4, 64).toUpperCase())).toEqual([ids.ascii]);
    expect(await search(`${rows.ascii.name.slice(4, 63)}X`)).toEqual([]);
    expect(await search(rows.wide.name.slice(4, 48))).toEqual([ids.wide]);
    expect(await search(`${rows.wide.name.slice(4, 47)}X`)).toEqual([]);
    expect(await search(rows.slug.slug)).toEqual([ids.slug]);
    expect(await search('100%_')).toEqual([ids.literal]);
    expect(await search('100%x')).toEqual([]);
  });
});
