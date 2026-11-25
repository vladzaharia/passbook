import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await blueprintKit();
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});
afterAll(() => vi.unstubAllGlobals());

const as = async (options: {
  roles?: ('admin' | 'user' | 'developer')[];
  amr?: 'oidc' | 'magic_link' | 'breakglass';
}) => {
  const user = await makeUser(kit.f);
  return (await makeSession(kit.f, { userId: user.id, ...options })).headers;
};
const send = (method: string, path: string, headers: Record<string, string>) =>
  app.request(
    `${ORIGIN}/api/v1/developer${path}`,
    {
      method,
      headers: { ...headers, ...(headers.cookie ? { origin: ORIGIN } : {}) },
    },
    kit.env,
  );

describe('GET /developer/access', () => {
  it('is yes for the developer role and for platform admins', async () => {
    for (const roles of [
      ['user', 'developer'],
      ['admin', 'user'],
    ] as const) {
      const res = await send('GET', '/access', await as({ roles: [...roles] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ access: 'yes' });
    }
  });

  it('is none for a Polaris ID session without the role', async () => {
    const res = await send('GET', '/access', await as({}));
    expect(await res.json()).toEqual({ access: 'none' });
  });

  it('is email, with where to sign in, for an email-link session', async () => {
    const res = await send('GET', '/access', await as({ amr: 'magic_link', roles: ['user'] }));
    expect(await res.json()).toEqual({
      access: 'email',
      signInUrl: '/auth/oidc/start?next=/developers',
    });
    const dev = await send(
      'GET',
      '/access',
      await as({ amr: 'magic_link', roles: ['user', 'developer'] }),
    );
    expect(((await dev.json()) as { access: string }).access).toBe('email');
  });

  it('needs a session', async () => {
    expect((await send('GET', '/access', {})).status).toBe(401);
  });
});

describe('developer routes need developer access', () => {
  const routes: [string, string][] = [
    ['GET', '/sandbox'],
    ['POST', '/sandbox'],
    ['POST', '/sandbox/close'],
    ['DELETE', '/sandbox'],
    ['POST', '/sandbox/recreate'],
    ['POST', '/try-token'],
    ['DELETE', '/try-token'],
  ];

  it.each(routes)('%s %s refuses a session without the role', async (method, path) => {
    const res = await send(method, path, await as({}));
    await expectProblem(res, 403, 'DEVELOPER_ACCESS_REQUIRED');
    expect(((await res.clone().json()) as { detail?: string }).detail).toBe(
      "You don't have developer access. Ask an administrator.",
    );
  });

  it.each(routes)('%s %s lets the role and platform admins pass', async (method, path) => {
    for (const roles of [
      ['user', 'developer'],
      ['admin', 'user'],
    ] as const) {
      const res = await send(method, path, await as({ roles: [...roles] }));
      expect(res.status, `${method} ${path} ${roles}`).not.toBe(403);
    }
  });
});
