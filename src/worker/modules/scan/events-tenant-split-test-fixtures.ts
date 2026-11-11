import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, expect } from 'vitest';
import {
  type Fixtures,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
  type ScannerFixture,
  type SessionFixture,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { pageOf, ScanEventSchema } from '../../../shared/contracts/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { seedScannerSessions } from './repo-events-tenant-split-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
export const HOUR = 3_600_000;
export let env: AppEnv;
export let f: Fixtures;
export let clock: ManualClock;
export let app: OpenAPIHono<AppBindings>;
export let orgId: string;
export let otherOrgId: string;
export let templateId: string;
export let primaryTemplate: TestTemplate;
export let secondTemplateId: string;
export let eventId: string;
export let otherEventId: string;
export let attachedScannerId: string;
export let attachedScanner: ScannerFixture;
export let freeScannerId: string;
export let member: SessionFixture;
export let admin: SessionFixture;
export let reader: SessionFixture;
export let operator: SessionFixture;
export let unrelatedRole: SessionFixture;

async function account(roles: OrgRole[] | null, platformAdmin = false) {
  const user = await makeUser(f);
  if (roles) await grantScanMembership(f, orgId, user.id, roles);
  return makeSession(f, {
    userId: user.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
}

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  Object.assign(env, {
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 100_000 }),
  });
  f = fixtures(env, clock);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(env, clock),
      apiKeys: createApiKeyStore(env, clock),
      scanners: createScannerStore(env, clock),
    },
    clock,
  });
  orgId = (await makeOrg(f)).id;
  otherOrgId = (await makeOrg(f)).id;
  const template = makeTemplate({ id: f.ids.id(), orgId });
  primaryTemplate = template;
  const secondTemplate = makeTemplate({ id: f.ids.id(), orgId });
  await persistTemplate(f, template.resolved, { registry: template.registry });
  await persistTemplate(f, secondTemplate.resolved, { registry: secondTemplate.registry });
  const ctx = createServiceContext(env, { clock });
  for (const mode of ['live', 'test'] as const) {
    await approveAppleRelease(
      { ctx, fx: f, registry: template.registry },
      { orgId, templateId: template.resolved.id, version: template.resolved.version, mode },
    );
  }
  await approveAppleRelease(
    { ctx, fx: f, registry: secondTemplate.registry },
    {
      orgId,
      templateId: secondTemplate.resolved.id,
      version: secondTemplate.resolved.version,
      mode: 'live',
    },
  );
  templateId = template.resolved.id;
  secondTemplateId = secondTemplate.resolved.id;
  eventId = (await makeScanEvent(f, { orgId, templateIds: [templateId] })).id;
  otherEventId = (await makeScanEvent(f, { orgId: otherOrgId })).id;
  attachedScanner = await makeScanner(f, { orgId, eventId });
  attachedScannerId = attachedScanner.id;
  freeScannerId = (await makeScanner(f, { orgId, templateIds: [templateId] })).id;
  await seedScannerSessions(env.DB, templateId, attachedScannerId, freeScannerId);
  member = await account(['org_admin']);
  admin = await account(null, true);
  reader = await account(['read_only']);
  operator = await account(['pass_operator']);
  unrelatedRole = await account(['template_author']);
});

export function call(
  session: Pick<SessionFixture, 'headers'>,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(
    `${ORIGIN}/api/v1/scan-events${path}`,
    {
      method,
      headers: {
        ...session.headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
}

export async function recordedCheckIn(passId: string, scanner = attachedScanner) {
  const response = await app.request(
    `${ORIGIN}/api/v1/scan/actions`,
    {
      method: 'POST',
      headers: { ...scanner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: key(),
        input: { passId, method: 'manual' },
        clientTs: clock.now(),
        actionId: 'check_in',
      }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as { kind: string; scanId: string | null };
  expect(outcome.kind).toBe('ok');
  expect(outcome.scanId).toEqual(expect.any(String));
  if (!outcome.scanId) throw new Error('Missing successful check-in.');
  return outcome.scanId;
}

export function input(org = orgId) {
  return {
    orgId: org,
    name: 'New event',
    templateIds: [templateId],
    opensAt: clock.now() - HOUR,
    closesAt: clock.now() + HOUR,
    timeZone: 'UTC',
  };
}

export async function page(response: Response) {
  expect(response.status).toBe(200);
  return pageOf(ScanEventSchema).parse(await response.json());
}
