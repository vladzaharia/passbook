import { beforeAll, describe, expect, it } from 'vitest';
import { originUnlessKey } from '../../../../test/helpers/browser.ts';
import {
  assertNoLeakedGrants,
  limitSuite,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  refusedBy,
  refusedWhen,
  setLimit,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let release: TemplateRelease;
let app: ReturnType<typeof createApp>;
let session: Record<string, string>;

beforeAll(async () => {
  kit = await setupKit();
  const live = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  if (!live) throw new Error('The default approved release is missing');
  release = live;
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const user = await makeUser(kit.fx);
  const now = kit.clock.now();
  const invitation = kit.fx.ids.id();
  const roles = JSON.stringify(['pass_operator']);
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitation, kit.org.id, user.primaryEmail, roles, kit.fx.ids.token(), now, now + 60_000, now],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [kit.fx.ids.id(), kit.org.id, user.id, invitation, roles, now],
  );
  session = (await makeSession(kit.fx, { userId: user.id, roles: ['user'] })).headers;
});

const issue = (headers: Record<string, string>) =>
  app.request(
    `${ORIGIN}/api/v1/passes`,
    {
      method: 'POST',
      headers: {
        ...headers,
        ...originUnlessKey(headers, ORIGIN),
        'content-type': 'application/json',
        'idempotency-key': kit.fx.ids.token(12),
      },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: release.templateId,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
        input: { memberName: 'Limit Test' },
        externalId: kit.fx.ids.token(12),
      }),
    },
    kit.env,
  );

/** The passes the limit counts: not removed, not deleted, not quarantined. */
const held = async (mode: 'live' | 'test') =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      `SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND mode = ? AND removed_at IS NULL
        AND deleted_at IS NULL AND test_data_quarantined = 0`,
      [kit.org.id, mode],
    )
  )?.n ?? 0;

limitSuite('live passes (session)', async () => ({
  db: kit.env.DB,
  orgId: kit.org.id,
  key: 'passes.live',
  create: async () => refusedBy(await issue(session)),
  count: () => held('live'),
}));

limitSuite('test passes (system)', async () => ({
  db: kit.env.DB,
  orgId: kit.org.id,
  key: 'passes.test',
  create: () => refusedWhen(() => kit.pass({ mode: 'test' })),
  count: () => held('test'),
}));

describe('pass limits across paths', () => {
  it('an API key is refused at the same cap, and the live cap leaves test passes alone', async () => {
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const live = await held('live');
    await setLimit(kit.env.DB, kit.org.id, 'passes.live', live);
    expect(await refusedBy(await issue(key.headers))).toMatchObject({
      code: 'FEATURE_LIMIT_REACHED',
      feature: 'passes.live',
      limit: live,
      used: live,
    });
    await setLimit(kit.env.DB, kit.org.id, 'passes.test', null);
    expect(await refusedWhen(() => kit.pass({ mode: 'test' }))).toBeNull();
    await assertNoLeakedGrants(kit.env.DB);
  });

  it('a removed pass frees its slot', async () => {
    const live = await held('live');
    await setLimit(kit.env.DB, kit.org.id, 'passes.live', live);
    expect((await refusedBy(await issue(session)))?.code).toBe('FEATURE_LIMIT_REACHED');
    await run(
      kit.env.DB,
      `UPDATE passes SET removed_at = ? WHERE id = (
         SELECT id FROM passes WHERE org_id = ? AND mode = 'live' AND removed_at IS NULL
           AND deleted_at IS NULL AND test_data_quarantined = 0 LIMIT 1)`,
      [kit.clock.now(), kit.org.id],
    );
    expect(await held('live')).toBe(live - 1);
    expect(await refusedBy(await issue(session))).toBeNull();
  });

  it('a limit of 0 refuses every create', async () => {
    await setLimit(kit.env.DB, kit.org.id, 'passes.live', 0);
    expect(await refusedBy(await issue(session))).toMatchObject({
      limit: 0,
      used: await held('live'),
    });
  });

  it('a tenant at its cap does not block another tenant, and counts only its own passes', async () => {
    const other = await makeOrg(kit.fx);
    await setLimit(kit.env.DB, kit.org.id, 'passes.live', 0);
    expect((await refusedBy(await issue(session)))?.code).toBe('FEATURE_LIMIT_REACHED');
    // The other org's cap of 1 is judged on its own passes, not on the many this org holds.
    await setLimit(kit.env.DB, other.id, 'passes.live', 1);
    expect(await refusedWhen(() => kit.pass({ orgId: other.id }))).toBeNull();
    expect(await refusedWhen(() => kit.pass({ orgId: other.id }))).toMatchObject({
      code: 'FEATURE_LIMIT_REACHED',
      limit: 1,
      used: 1,
    });
    await assertNoLeakedGrants(kit.env.DB);
  });
});
