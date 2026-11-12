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
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
import { createEventTenantRaceInterceptors } from './repo-events-tenant-race-interceptors-test-fixtures.ts';
import { createEventTenantRaceQueries } from './repo-events-tenant-race-test-fixtures.ts';
import { grantScanMembership, key, makeLegacyScanPass } from './test-kit.ts';

export function createEventTenantRace() {
  let env: AppEnv;
  let f: Fixtures;
  let clock: ManualClock;
  let app: OpenAPIHono<AppBindings>;
  let orgId: string;
  let templateId: string;
  let secondTemplateId: string;
  let eventId: string;
  let freeScannerId: string;
  let attachedScanner: ScannerFixture;
  let member: SessionFixture;
  let membershipId: string;
  let primaryTemplate: TestTemplate;
  let secondaryTemplate: TestTemplate;
  const { seedScanningSessions, state, withMutableKeyset, withRemovableKeyset } =
    createEventTenantRaceQueries(() => env);

  beforeEach(async () => {
    clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
    env = await makeEnv();
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
        scanners: createScannerStore(env, clock),
      },
      clock,
    });
    orgId = (await makeOrg(f)).id;
    primaryTemplate = makeTemplate({ id: f.ids.id(), orgId });
    secondaryTemplate = makeTemplate({ id: f.ids.id(), orgId });
    const template = primaryTemplate;
    const secondTemplate = secondaryTemplate;
    await persistTemplate(f, template.resolved, { registry: template.registry });
    await persistTemplate(f, secondTemplate.resolved, { registry: secondTemplate.registry });
    const ctx = createServiceContext(env, { clock });
    for (const t of [template, secondTemplate]) {
      await approveAppleRelease(
        { ctx, fx: f, registry: t.registry },
        { orgId, templateId: t.resolved.id, version: t.resolved.version, mode: 'live' },
      );
    }
    templateId = template.resolved.id;
    secondTemplateId = secondTemplate.resolved.id;
    eventId = (await makeScanEvent(f, { orgId, templateIds: [templateId] })).id;
    const attached = await makeScanner(f, { orgId, eventId });
    attachedScanner = attached;
    freeScannerId = (await makeScanner(f, { orgId, templateIds: [templateId] })).id;
    await seedScanningSessions(templateId, attached.id, freeScannerId);
    const user = await makeUser(f);
    membershipId = await grantScanMembership(f, orgId, user.id);
    member = await makeSession(f, { userId: user.id });
  });

  function call(method: string, path: string, body?: unknown) {
    return Promise.resolve(
      app.request(
        `https://wallet.test/api/v1/scan-events${path}`,
        {
          method,
          headers: {
            ...member.headers,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? null : JSON.stringify(body),
        },
        env,
      ),
    );
  }

  async function admittedPass() {
    const pass = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const response = await app.request(
      'https://wallet.test/api/v1/scan/actions',
      {
        method: 'POST',
        headers: { ...attachedScanner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: key(),
          input: { passId: pass.id, method: 'manual' },
          clientTs: clock.now(),
          actionId: 'check_in',
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok' });
    return pass;
  }

  return {
    get env() {
      return env;
    },
    get f() {
      return f;
    },
    get clock() {
      return clock;
    },
    get app() {
      return app;
    },
    get orgId() {
      return orgId;
    },
    get templateId() {
      return templateId;
    },
    get secondTemplateId() {
      return secondTemplateId;
    },
    get eventId() {
      return eventId;
    },
    get freeScannerId() {
      return freeScannerId;
    },
    get attachedScanner() {
      return attachedScanner;
    },
    get member() {
      return member;
    },
    get membershipId() {
      return membershipId;
    },
    get primaryTemplate() {
      return primaryTemplate;
    },
    get secondaryTemplate() {
      return secondaryTemplate;
    },
    call,
    admittedPass,
    state,
    withMutableKeyset,
    withRemovableKeyset,
    ...createEventTenantRaceInterceptors(() => env),
  };
}
