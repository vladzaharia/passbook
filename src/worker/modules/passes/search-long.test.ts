import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { listPasses } from './repo-list.ts';

describe('pass search at any length', () => {
  it('matches long, multi-byte and literal %/_ prefixes without a D1 pattern error', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate();
    const titles = {
      ascii: `${'Harbor '.repeat(9)}Alice`,
      wide: `${'Café 日本 '.repeat(8)}Bob`,
      literal: 'Promo 100%_off',
    };
    const passes: Record<string, string> = {};
    for (const [key, title] of Object.entries(titles)) {
      const pass = await makePass(f, {
        orgId: org.id,
        template: template.resolved,
        registry: template.registry,
      });
      await run(env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [title, pass.id]);
      passes[key] = pass.id;
    }
    await makePass(f, {
      orgId: org.id,
      template: template.resolved,
      registry: template.registry,
      persist: false,
    });
    const search = async (q: string) =>
      (await listPasses(env.DB, { orgId: org.id, q, limit: 10 })).items.map((p) => p.id);
    expect(titles.ascii.length).toBeGreaterThan(50);
    expect(await search(titles.ascii.slice(0, 60))).toEqual([passes.ascii]);
    expect(await search(`${titles.ascii.slice(0, 59)}X`)).toEqual([]);
    expect(await search(titles.wide.slice(0, 40))).toEqual([passes.wide]);
    expect(await search(`${titles.wide.slice(0, 39)}X`)).toEqual([]);
    expect(await search('Promo 100%_')).toEqual([passes.literal]);
    expect(await search('Promo 100%x')).toEqual([]);
  });
});
