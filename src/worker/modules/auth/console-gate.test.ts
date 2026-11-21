import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { createSessionStore } from './sessions.ts';

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

type R = 'admin' | 'user' | 'developer' | 'console';
const get = async (
  path: string,
  roles: R[],
  options: { amr?: 'oidc' | 'magic_link' | 'breakglass' } = {},
) => {
  const { headers } = await makeSession(kit.f, {
    userId: (await makeUser(kit.f)).id,
    roles,
    ...options,
  });
  return app.request(`${ORIGIN}/api/v1${path}`, { headers }, kit.env);
};
const codeOf = async (res: Response) => ((await res.clone().json()) as { code?: string }).code;
const withGate = async (value: string | undefined, run: () => Promise<void>) => {
  const env = kit.env as unknown as Record<string, string | undefined>;
  const saved = env.OIDC_CONSOLE_GROUP_REQUIRED;
  env.OIDC_CONSOLE_GROUP_REQUIRED = value;
  try {
    await run();
  } finally {
    env.OIDC_CONSOLE_GROUP_REQUIRED = saved;
  }
};

describe('OIDC_CONSOLE_GROUP_REQUIRED', () => {
  it('on: an org console route needs the admin group or platform admin', async () => {
    await withGate('true', async () => {
      await expectProblem(await get('/templates', ['user']), 403, 'CONSOLE_ACCESS_REQUIRED');
      await expectProblem(
        await get('/templates', ['user', 'developer']),
        403,
        'CONSOLE_ACCESS_REQUIRED',
      );
      for (const roles of [
        ['user', 'console'],
        ['admin', 'user'],
      ] as const) {
        const res = await get('/templates', [...roles]);
        expect((await res.clone().json()) as { code?: string }).not.toMatchObject({
          code: 'CONSOLE_ACCESS_REQUIRED',
        });
      }
    });
  });

  it('on: members, invitations, audit, metrics and the scan admin views need it too', async () => {
    const org = (await makeOrg(kit.f)).id;
    await withGate('true', async () => {
      for (const path of [
        `/orgs/${org}/memberships`,
        `/orgs/${org}/invitations`,
        `/audit?orgId=${org}`,
        `/metrics/overview?orgId=${org}`,
        '/scan/session',
      ]) {
        const { headers } = await makeSession(kit.f, {
          userId: (await makeUser(kit.f)).id,
          roles: ['user'],
        });
        const res = await app.request(
          `${ORIGIN}/api/v1${path}`,
          { headers: { ...headers, 'x-passbook-scan-admin': '1' } },
          kit.env,
        );
        expect(await codeOf(res), path).toBe('CONSOLE_ACCESS_REQUIRED');
      }
    });
  });

  it('on: an email-link session keeps the grace rules, never cut off by the flag', async () => {
    await withGate('true', async () => {
      expect(await codeOf(await get('/templates', ['user'], { amr: 'magic_link' }))).not.toBe(
        'CONSOLE_ACCESS_REQUIRED',
      );
    });
  });

  it('on: holder routes stay open to a session without the group', async () => {
    await withGate('true', async () => {
      expect((await get('/me/passes', ['user'])).status).toBe(200);
    });
  });

  it('off or unset: behaviour is unchanged', async () => {
    for (const value of ['false', undefined, '']) {
      await withGate(value, async () => {
        const res = await get('/templates', ['user']);
        expect((await res.clone().json()) as { code?: string }).not.toMatchObject({
          code: 'CONSOLE_ACCESS_REQUIRED',
        });
      });
    }
  });
});
