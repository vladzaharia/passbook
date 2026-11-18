import { beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeTemplate,
  makeUser,
  persistTemplate,
  TEST_NOW,
} from '../../../../test/helpers/index.ts';
import { ScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;

let env: AppEnv;
let clock: ManualClock;
let call: (method: string, path: string, body?: unknown, mode?: 'test') => Promise<Response>;
let orgA: string;
let orgB: string;
let ids: { zone: string; session: string; event: string; testSession: string };
let foreign: typeof ids;

beforeEach(async () => {
  clock = new ManualClock(TEST_NOW);
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  const f = fixtures(env, clock);
  const fake = fakeAuth(ORIGIN);
  fake.bindSessions(env.DB, clock);
  const app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(env, clock) },
    clock,
  });
  const userId = (await makeUser(f)).id;
  orgA = (await makeOrg(f)).id;
  orgB = (await makeOrg(f)).id;
  await grantScanMembership(f, orgA, userId);
  await grantScanMembership(f, orgB, userId);
  call = (method, path, body, mode) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method,
          headers: {
            ...fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) }),
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      ),
    );
  const id = async (res: Response) => {
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { id: string }).id;
  };
  async function seed(orgId: string, tag: string) {
    const t = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, t.resolved, { registry: t.registry });
    const fixture = { ctx: createServiceContext(env, { clock }), fx: f, registry: t.registry };
    for (const mode of ['live', 'test'] as const)
      await approveAppleRelease(fixture, {
        orgId,
        templateId: t.resolved.id,
        version: t.resolved.version,
        mode,
      });
    return {
      zone: await id(await call('POST', '/scan-zones', { orgId, key: tag, name: `Zone ${tag}` })),
      session: await id(
        await call('POST', '/scanning-sessions', { orgId, name: `S ${tag}`, timeZone: 'UTC' }),
      ),
      testSession: await id(
        await call(
          'POST',
          '/scanning-sessions',
          { orgId, name: `T ${tag}`, timeZone: 'UTC' },
          'test',
        ),
      ),
      event: await id(
        await call('POST', '/scan-events', {
          orgId,
          name: `Event ${tag}`,
          templateIds: [t.resolved.id],
          opensAt: clock.now() - HOUR,
          closesAt: clock.now() + HOUR,
          timeZone: 'UTC',
        }),
      ),
    };
  }
  ids = await seed(orgA, 'a');
  foreign = await seed(orgB, 'b');
});

const make = (deviceRole: 'monitor' | 'customer', watch: unknown) =>
  call('POST', '/scan-setups', {
    orgId: orgA,
    name: `Screen ${Math.random().toString(36).slice(2, 8)}`,
    kind: 'display',
    deviceRole,
    timeZone: 'UTC',
    watch,
  });
const setupCount = async () =>
  (await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM scanner_setups'))?.n ?? 0;

describe('monitor watches by session, event and zone', () => {
  it('saves each kind and reads it back', async () => {
    for (const watch of [
      { sessionIds: [ids.session] },
      { eventId: ids.event },
      { zoneIds: [ids.zone] },
    ]) {
      const made = await make('monitor', watch);
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: string };
      const view = ScannerSetupSchema.parse(await (await call('GET', `/scan-setups/${id}`)).json());
      expect(view.watch).toMatchObject(watch);
    }
  });

  it('moves a saved monitor from one kind to another on update', async () => {
    const { id } = (await (await make('monitor', { zoneIds: [ids.zone] })).json()) as {
      id: string;
    };
    const moved = await call('PATCH', `/scan-setups/${id}`, {
      watch: { scannerIds: [], allOrg: false, sessionIds: [ids.session] },
    });
    expect(moved.status).toBe(200);
    expect(ScannerSetupSchema.parse(await moved.json()).watch).toMatchObject({
      sessionIds: [ids.session],
    });
  });

  it('refuses another org’s zone, session or event, and a test-mode session, writing nothing', async () => {
    const before = await setupCount();
    for (const watch of [
      { zoneIds: [foreign.zone] },
      { zoneIds: [ids.zone, foreign.zone] },
      { sessionIds: [foreign.session] },
      { sessionIds: [ids.testSession] },
      { eventId: foreign.event },
      { eventId: 'no-such-event' },
    ])
      await expectProblem(await make('monitor', watch), 404, 'SCANNER_WATCH_NOT_FOUND');
    expect(await setupCount()).toBe(before);
  });

  it('refuses a foreign id on update and keeps the saved watch', async () => {
    const { id } = (await (await make('monitor', { zoneIds: [ids.zone] })).json()) as {
      id: string;
    };
    await expectProblem(
      await call('PATCH', `/scan-setups/${id}`, { watch: { zoneIds: [foreign.zone] } }),
      404,
      'SCANNER_WATCH_NOT_FOUND',
    );
    const view = ScannerSetupSchema.parse(await (await call('GET', `/scan-setups/${id}`)).json());
    expect(view.watch).toMatchObject({ zoneIds: [ids.zone] });
  });

  it('refuses a watch that names nothing', async () => {
    await expectProblem(
      await make('monitor', { scannerIds: [], allOrg: false }),
      422,
      'SCANNER_WATCH_INVALID',
    );
  });
});

describe('customer screens', () => {
  it('follow sessions, never events, zones or the whole org', async () => {
    expect((await make('customer', { sessionIds: [ids.session] })).status).toBe(201);
    const before = await setupCount();
    for (const watch of [{ eventId: ids.event }, { zoneIds: [ids.zone] }, { allOrg: true }])
      await expectProblem(await make('customer', watch), 422, 'SCANNER_WATCH_INVALID');
    await expectProblem(
      await make('customer', { sessionIds: [foreign.session] }),
      404,
      'SCANNER_WATCH_NOT_FOUND',
    );
    expect(await setupCount()).toBe(before);
  });
});
