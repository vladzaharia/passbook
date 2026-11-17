import { beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import { getConnection } from './repo.ts';
import * as service from './service.ts';
import { addMembership, createDemo, demoInput, type Kit, makeKit } from './test-kit.ts';

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

  it('keeps an existing issuing connection editable for non-issuing fields', async () => {
    const manager = await memberAuthority(['integration_admin']);
    const created = await createDemo(kit, {
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
    });
    await service.update(kit.sctx, kit.actor, created.id, { name: 'Still works' }, manager);
    expect(await getConnection(kit.env.DB, created.id)).toMatchObject({
      name: 'Still works',
      autoCreate: true,
      autoEmail: true,
    });
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
