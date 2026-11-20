import { beforeAll, describe, expect, it } from 'vitest';
import {
  limitSuite,
  makeSession,
  makeUser,
  refusedBy,
  setLimit,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type BroadcastKit, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;
let kit: BroadcastKit;
let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;

beforeAll(async () => {
  kit = await broadcastKit();
  const user = await makeUser(kit.fx);
  const now = kit.clock.now();
  const invitation = kit.fx.ids.id();
  const roles = JSON.stringify(['org_admin']);
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitation, kit.org.id, roles, kit.fx.ids.token(), now, now + 3_600_000, now, user.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [kit.fx.ids.id(), kit.org.id, user.id, invitation, roles, now],
  );
  headers = (await makeSession(kit.fx, { userId: user.id, roles: ['user'] })).headers;
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const create = () =>
  app.request(
    `${ORIGIN}/api/v1/broadcasts`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        kind: 'message',
        target: { templateIds: [kit.messaging.id] },
        patch: { message: 'Limit test' },
        send: 'draft',
      }),
    },
    kit.env,
  );

/** Manual broadcasts made in the last day, cancelled ones aside: what the limit counts. */
const held = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      `SELECT COUNT(*) AS n FROM broadcasts WHERE org_id = ? AND rule_id IS NULL
        AND parent_id IS NULL AND state <> 'cancelled' AND created_at > ?`,
      [kit.org.id, kit.clock.now() - DAY],
    )
  )?.n ?? 0;

limitSuite('broadcasts per day', async () => ({
  db: kit.env.DB,
  orgId: kit.org.id,
  key: 'messages.perDay',
  create: async () => refusedBy(await create()),
  count: held,
}));

describe('broadcast limits', () => {
  it('the day rolls: yesterday is not counted, and a cancelled draft frees its slot', async () => {
    const before = await held();
    await setLimit(kit.env.DB, kit.org.id, 'messages.perDay', before);
    expect((await refusedBy(await create()))?.code).toBe('FEATURE_LIMIT_REACHED');
    await run(
      kit.env.DB,
      `UPDATE broadcasts SET state = 'cancelled'
       WHERE id = (SELECT id FROM broadcasts WHERE org_id = ? AND state = 'draft' LIMIT 1)`,
      [kit.org.id],
    );
    expect(await held()).toBe(before - 1);
    expect(await refusedBy(await create())).toBeNull();
    expect((await refusedBy(await create()))?.code).toBe('FEATURE_LIMIT_REACHED');
    await run(kit.env.DB, 'UPDATE broadcasts SET created_at = created_at - ? WHERE org_id = ?', [
      2 * DAY,
      kit.org.id,
    ]);
    expect(await held()).toBe(0);
    expect(await refusedBy(await create())).toBeNull();
  });
});
