import { beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeTemplate,
  makeUser,
  persistTemplate,
  TEST_NOW,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

interface Setup {
  session: { id: string; name: string };
  created: boolean;
  events: { id: string; name: string; created: boolean }[];
  undated: string[];
}

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;

beforeEach(async () => {
  clock = new ManualClock(TEST_NOW);
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(env.DB, clock);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  await grantScanMembership(f, orgId, userId);
});

async function template(org: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const t: TestTemplate = makeTemplate({ id: f.ids.id(), orgId: org });
  Object.assign(t.resolved.manifest, manifest);
  await persistTemplate(f, t.resolved, { registry: t.registry });
  const fixture = { ctx: createServiceContext(env, { clock }), fx: f, registry: t.registry };
  for (const mode of ['live', 'test'] as const)
    await approveAppleRelease(fixture, {
      orgId: org,
      templateId: t.resolved.id,
      version: t.resolved.version,
      mode,
    });
  return t.resolved.id;
}

const START = '2030-06-01T19:00:00-07:00';
const eventTicket = (extra: Record<string, unknown> = {}) =>
  template(orgId, {
    name: 'Event ticket',
    scan: {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
      window: { from: 'startsAt', until: 'endsAt', earlyMinutes: 180, lateMinutes: 60 },
    },
    sample: {
      eventName: 'Harbour Lights: Night One',
      venueName: 'Sample Hall',
      venueRegion: 'Cupertino, CA',
      venueTimeZone: 'America/Los_Angeles',
      startsAt: START,
      endsAt: '2030-06-01T22:00:00-07:00',
      doorsAt: '2030-06-01T18:00:00-07:00',
    },
    ...extra,
  });

const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const post = (id: string, body: unknown = { orgId }, headers: Record<string, string> = admin()) =>
  app.request(
    `${ORIGIN}/api/v1/templates/${id}/scan-setup`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
const setup = async (id: string, body: unknown = { orgId }, headers = admin()) => {
  const res = await post(id, body, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as Setup;
};
const count = async (table: string) =>
  (
    await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, [orgId])
  )[0]?.n ?? 0;
const audits = async () =>
  (
    await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE org_id = ? AND action IN ('scan.template_setup','scan_event.create','scanning.session_create') ORDER BY id",
      [orgId],
    )
  ).map((r) => r.action);

describe('template scan setup', () => {
  it('makes the event and a session once for an event template', async () => {
    const id = await eventTicket();
    const first = await setup(id, { orgId, timeZone: 'America/Los_Angeles' });
    expect(first.created).toBe(true);
    expect(first.events.map((e) => [e.name, e.created])).toEqual([
      ['Harbour Lights: Night One', true],
    ]);
    expect(first.session.name).toBe('Event ticket');
    const event = (
      await all<{ opens_at: number; closes_at: number; note: string }>(
        env.DB,
        'SELECT opens_at, closes_at, note FROM scan_events WHERE org_id = ?',
        [orgId],
      )
    )[0];
    expect(event).toEqual({
      opens_at: Date.parse('2030-06-01T18:00:00-07:00'),
      closes_at: Date.parse('2030-06-01T22:00:00-07:00') + 60 * 60_000,
      note: 'Sample Hall, Cupertino, CA',
    });
    const session = (await (
      await app.request(
        `${ORIGIN}/api/v1/scanning-sessions/${first.session.id}`,
        { headers: admin() },
        env,
      )
    ).json()) as { accepts: unknown; hours: unknown; timeZone: string; status: string };
    expect(session).toMatchObject({
      status: 'active',
      timeZone: 'America/Los_Angeles',
      accepts: { templateIds: [id], eventIds: [first.events[0]?.id] },
      hours: { sat: ['18:00-23:00'] },
    });
    const again = await setup(id, { orgId, timeZone: 'America/Los_Angeles' });
    expect(again).toEqual({ session: first.session, created: false, events: [], undated: [] });
    expect(await count('scan_events')).toBe(1);
    expect(await count('scanning_sessions')).toBe(1);
    expect(await audits()).toEqual([
      'scan_event.create',
      'scanning.session_create',
      'scan.template_setup',
    ]);
  });

  it('makes one event per upcoming-events entry and flags an undated one', async () => {
    const id = await eventTicket({
      behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcomingEvents' } }],
      sample: {
        eventName: 'Harbour Lights: Night One',
        startsAt: START,
        endsAt: '2030-06-01T22:00:00-07:00',
        upcomingEvents: [
          {
            name: 'Harbour Lights: Night One',
            startsAt: START,
            endsAt: '2030-06-01T22:00:00-07:00',
          },
          { name: 'Harbour Lights: Night Two', startsAt: '2030-06-02T19:00:00-07:00' },
          { name: 'Harbour Lights: Night Three' },
          { name: 'Long gone', startsAt: '2001-01-01T19:00:00Z', endsAt: '2001-01-01T21:00:00Z' },
        ],
      },
    });
    const made = await setup(id);
    expect(made.events.map((e) => e.name)).toEqual([
      'Harbour Lights: Night One',
      'Harbour Lights: Night Two',
    ]);
    expect(made.undated).toEqual(['Harbour Lights: Night Three']);
    expect(await count('scan_events')).toBe(2);
    expect(await count('scanning_sessions')).toBe(1);
  });

  it('makes only a session for a door template, with the template check-in rules', async () => {
    const id = await template(orgId, {
      name: 'Monthly pass',
      scan: {
        actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
        checkIn: { mode: 'daily', days: 30 },
      },
    });
    const made = await setup(id);
    expect(made).toMatchObject({
      created: true,
      events: [],
      undated: [],
      session: { name: 'Monthly pass' },
    });
    expect(await count('scan_events')).toBe(0);
    const session = (await (
      await app.request(
        `${ORIGIN}/api/v1/scanning-sessions/${made.session.id}`,
        { headers: admin() },
        env,
      )
    ).json()) as { accepts: unknown; hours: unknown; settings: { checkIn: unknown } };
    expect(session.accepts).toEqual({ templateIds: [id] });
    expect(session.hours ?? null).toBeNull();
    expect(session.settings.checkIn).toEqual({ mode: 'daily', days: 30 });
  });

  it('returns the session an earlier call or the console already made', async () => {
    const id = await template(orgId, { name: 'Day pass' });
    const manual = await app.request(
      `${ORIGIN}/api/v1/scanning-sessions`,
      {
        method: 'POST',
        headers: { ...admin(), 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId,
          name: 'Front door',
          timeZone: 'UTC',
          accepts: { templateIds: [id] },
        }),
      },
      env,
    );
    const { id: manualId } = (await manual.json()) as { id: string };
    const made = await setup(id);
    expect(made).toEqual({
      session: { id: manualId, name: 'Front door' },
      created: false,
      events: [],
      undated: [],
    });
    expect(await audits()).toEqual(['scanning.session_create']);
  });

  it('makes a new session once the old one has ended', async () => {
    const id = await template(orgId, { name: 'Day pass' });
    const first = await setup(id);
    await app.request(
      `${ORIGIN}/api/v1/scanning-sessions/${first.session.id}`,
      {
        method: 'PATCH',
        headers: { ...admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ended' }),
      },
      env,
    );
    const next = await setup(id);
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(first.session.id);
  });

  it('builds one setup when two calls race', async () => {
    const id = await eventTicket();
    const [a, b] = await Promise.all([post(id), post(id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [x, y] = (await Promise.all([a.json(), b.json()])) as Setup[];
    expect(x?.session.id).toBe(y?.session.id);
    expect([x?.created, y?.created].sort()).toEqual([false, true]);
    expect(await count('scanning_sessions')).toBe(1);
    expect(await count('scan_events')).toBe(1);
    expect(await count('idempotency_keys')).toBe(0);
  });

  it('keeps live and test apart', async () => {
    const id = await template(orgId, { name: 'Day pass' });
    const live = await setup(id);
    const test = await setup(id, { orgId }, admin('test'));
    expect(test.created).toBe(true);
    expect(test.session.id).not.toBe(live.session.id);
    expect((await setup(id)).session.id).toBe(live.session.id);
  });

  it('refuses another organization, its templates and a read-only member', async () => {
    const id = await template(orgId, { name: 'Day pass' });
    const other = await makeOrg(f);
    const stranger = await makeUser(f);
    await grantScanMembership(f, other.id, stranger.id);
    const asStranger = fake.session({ userId: stranger.id, roles: ['user'] });
    await expectProblem(await post(id, { orgId }, asStranger), 403, 'FORBIDDEN');
    await expectProblem(await post(id, { orgId: other.id }, asStranger), 404, 'TEMPLATE_NOT_FOUND');
    const reader = await makeUser(f);
    await grantScanMembership(f, orgId, reader.id, ['read_only']);
    await expectProblem(
      await post(id, { orgId }, fake.session({ userId: reader.id, roles: ['user'] })),
      403,
      'FORBIDDEN',
    );
    expect(await count('scanning_sessions')).toBe(0);
  });

  it('is not open to an API key, scoped or not, or to a signed-out caller', async () => {
    const id = await template(orgId, { name: 'Day pass' });
    for (const scopes of [
      ['scans:read', 'scans:write', 'templates:read'],
      ['passes:read'],
    ] as const)
      expect((await post(id, { orgId }, fake.apiKey({ orgId, scopes: [...scopes] }))).status).toBe(
        401,
      );
    expect((await post(id, { orgId }, {})).status).toBe(401);
    expect(await count('scanning_sessions')).toBe(0);
  });

  it('refuses a blueprint', async () => {
    const id = await template(orgId, { name: 'Starter', blueprint: true });
    await expectProblem(await post(id), 422, 'BLUEPRINT_NOT_SCANNABLE');
  });
});
