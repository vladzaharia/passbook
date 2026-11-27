import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { passesByIds } from './repo-list-all.ts';
import { listPassesSql } from './repo-list.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

describe('cross-organization list branch', () => {
  it('reads passes_org_mode in order, with no temp B-tree', async () => {
    const { sql, params } = listPassesSql({
      orgId: kit.org.id,
      mode: 'live',
      cursor: kit.fx.ids.id(),
      limit: 50,
    });
    const plan = await all<{ detail: string }>(kit.env.DB, `EXPLAIN QUERY PLAN ${sql}`, params);
    const details = plan.map((p) => p.detail);
    const search = details.find((d) => /^SEARCH passes /.test(d));
    expect(search).toMatch(/USING INDEX passes_org_mode \(org_id=\? AND mode=\? AND id<\?\)/);
    expect(details.join('\n')).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('reads page rows only from the listed organizations', async () => {
    const other = await makeOrg(kit.fx);
    const mine = await makePass(kit.fx, { orgId: kit.org.id, template: kit.template });
    const theirs = await makePass(kit.fx, { orgId: other.id, template: kit.template });
    const rows = await passesByIds(kit.env.DB, [kit.org.id], [mine.id, theirs.id]);
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });
});
