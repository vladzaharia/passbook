import { beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { getConnection } from './repo.ts';
import * as service from './service.ts';
import { addMembership, createDemo, demoInput, type Kit, linkedPass, makeKit } from './test-kit.ts';

let kit: Kit;

beforeEach(async () => {
  kit = await makeKit();
});

async function memberAuthority(roles: OrgRole[]): Promise<ConnectionAuthority> {
  const user = await makeUser(kit);
  await addMembership(kit, user.id, roles);
  const fixture = await makeSession(kit, { userId: user.id });
  const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!session) throw new Error('The persisted session did not resolve');
  return authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
}

async function keyRequest(scopes: string[], method: string, path: string, body: unknown) {
  const key = await makeApiKey(kit, { orgId: kit.org.id, scopes });
  const app = createApp({
    stores: { ...denyAllStores, apiKeys: createApiKeyStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const response = await app.request(
    path,
    {
      method,
      headers: { ...key.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
  return response.status;
}

const switches = (): [string, Record<string, unknown>][] => [
  ['autoCreate', { autoCreate: true, defaultTemplateId: kit.templateId }],
  ['autoEmail', { autoEmail: true }],
  ['defaultTemplateId', { defaultTemplateId: kit.templateId }],
  ['mapping', { mapping: { name: { from: 'name' } } }],
  ['onMissing', { onMissing: 'void' }],
];

describe('issuing switches on a connection', () => {
  it('refuses an integration_admin without pass rights, on create and update', async () => {
    const manager = await memberAuthority(['integration_admin']);
    const existing = await service.create(kit.sctx, kit.actor, demoInput(kit));
    for (const [name, patch] of switches()) {
      await expect(
        service.create(kit.sctx, kit.actor, demoInput(kit, patch), manager),
        `create ${name}`,
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.update(kit.sctx, kit.actor, existing.id, patch, manager),
        `update ${name}`,
      ).rejects.toMatchObject({ status: 403 });
    }
    const stored = await getConnection(kit.env.DB, existing.id);
    expect(stored).toMatchObject({ autoCreate: false, autoEmail: false, onMissing: 'flag' });
  });

  it('lets an integration_admin manage the non-issuing settings and resend current values', async () => {
    const manager = await memberAuthority(['integration_admin']);
    const created = await service.create(kit.sctx, kit.actor, demoInput(kit));
    const renamed = await service.update(
      kit.sctx,
      kit.actor,
      created.id,
      { name: 'Renamed', enabled: false, autoCreate: false, autoEmail: false, onMissing: 'flag' },
      manager,
    );
    expect(renamed.name).toBe('Renamed');
    await service.create(kit.sctx, kit.actor, demoInput(kit, { name: 'Plain' }), manager);
  });

  it('accepts every switch with pass rights', async () => {
    const operator = await memberAuthority(['integration_admin', 'pass_operator']);
    for (const [name, patch] of switches()) {
      const created = await service.create(kit.sctx, kit.actor, demoInput(kit, { name }), operator);
      await service.update(kit.sctx, kit.actor, created.id, patch, operator);
    }
  });

  const httpArmed = (overrides: Record<string, unknown> = {}) =>
    service.create(
      kit.sctx,
      kit.actor,
      demoInput(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com/v1' },
        secrets: { token: 'original-secret' },
        mode: 'hybrid',
        ...overrides,
      } as never),
    );

  const sources: [string, Record<string, unknown>][] = [
    ['config', { config: { baseUrl: 'https://evil.example.com/v1' } }],
    ['secrets', { secrets: { token: 'swapped' } }],
    ['webhookSecret', { webhookSecret: 'a-brand-new-webhook-secret' }],
    ['mode', { mode: 'webhook' }],
    ['holderEmailField', { holderEmailField: 'other' }],
  ];

  it.each([
    ['autoCreate', { autoCreate: true, defaultTemplateId: undefined }],
    ['autoEmail', { autoEmail: true }],
    ['onMissing void', { onMissing: 'void' }],
  ] as const)(
    'refuses a source change by an integration_admin on a connection armed by %s',
    async (_name, armed) => {
      const manager = await memberAuthority(['integration_admin']);
      const withTemplate = 'autoCreate' in armed ? { defaultTemplateId: kit.templateId } : {};
      const created = await httpArmed({ ...armed, ...withTemplate });
      for (const [name, patch] of sources) {
        await expect(
          service.update(kit.sctx, kit.actor, created.id, patch, manager),
          name,
        ).rejects.toMatchObject({ status: 403, code: 'MISSING_SCOPE' });
      }
      await expect(
        actions.rotateWebhookSecret(kit.sctx, kit.actor, created.id, manager),
      ).rejects.toMatchObject({ status: 403 });
      await service.update(kit.sctx, kit.actor, created.id, { enabled: false }, manager);
      await expect(
        service.update(kit.sctx, kit.actor, created.id, { enabled: true }, manager),
      ).rejects.toMatchObject({ status: 403 });
      expect(await getConnection(kit.env.DB, created.id)).toMatchObject({
        config: { baseUrl: 'https://api.example.com/v1' },
        mode: 'hybrid',
        enabled: false,
      });
    },
  );

  it('lets pass operators change the source and rotate the secret of an armed connection', async () => {
    const operator = await memberAuthority(['integration_admin', 'pass_operator']);
    const created = await httpArmed({ autoEmail: true });
    for (const [, patch] of sources)
      await service.update(kit.sctx, kit.actor, created.id, patch, operator);
    const rotated = await actions.rotateWebhookSecret(kit.sctx, kit.actor, created.id, operator);
    expect(rotated.webhookSecret).not.toBe('a-brand-new-webhook-secret');
  });

  it('treats a connection with live pass bindings as armed even with every switch off', async () => {
    const manager = await memberAuthority(['integration_admin']);
    const bound = await httpArmed();
    const idle = await httpArmed({ name: 'Idle' });
    await linkedPass(kit, bound.id, 'bound-001');
    await expect(
      service.update(kit.sctx, kit.actor, bound.id, sources[0]?.[1] ?? {}, manager),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      actions.rotateWebhookSecret(kit.sctx, kit.actor, bound.id, manager),
    ).rejects.toMatchObject({ status: 403 });
    // No bindings and no switches: nothing to issue, so the manager keeps full control.
    await service.update(kit.sctx, kit.actor, idle.id, sources[0]?.[1] ?? {}, manager);
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, idle.id, manager);
  });

  it('lets an integration_admin disarm a connection and edit the unrelated settings', async () => {
    const manager = await memberAuthority(['integration_admin']);
    const created = await httpArmed({
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
      onMissing: 'void',
    });
    await service.update(kit.sctx, kit.actor, created.id, { name: 'Still works' }, manager);
    await service.update(
      kit.sctx,
      kit.actor,
      created.id,
      { autoCreate: false, autoEmail: false, onMissing: 'flag', enabled: false },
      manager,
    );
    expect(await getConnection(kit.env.DB, created.id)).toMatchObject({
      name: 'Still works',
      autoCreate: false,
      autoEmail: false,
      onMissing: 'flag',
      enabled: false,
    });
    // Disarmed and unbound: the source is the manager's again.
    await service.update(kit.sctx, kit.actor, created.id, sources[0]?.[1] ?? {}, manager);
  });

  it('refuses a connections:write-only key and accepts one with passes:write', async () => {
    const base = { name: 'keyed', connectorType: 'demo', config: { count: 1 }, mode: 'poll' };
    for (const [name, patch] of switches()) {
      const created = await createDemo(kit, { name: `target-${name}` });
      const body = { ...base, orgId: kit.org.id, name, ...patch };
      expect(await keyRequest(['connections:write'], 'POST', '/api/v1/connections', body)).toBe(
        403,
      );
      expect(
        await keyRequest(
          ['connections:write'],
          'PATCH',
          `/api/v1/connections/${created.id}`,
          patch,
        ),
      ).toBe(403);
      expect(
        await keyRequest(['connections:write', 'passes:write'], 'POST', '/api/v1/connections', {
          ...body,
          name: `${name}-ok`,
        }),
      ).toBe(201);
      expect(
        await keyRequest(
          ['connections:write', 'passes:write'],
          'PATCH',
          `/api/v1/connections/${created.id}`,
          patch,
        ),
      ).toBe(200);
    }
  });

  it('refuses a connections:write-only key on an armed connection and accepts a pass key', async () => {
    const armed = await httpArmed({ autoEmail: true });
    const patch = { config: { baseUrl: 'https://evil.example.com/v1' } };
    const path = `/api/v1/connections/${armed.id}`;
    expect(await keyRequest(['connections:write'], 'PATCH', path, patch)).toBe(403);
    expect(await keyRequest(['connections:write'], 'POST', `${path}/webhook-secret`, {})).toBe(403);
    expect(await keyRequest(['connections:write', 'passes:write'], 'PATCH', path, patch)).toBe(200);
  });

  it('refuses at the grant for a key whose forged authority claims passes:write', async () => {
    const armed = await httpArmed({ autoEmail: true });
    const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const forged = {
      kind: 'api_key',
      orgId: kit.org.id,
      orgAccessRevision: 1,
      keyId: key.id,
      keyOrgId: kit.org.id,
      scopes: ['connections:write', 'passes:write'],
      scope: 'connections:write',
      mode: 'live',
    } as ConnectionAuthority;
    await expect(
      service.update(
        kit.sctx,
        kit.actor,
        armed.id,
        { enabled: false, autoEmail: true, config: { baseUrl: 'https://x.example.com/v1' } },
        forged,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    await expect(
      actions.rotateWebhookSecret(kit.sctx, kit.actor, armed.id, forged),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
  });

  it('refuses at the grant when the membership row does not hold pass rights', async () => {
    const real = await memberAuthority(['integration_admin']);
    if (real.kind !== 'session') throw new Error('Expected a session authority');
    const forged: ConnectionAuthority = { ...real, roles: ['integration_admin', 'pass_operator'] };
    const created = await createDemo(kit);
    await expect(
      service.update(kit.sctx, kit.actor, created.id, { autoEmail: true }, forged),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect((await getConnection(kit.env.DB, created.id))?.autoEmail).toBe(false);
  });
});
