import { beforeEach } from 'vitest';
import {
  type FakeAuth,
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeTemplate,
  makeUser,
  persistTemplate,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
import {
  clearScannerFixtureState,
  scannerAuditActions,
} from './repo-scanners-split-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export const codeOf = async (res: Response) => {
  // The tests assert the error returned by this in-process route.
  const body = (await res.json()) as { code: string };
  return body.code;
};

export let env: AppEnv;
export let f: Fixtures;
export let clock: ManualClock;
export let fake: FakeAuth;
let app: ReturnType<typeof createApp>;
export let orgId: string;
export let templateId: string;
let ipN = 0;
export let userId: string;

export async function persistApprovedTemplate(
  template: TestTemplate,
  modes: readonly ('live' | 'test')[] = ['live', 'test'],
) {
  await persistTemplate(f, template.resolved, { registry: template.registry });
  for (const mode of modes) {
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: template.registry },
      {
        templateId: template.resolved.id,
        orgId: template.resolved.orgId ?? orgId,
        version: template.resolved.version,
        mode,
      },
    );
  }
}

export const setupScannerFixture = () =>
  beforeEach(async () => {
    clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
    env = await makeEnv({ RL_SCAN_PAIR: fakeRateLimiter({ limit: 1000 }) } as never);
    f = fixtures(env, clock);
    fake = fakeAuth(ORIGIN);
    fake.bindSessions(env.DB, clock);
    const stores = { ...fake.stores, scanners: createScannerStore(env, clock) };
    app = createApp({ stores, clock });
    await clearScannerFixtureState(env.DB);
    userId = (await makeUser(f)).id;
    orgId = (await makeOrg(f)).id;
    await grantScanMembership(f, orgId, userId);
    const t = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(t);
    templateId = t.resolved.id;
    ipN++;
  });

export const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
export const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
export const consoleCall = (method: string, path: string, body?: unknown, headers = admin()) =>
  send(method, `/api/v1/scanners${path}`, headers, body);
export const device = (
  agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1 Version/17 Mobile',
) => ({
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'user-agent': agent,
  'cf-connecting-ip': `203.0.${ipN}.9`,
});
export const pairCall = (path: string, code: string, headers = device()) =>
  send('POST', `/api/v1/scan/pair${path}`, headers, { code });

export interface Created {
  id: string;
  status: string;
  mode: string;
  pairing: { code: string; url: string; expiresAt: number } | null;
}
export async function create(over: Record<string, unknown> = {}, headers = admin()) {
  clock.advance(1);
  const res = await consoleCall(
    'POST',
    '',
    {
      orgId,
      name: `Door ${f.ids.token(3)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'Europe/Berlin',
      ...over,
    },
    headers,
  );
  return { res, body: (await res.clone().json()) as Created };
}
export const problem = async (res: Response) => {
  const { requestId: _drop, ...rest } = (await res.json()) as Record<string, unknown>;
  return rest;
};
export const cookieOf = (res: Response) => {
  const raw = res.headers.get('set-cookie') ?? '';
  return { raw, token: /__Host-wallet_scan=([^;]+)/.exec(raw)?.[1] ?? '' };
};
export const auditActions = async () => scannerAuditActions(env.DB);
