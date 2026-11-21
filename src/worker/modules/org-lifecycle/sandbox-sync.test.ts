import { beforeAll, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { closeOrg, reopenOrg } from './service.ts';

const actor = { type: 'system' as const, id: null };
let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
}, 30_000);

it("keeps a developer sandbox's closed_at in step with an org close and reopen", async () => {
  const { kit } = rk;
  const dev = await makeOrg(kit.fx, { kind: 'developer' });
  const user = await makeUser(kit.fx);
  await run(
    kit.env.DB,
    'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    [kit.fx.ids.id(), dev.id, user.id, kit.clock.now()],
  );
  const sandbox = () =>
    first<{ closed_at: number | null; close_reason: string | null }>(
      kit.env.DB,
      'SELECT closed_at, close_reason FROM developer_sandboxes WHERE org_id = ?',
      [dev.id],
    );
  expect(await sandbox()).toEqual({ closed_at: null, close_reason: null });

  const closedAt = kit.clock.now();
  await closeOrg(kit.ctx, actor, dev.id, { kind: 'platform', ...(await rk.platform()) });
  expect(await sandbox()).toEqual({ closed_at: closedAt, close_reason: 'admin' });

  await reopenOrg(kit.ctx, actor, dev.id, await rk.platform());
  expect(await sandbox()).toEqual({ closed_at: null, close_reason: null });
});
