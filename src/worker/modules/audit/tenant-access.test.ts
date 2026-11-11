import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowInvalidRoleNames,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { AuditListSchema } from '../../../shared/contracts/audit.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { listAuditRows } from './repo.ts';
import { recordAudit } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let appEnv: AppEnv;

type Entry = {
  id: number;
  orgId: string | null;
  action: string;
  actorId: string | null;
  actorLabel: string | null;
  targetId: string | null;
  targetLabel: string | null;
  detail: Record<string, unknown> | null;
};
type Page = { items: Entry[]; nextCursor: string | null };

const get = (query: string, headers: Record<string, string>, platform = false) =>
  app.request(`/api/v1/audit${platform ? '/platform' : ''}${query}`, { headers }, appEnv);

async function page(
  query: string,
  headers: Record<string, string>,
  platform = false,
): Promise<Page> {
  const response = await get(query, headers, platform);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

async function addMember(
  f: Fixtures,
  orgId: string,
  userId: string,
  roles: OrgRole[] = ['read_only'],
) {
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = f.clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
     (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, JSON.stringify(roles), f.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

async function setup() {
  const f = fixtures(appEnv);
  const north = await makeOrg(f, { name: 'North org' });
  const south = await makeOrg(f, { name: 'South org' });
  const reader = await makeUser(f);
  const membershipId = await addMember(f, north.id, reader.id);
  return { f, north, south, reader, membershipId, headers: fake.user(reader.id) };
}

beforeAll(async () => {
  appEnv = await makeEnv();
});

beforeEach(async () => {
  await run(env.DB, 'DELETE FROM audit_log');
});

describe('tenant audit access', () => {
  it('requires explicit current pass-reading membership and scopes before pagination', async () => {
    const { f, north, south, reader, membershipId, headers } = await setup();
    const ctx = createServiceContext(appEnv);
    await recordAudit(ctx, {
      orgId: north.id,
      actorType: 'user',
      actorId: reader.id,
      action: 'north.old',
    });
    await recordAudit(ctx, { orgId: south.id, actorType: 'system', action: 'south.secret' });
    await recordAudit(ctx, { actorType: 'system', action: 'platform.secret' });
    await recordAudit(ctx, {
      orgId: north.id,
      actorType: 'user',
      actorId: reader.id,
      action: 'north.new',
    });

    const first = await page(`?orgId=${north.id}&limit=1`, headers);
    expect(first.items.map((item) => item.action)).toEqual(['north.new']);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(`?orgId=${north.id}&limit=1&cursor=${first.nextCursor}`, headers);
    expect(second.items.map((item) => item.action)).toEqual(['north.old']);
    expect(second.nextCursor).toBeNull();
    expect((await get('', headers)).status).toBe(422);
    expect((await get(`?orgId=${south.id}`, headers)).status).toBe(403);
    expect((await get(`?orgId=${north.id}&cursor=bad`, headers)).status).toBe(422);

    const integrationUser = await makeUser(f);
    await addMember(f, north.id, integrationUser.id, ['integration_admin']);
    expect((await get(`?orgId=${north.id}`, fake.user(integrationUser.id))).status).toBe(403);

    const invalidUser = await makeUser(f);
    await allowInvalidRoleNames(appEnv.DB);
    await addMember(f, north.id, invalidUser.id, ['read_only', 'read_only']);
    expect((await get(`?orgId=${north.id}`, fake.user(invalidUser.id))).status).toBe(403);

    await run(appEnv.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [reader.id]);
    expect((await get(`?orgId=${north.id}`, headers)).status).toBe(403);
    await run(appEnv.DB, "UPDATE users SET status = 'active' WHERE id = ?", [reader.id]);
    await run(appEnv.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [north.id]);
    expect((await get(`?orgId=${north.id}`, headers)).status).toBe(403);
    await run(appEnv.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [north.id]);

    const filter = { orgId: north.id, tenant: { userId: reader.id, membershipId } };
    expect(await listAuditRows(appEnv.DB, filter, 10)).toHaveLength(2);

    await run(appEnv.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      f.clock.now(),
      membershipId,
    ]);
    expect((await get(`?orgId=${north.id}`, headers)).status).toBe(403);
    expect(await listAuditRows(appEnv.DB, filter, 10)).toEqual([]);
  });

  it('shows organization names and request ids to members, and refuses roles without audit:read', async () => {
    const { f, north, reader, headers } = await setup();
    const requestId = f.ids.id();
    await run(
      appEnv.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, request_id, detail)
       VALUES (?, ?, 'user', ?, 'org.update', ?, ?)`,
      [
        f.clock.now(),
        north.id,
        reader.id,
        requestId,
        JSON.stringify({ changes: { name: { from: 'North org', to: 'North Club' } } }),
      ],
    );
    const item = (await page(`?orgId=${north.id}`, headers)).items[0];
    expect(item).toMatchObject({
      requestId,
      detail: { changes: { name: { from: 'North org', to: 'North Club' } } },
    });
    const author = await makeUser(f);
    await addMember(f, north.id, author.id, ['template_author']);
    expect((await get(`?orgId=${north.id}`, fake.user(author.id))).status).toBe(403);
  });

  it('does not infer membership from a platform role and keeps platform reads explicit', async () => {
    const { f, north, south, reader, headers } = await setup();
    const platformUser = await makeUser(f);
    const admin = fake.session({ userId: platformUser.id, roles: ['admin', 'user'] });
    const memberAdmin = fake.session({ userId: reader.id, roles: ['admin', 'user'] });
    const ctx = createServiceContext(appEnv);
    await recordAudit(ctx, { orgId: north.id, actorType: 'system', action: 'north.action' });
    await recordAudit(ctx, { orgId: south.id, actorType: 'system', action: 'south.action' });
    await recordAudit(ctx, { actorType: 'system', action: 'platform.action' });

    expect((await get('', admin)).status).toBe(422);
    expect((await get(`?orgId=${north.id}`, admin)).status).toBe(403);
    expect(
      (await page(`?orgId=${north.id}`, memberAdmin)).items.map((item) => item.action),
    ).toEqual(['north.action']);
    expect((await page('', admin, true)).items.map((item) => item.action)).toEqual([
      'platform.action',
      'south.action',
      'north.action',
    ]);
    expect(
      (await page(`?orgId=${south.id}`, admin, true)).items.map((item) => item.action),
    ).toEqual(['south.action']);
    expect((await get('', headers, true)).status).toBe(403);
    expect((await get('', {}, false)).status).toBe(401);
    expect((await get(`?orgId=${north.id}`, fake.apiKey({ orgId: north.id }))).status).toBe(401);
    expect((await get(`?orgId=${south.id}`, fake.apiKey({ orgId: north.id }))).status).toBe(401);
    expect((await get(`?orgId=${north.id}`, fake.apiKey({ scopes: [] }))).status).toBe(401);
    expect((await get('', fake.apiKey(), true)).status).toBe(401);
  });

  it('masks foreign actors and targets, and does not turn ID filters into association oracles', async () => {
    const { f, north, south, reader, headers } = await setup();
    const outsider = await makeUser(f);
    await addMember(f, south.id, outsider.id);
    await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', ['North Operator', reader.id]);
    await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', [
      'South Private Actor',
      outsider.id,
    ]);
    const ownTemplate = makeTemplate({ id: f.ids.id(), orgId: north.id }).resolved;
    const foreignTemplate = makeTemplate({ id: f.ids.id(), orgId: south.id }).resolved;
    const ownPass = await makePass(f, { orgId: north.id, template: ownTemplate });
    const foreignPass = await makePass(f, { orgId: south.id, template: foreignTemplate });
    await run(appEnv.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'North Ticket',
      ownPass.id,
    ]);
    await run(appEnv.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'South Private Ticket',
      foreignPass.id,
    ]);
    const ctx = createServiceContext(appEnv);
    await recordAudit(ctx, {
      orgId: north.id,
      actorType: 'user',
      actorId: reader.id,
      action: 'own',
      targetType: 'pass',
      targetId: ownPass.id,
    });
    // A legacy row may contain references from a different organization despite its org_id.
    await recordAudit(ctx, {
      orgId: north.id,
      actorType: 'user',
      actorId: outsider.id,
      action: 'misreferenced',
      targetType: 'pass',
      targetId: foreignPass.id,
    });
    await recordAudit(ctx, {
      orgId: south.id,
      actorType: 'user',
      actorId: outsider.id,
      action: 'south.only',
      targetType: 'pass',
      targetId: foreignPass.id,
    });
    const items = (await page(`?orgId=${north.id}`, headers)).items;
    expect(items.find((item) => item.action === 'own')).toMatchObject({
      actorId: reader.id,
      actorLabel: 'North Operator',
      targetId: ownPass.id,
      targetLabel: 'North Ticket',
    });
    expect(items.find((item) => item.action === 'misreferenced')).toMatchObject({
      actorId: null,
      actorLabel: null,
      targetId: null,
      targetLabel: null,
    });
    expect(await page(`?orgId=${north.id}&actorId=${outsider.id}`, headers)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await page(`?orgId=${north.id}&targetType=pass&targetId=${foreignPass.id}`, headers),
    ).toEqual({ items: [], nextCursor: null });
    expect(await page(`?orgId=${north.id}&targetId=${foreignPass.id}`, headers)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await page(`?orgId=${north.id}&targetType=pass&targetId=unknown`, headers)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      (
        await page(
          `?orgId=${north.id}&actorId=${reader.id}&targetType=pass&targetId=${ownPass.id}`,
          headers,
        )
      ).items.map((item) => item.action),
    ).toEqual(['own']);
    await run(appEnv.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'https://wallet.test/b/private-capability',
      ownPass.id,
    ]);
    const sensitiveLabel = await get(`?orgId=${north.id}&action=own`, headers);
    const labelText = await sensitiveLabel.text();
    expect(labelText).not.toContain('private-capability');
    expect((JSON.parse(labelText) as Page).items[0]).toMatchObject({ targetLabel: null });

    await recordAudit(ctx, {
      orgId: north.id,
      actorType: 'user',
      actorId: reader.id,
      action: 'settings.update',
      targetType: 'settings',
      targetId: `org:${north.id}`,
    });
    const ownSettings = await page(
      `?orgId=${north.id}&targetType=settings&targetId=org%3A${north.id}`,
      headers,
    );
    expect(ownSettings.items).toMatchObject([{ targetId: `org:${north.id}` }]);
    expect(
      await page(`?orgId=${north.id}&targetType=settings&targetId=org%3A${south.id}`, headers),
    ).toEqual({ items: [], nextCursor: null });
  });

  it('resolves only same-org user, key and connection actors without email fallback', async () => {
    const { f, north, south, reader, headers } = await setup();
    const unnamed = await makeUser(f);
    await addMember(f, north.id, unnamed.id);
    const ownKey = await makeApiKey(f, { orgId: north.id, name: 'North key' });
    const foreignKey = await makeApiKey(f, { orgId: south.id, name: 'South private key' });
    const platformKey = await makeApiKey(f, { name: 'Platform private key' });
    const ownConnection = f.ids.id();
    const foreignConnection = f.ids.id();
    for (const [id, orgId, name] of [
      [ownConnection, north.id, 'North connection'],
      [foreignConnection, south.id, 'South private connection'],
    ] as const) {
      await run(
        appEnv.DB,
        `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at)
         VALUES (?, ?, 'demo', ?, ?, ?)`,
        [id, orgId, name, f.clock.now(), f.clock.now()],
      );
    }
    const ctx = createServiceContext(appEnv);
    for (const entry of [
      { actorType: 'user' as const, actorId: unnamed.id, action: 'unnamed' },
      { actorType: 'api_key' as const, actorId: ownKey.id, action: 'own-key' },
      { actorType: 'api_key' as const, actorId: foreignKey.id, action: 'foreign-key' },
      { actorType: 'api_key' as const, actorId: platformKey.id, action: 'platform-key' },
      { actorType: 'connection' as const, actorId: ownConnection, action: 'own-connection' },
      {
        actorType: 'connection' as const,
        actorId: foreignConnection,
        action: 'foreign-connection',
      },
    ]) {
      await recordAudit(ctx, { orgId: north.id, ...entry });
    }
    const response = await get(`?orgId=${north.id}`, headers);
    const text = await response.text();
    const items = (JSON.parse(text) as Page).items;
    const by = (action: string) => items.find((item) => item.action === action);
    expect(by('unnamed')).toMatchObject({ actorId: unnamed.id, actorLabel: null });
    expect(text).not.toContain(unnamed.primaryEmail);
    expect(by('own-key')).toMatchObject({ actorId: ownKey.id, actorLabel: 'North key' });
    expect(by('own-connection')).toMatchObject({
      actorId: ownConnection,
      actorLabel: 'North connection',
    });
    for (const action of ['foreign-key', 'platform-key', 'foreign-connection']) {
      expect(by(action)).toMatchObject({ actorId: null, actorLabel: null });
    }
    for (const secret of [
      foreignKey.id,
      platformKey.id,
      foreignConnection,
      'South private',
      'Platform private',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect((await page(`?orgId=${north.id}&actorId=${foreignKey.id}`, headers)).items).toEqual([]);
    expect((await page(`?orgId=${north.id}&actorId=${foreignConnection}`, headers)).items).toEqual(
      [],
    );
    await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', [
      unnamed.primaryEmail,
      unnamed.id,
    ]);
    const namedAsEmail = await get(`?orgId=${north.id}`, headers);
    const namedText = await namedAsEmail.text();
    expect(namedText).not.toContain(unnamed.primaryEmail);
    expect(
      (JSON.parse(namedText) as Page).items.find((item) => item.action === 'unnamed'),
    ).toMatchObject({
      actorId: unnamed.id,
      actorLabel: null,
    });
    const punctuated = 'private!@example.test';
    await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', [punctuated, unnamed.id]);
    const punctuatedResponse = await get(`?orgId=${north.id}`, headers);
    const punctuatedText = await punctuatedResponse.text();
    expect(punctuatedText).not.toContain(punctuated);
    const punctuatedPage = AuditListSchema.parse(JSON.parse(punctuatedText));
    expect(punctuatedPage.items.find((item) => item.action === 'unnamed')).toMatchObject({
      actorId: unnamed.id,
      actorLabel: null,
    });
    expect((await page(`?orgId=${north.id}&actorId=${reader.id}`, headers)).items).toEqual([]);
  });

  it('sanitizes legacy detail and arbitrary actor data at read time', async () => {
    const { f, north, south, reader, headers } = await setup();
    const outsider = await makeUser(f, { primaryEmail: 'private-person@example.test' });
    await addMember(f, south.id, outsider.id);
    await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', ['Private Person', outsider.id]);
    const detail = {
      userId: outsider.id,
      mode: 'live',
      count: 3,
      note: 'Private Person',
      changes: {
        email: outsider.primaryEmail,
        secret: 'my-secret',
        token: 'wlt_fakescope_supersecret',
        link: 'https://wallet.test/b/private-capability',
        arbitrary: outsider.id,
      },
      'Private Person': 'private-person@example.test',
    };
    await run(
      appEnv.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, detail)
       VALUES (?, ?, 'user', ?, 'legacy.detail', 'user', ?, ?, ?)`,
      [
        f.clock.now(),
        north.id,
        outsider.id,
        outsider.id,
        'https://wallet.test/b/private-capability',
        JSON.stringify(detail),
      ],
    );
    const response = await get(`?orgId=${north.id}`, headers);
    expect(response.status).toBe(200);
    const text = await response.text();
    const item = (JSON.parse(text) as Page).items[0];
    expect(item).toMatchObject({
      actorId: null,
      actorLabel: null,
      targetId: null,
      targetLabel: null,
      detail: {
        userId: '[redacted]',
        mode: 'live',
        count: 3,
        note: '[redacted]',
        changes: { email: '[redacted]' },
      },
    });
    for (const secret of [
      outsider.id,
      outsider.primaryEmail,
      'Private Person',
      'my-secret',
      'wlt_fakescope_supersecret',
      'private-capability',
    ]) {
      expect(text).not.toContain(secret);
    }
    const platform = await get('', fake.admin(), true);
    const platformText = await platform.text();
    for (const secret of [
      outsider.primaryEmail,
      'my-secret',
      'wlt_fakescope_supersecret',
      'private-capability',
    ]) {
      expect(platformText).not.toContain(secret);
    }
    // The same projection applies when a legitimate member is the actor.
    await run(appEnv.DB, 'UPDATE audit_log SET actor_id = ? WHERE action = ?', [
      reader.id,
      'legacy.detail',
    ]);
    const sameActor = await page(`?orgId=${north.id}`, headers);
    expect(sameActor.items[0]).toMatchObject({
      actorId: reader.id,
      detail: { userId: '[redacted]' },
    });
  });
});
