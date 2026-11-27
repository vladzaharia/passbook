// Platform-keys PK-6b: what a Platform key may do on the Apple identity routes, who the audit names, and the
// person-only delete (design section 2.3).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { MINTABLE_PLATFORM_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const BASE = '/api/v1/identities';
const GHOST = '0190a000-0000-7000-8000-000000000000';

let appEnv: AppEnv;
let fx: Fixtures;
let app: ReturnType<typeof createApp>;
let admin: SessionFixture;
let n = 0;

async function pem(label: string) {
  n += 1;
  const f = await createFixtureIdentity(
    { passTypeIdentifier: `pass.com.pk6b.t${n}`, teamIdentifier: 'PKSIX12345' },
    { now: new Date(fx.clock.now()) },
  );
  appEnv = await makeEnv({ SIGNER_PLATFORM_INTERMEDIATE: f.intermediate, KEK_V1 });
  return { label, certificatePem: f.certificate, privateKeyPem: f.privateKey, f };
}

const call = (
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: unknown,
  e: AppEnv = appEnv,
) =>
  app.request(
    `${BASE}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(fx, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: fx.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
}

beforeAll(async () => {
  appEnv = await makeEnv();
  fx = fixtures(appEnv);
  admin = await makeSession(fx, { userId: (await makeUser(fx)).id, roles: ['admin', 'user'] });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(appEnv, fx.clock),
      apiKeys: createApiKeyStore(appEnv, fx.clock),
    },
    clock: fx.clock,
  });
}, 30_000);

describe('a Platform key on the identity routes', () => {
  it('uploads, lists, reads, edits and rotates, audited as the key', async () => {
    const key = await platformKey(['platform:identities']);
    const up = await pem('Key made');
    const { f, ...body } = up;
    const made = await call('', key.headers, 'POST', body);
    expect(made.status, await made.clone().text()).toBe(201);
    const dto = (await made.json()) as { id: string };
    const listed = await call('', key.headers);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      dto.id,
    );
    expect((await call(`/${dto.id}`, key.headers)).status).toBe(200);
    const patched = await call(`/${dto.id}`, key.headers, 'PATCH', { label: 'Renamed' });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ label: 'Renamed' });
    const renewed = await createFixtureIdentity(f.identity, {
      now: new Date(fx.clock.now()),
      days: 5,
    });
    appEnv = await makeEnv({ SIGNER_PLATFORM_INTERMEDIATE: renewed.intermediate, KEK_V1 });
    const rotated = await call(`/${dto.id}/rotate`, key.headers, 'POST', {
      certificatePem: renewed.certificate,
      privateKeyPem: renewed.privateKey,
    });
    expect(rotated.status).toBe(200);
    const rows = await all<{ action: string; actor_type: string; actor_id: string }>(
      env.DB,
      "SELECT action, actor_type, actor_id FROM audit_log WHERE target_id = ? AND action LIKE 'identity.%'",
      [dto.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.actor_type === 'api_key' && r.actor_id === key.id)).toBe(true);
  });

  it('reads with platform:read, and refuses a write without platform:identities', async () => {
    const reader = await platformKey(['platform:read']);
    expect((await call('', reader.headers)).status).toBe(200);
    const writes: [string, string, unknown?][] = [
      ['', 'POST', { label: 'x', certificatePem: 'x', privateKeyPem: 'x' }],
      [`/${GHOST}`, 'PATCH', { label: 'x' }],
      [`/${GHOST}/rotate`, 'POST', {}],
      [`/${GHOST}/apns-check`, 'POST'],
      [`/${GHOST}/renew`, 'POST'],
      [`/${GHOST}/push-key`, 'PUT', { keyId: 'ABC1234567', p8: 'x' }],
      [`/${GHOST}/push-key`, 'DELETE'],
    ];
    for (const [path, method, body] of writes)
      await expectProblem(await call(path, reader.headers, method, body), 403, 'MISSING_SCOPE');
  });

  it('refuses a key of another scope on every route', async () => {
    const other = await platformKey(['platform:groups']);
    await expectProblem(await call('', other.headers), 403, 'MISSING_SCOPE');
    await expectProblem(await call(`/${GHOST}`, other.headers), 403, 'MISSING_SCOPE');
    await expectProblem(await call(`/${GHOST}/renew`, other.headers, 'POST'), 403, 'MISSING_SCOPE');
  });

  it('reaches the handler on the routes it may call: an unknown identity is a 404', async () => {
    const key = await platformKey(['platform:identities']);
    const routes: [string, string, unknown?][] = [
      [`/${GHOST}`, 'GET'],
      [`/${GHOST}`, 'PATCH', { label: 'x' }],
      [`/${GHOST}/rotate`, 'POST', { certificatePem: 'x', privateKeyPem: 'x' }],
      [`/${GHOST}/apns-check`, 'POST'],
      [`/${GHOST}/renew`, 'POST'],
      [`/${GHOST}/push-key`, 'PUT', { keyId: 'ABC1234567', p8: 'x' }],
      [`/${GHOST}/push-key`, 'DELETE'],
    ];
    for (const [path, method, body] of routes)
      expect((await call(path, key.headers, method, body)).status, `${method} ${path}`).toBe(404);
  });

  it('refuses an org key: the list, the reads and the writes', async () => {
    const org = await makeOrg(fx);
    const orgKey = await makeApiKey(fx, { orgId: org.id, scopes: ['passes:read'] });
    await expectProblem(await call('', orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
    await expectProblem(await call(`/${GHOST}`, orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
    await expectProblem(
      await call(`/${GHOST}/renew`, orgKey.headers, 'POST'),
      403,
      'PLATFORM_KEY_REQUIRED',
    );
    // An org's own list stays a member's: a key is not one.
    expect([401, 403]).toContain((await call(`?orgId=${org.id}`, orgKey.headers)).status);
  });

  it('refuses a Platform key the org list, which is a member read', async () => {
    const key = await platformKey([...MINTABLE_PLATFORM_SCOPES]);
    const org = await makeOrg(fx);
    expect([401, 403]).toContain((await call(`?orgId=${org.id}`, key.headers)).status);
  });

  it('keeps the delete person-only: a key holding every platform scope gets PERSON_REQUIRED', async () => {
    const up = await pem('Keep me');
    const { f: _f, ...body } = up;
    const made = await call('', admin.headers, 'POST', body);
    expect(made.status, await made.clone().text()).toBe(201);
    const dto = (await made.json()) as { id: string };
    const key = await platformKey([...MINTABLE_PLATFORM_SCOPES]);
    await expectProblem(await call(`/${dto.id}`, key.headers, 'DELETE'), 403, 'PERSON_REQUIRED');
    expect(
      await first(env.DB, 'SELECT 1 AS x FROM signing_identities WHERE id = ?', [dto.id]),
    ).not.toBeNull();
  });
});

describe('the platform default identity', () => {
  it("is a person's to choose: a key gets PERSON_REQUIRED on isDefault, and may patch the rest", async () => {
    const { f: _f, ...body } = await pem('Default?');
    const made = await call('', admin.headers, 'POST', body);
    const dto = (await made.json()) as { id: string };
    const key = await platformKey([...MINTABLE_PLATFORM_SCOPES]);
    const defaults = () =>
      all<{ id: string }>(env.DB, 'SELECT id FROM signing_identities WHERE is_default = 1');
    const before = await defaults();
    for (const patch of [
      { isDefault: true },
      { isDefault: false },
      { label: 'x', isDefault: true },
    ])
      await expectProblem(
        await call(`/${dto.id}`, key.headers, 'PATCH', patch),
        403,
        'PERSON_REQUIRED',
      );
    expect(await defaults()).toEqual(before);
    const ok = await call(`/${dto.id}`, key.headers, 'PATCH', { label: 'Still ours' });
    expect(ok.status).toBe(200);
    // The service refuses a key too, should a route ever forward one.
    const { updateIdentity } = await import('./service.ts');
    const { createServiceContext } = await import('../../platform/service-context.ts');
    await expect(
      updateIdentity(createServiceContext(appEnv), { type: 'api_key', id: key.id }, dto.id, {
        isDefault: true,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_REQUIRED' });
  });

  it('a person still chooses it', async () => {
    const { f: _f, ...body } = await pem('Person default');
    const dto = (await (await call('', admin.headers, 'POST', body)).json()) as { id: string };
    const res = await call(`/${dto.id}`, admin.headers, 'PATCH', { isDefault: true });
    expect([200, 409, 422]).toContain(res.status);
    expect(res.status === 403).toBe(false);
  });
});

describe('a person on the identity routes', () => {
  it('still lists, uploads and reads', async () => {
    const { f: _f, ...body } = await pem('By person');
    const made = await call('', admin.headers, 'POST', body);
    expect(made.status, await made.clone().text()).toBe(201);
    const dto = (await made.json()) as { id: string };
    expect((await call('', admin.headers)).status).toBe(200);
    expect((await call(`/${dto.id}`, admin.headers)).status).toBe(200);
    const member = await makeSession(fx, { userId: (await makeUser(fx)).id });
    await expectProblem(await call('', member.headers), 403, 'FORBIDDEN');
  });
});
