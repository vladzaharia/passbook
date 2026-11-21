import { beforeAll, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { runOrgPurge } from '../../workflows/org-purge.ts';
import { fakeStep } from '../org-lifecycle/lifecycle-test-fixtures.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { closeSandbox } from './repo-grants.ts';

const DAY = 86_400_000;
let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
}, 30_000);

it('purges a closed developer org: the Live-fenced principals still reach its Test passes', async () => {
  const { kit } = rk;
  const dev = await makeOrg(kit.fx, { kind: 'developer' });
  const user = await makeUser(kit.fx);
  await run(
    kit.env.DB,
    'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    [kit.fx.ids.id(), dev.id, user.id, kit.clock.now()],
  );
  const pass = await kit.pass({ orgId: dev.id, mode: 'test' });
  expect(await closeSandbox(kit.ctx, dev.id)).toBe(true);
  kit.clock.advance(31 * DAY);
  await runOrgPurge(
    kit.env,
    { orgId: dev.id },
    fakeStep(undefined, kit.clock),
    undefined,
    kit.clock,
    2,
  );
  const org = await first<{ purged_at: number | null }>(
    kit.env.DB,
    'SELECT purged_at FROM orgs WHERE id = ?',
    [dev.id],
  );
  expect(org?.purged_at).not.toBeNull();
  expect(
    (
      await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM passes WHERE id = ?', [
        pass.id,
      ])
    )?.n,
  ).toBe(0);
});
