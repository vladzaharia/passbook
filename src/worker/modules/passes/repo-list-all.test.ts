import { beforeAll, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
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
});
