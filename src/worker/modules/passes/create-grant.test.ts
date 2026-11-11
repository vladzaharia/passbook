import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoLeakedGrants,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { tenantAuthorityOf } from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let release: TemplateRelease;
let app: OpenAPIHono<AppBindings>;

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
}, 60_000);

async function operator(orgId = kit.org.id, roles = ['pass_operator']) {
  const user = await makeUser(kit.fx);
  const now = kit.clock.now();
  const invitation = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitation,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      kit.fx.ids.token(),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, user.id, invitation, JSON.stringify(roles), now],
  );
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  return { user, membershipId, session };
}

const body = (orgId = kit.org.id, externalId = kit.fx.ids.token(12)) => ({
  orgId,
  templateId: release.templateId,
  templateVersion: release.version,
  releaseId: release.id,
  releaseGeneration: release.generation,
  mode: 'live',
  input: { memberName: 'Grant Create' },
  externalId,
});

const issue = (headers: Record<string, string>, payload: object, key = kit.fx.ids.token(12)) =>
  app.request(
    `${ORIGIN}/api/v1/passes`,
    {
      method: 'POST',
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(payload),
    },
    kit.env,
  );

async function records(passId: string) {
  return {
    events: await all<{ kind: string; actor_type: string | null }>(
      kit.env.DB,
      'SELECT kind, actor_type FROM pass_events WHERE pass_id = ?',
      [passId],
    ),
    audit: await all<{ action: string; actor_id: string | null; org_id: string }>(
      kit.env.DB,
      "SELECT action, actor_id, org_id FROM audit_log WHERE target_id = ? AND action = 'pass.create'",
      [passId],
    ),
  };
}

describe('pass create as a grant', () => {
  it('creates through a session, with its event and audit in the same commit', async () => {
    const actor = await operator();
    const response = await issue(actor.session.headers, body());
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const written = await records(id);
    expect(written.events).toEqual([{ kind: 'pass.issued', actor_type: 'user' }]);
    expect(written.audit).toEqual([
      { action: 'pass.create', actor_id: actor.user.id, org_id: kit.org.id },
    ]);
    await assertNoLeakedGrants(kit.env.DB);
  });

  it('creates through an API key and answers an idempotent replay with the same pass', async () => {
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const idem = kit.fx.ids.token(12);
    const payload = body();
    const first = await issue(key.headers, payload, idem);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const replay = await issue(key.headers, payload, idem);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ id });
    expect((await records(id)).audit).toHaveLength(1);
    await assertNoLeakedGrants(kit.env.DB);
  });

  it('creates through a platform key that names the org', async () => {
    const key = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:write'] });
    const response = await issue(key.headers, body());
    expect(response.status).toBe(201);
  });

  it('refuses a revoked membership with 403 and writes nothing', async () => {
    const actor = await operator();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      actor.membershipId,
    ]);
    const payload = body();
    const response = await issue(actor.session.headers, payload);
    expect(response.status).toBe(403);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM passes WHERE external_id = ?', [payload.externalId]),
    ).toBeNull();
  });

  it('refuses an org suspended after the caller was authorized with 403 ORG_ACCESS_CHANGED', async () => {
    const actor = await operator();
    const auth = await createSessionStore(kit.env, kit.clock).resolve(actor.session.cookieValue);
    if (!auth) throw new Error('The session did not resolve');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate');
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      await expect(
        createPassRow(kit.ctx, {
          orgId: kit.org.id,
          templateId: release.templateId,
          templateVersion: release.version,
          releaseId: release.id,
          releaseGeneration: release.generation,
          input: { memberName: 'Suspended' },
          source: 'manual',
          mode: 'live',
          execution: { kind: 'tenant', authority },
          actor: { type: 'user', id: actor.user.id },
        }),
      ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });

  it('refuses a create in another org', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    await approveAppleRelease(kit, { orgId: other.id, mode: 'live' });
    const actor = await operator();
    const payload = body(other.id);
    const response = await issue(actor.session.headers, payload);
    expect([403, 404]).toContain(response.status);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM passes WHERE external_id = ?', [payload.externalId]),
    ).toBeNull();
  });

  it('refuses a template with no approved release and creates nothing', async () => {
    const other = await makeOrg(kit.fx, { name: 'No release' });
    const actor = await operator(other.id);
    const payload = { ...body(other.id), releaseId: undefined, releaseGeneration: undefined };
    const response = await issue(actor.session.headers, payload);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM passes WHERE external_id = ?', [payload.externalId]),
    ).toBeNull();
  });

  it('is not failed by a rename, settings or branding save during the create', async () => {
    const actor = await operator();
    const payload = body();
    const before = await first<{ access_revision: number }>(
      kit.env.DB,
      'SELECT access_revision FROM orgs WHERE id = ?',
      [kit.org.id],
    );
    await run(kit.env.DB, 'UPDATE orgs SET name = ?, branding = ? WHERE id = ?', [
      'Renamed org',
      JSON.stringify({ accent: 'red' }),
      kit.org.id,
    ]);
    const response = await issue(actor.session.headers, payload);
    expect(response.status).toBe(201);
    expect(
      (
        await first<{ access_revision: number }>(
          kit.env.DB,
          'SELECT access_revision FROM orgs WHERE id = ?',
          [kit.org.id],
        )
      )?.access_revision,
    ).toBe(before?.access_revision);
  });

  it('queues the issuance delivery in the same grant as the pass', async () => {
    const actor = await operator();
    const response = await issue(actor.session.headers, {
      ...body(),
      holderEmail: 'holder@example.test',
      sendEmail: true,
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_issuance_deliveries WHERE pass_id = ?', [id]),
    ).not.toBeNull();
  });
});
