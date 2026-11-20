import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import type { TemplateScanSetup } from '../../../shared/contracts/scan-template-setup.ts';
import { all, first, run } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const post = (id: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  fixture.call(
    'POST',
    `/templates/${id}/scan-setup`,
    { orgId: fixture.kit.org.id, timeZone: 'UTC', ...body },
    headers,
  );
const setup = async (id: string, headers?: Record<string, string>) => {
  const res = await post(id, {}, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as TemplateScanSetup;
};
const now = () => fixture.kit.clock.now();
/** A ticket for an event that is on now. */
const ticket = (id: string, over: Record<string, unknown> = {}, mode: 'live' | 'test' = 'live') =>
  fixture.kit.scanPass(
    id,
    {
      eventName: 'Harbour Lights',
      startsAt: iso(now() - HOUR / 6),
      endsAt: iso(now() + HOUR),
      ...over,
    },
    { mode },
  );
const rows = <T>(sql: string, ...params: (string | number)[]) =>
  all<T>(fixture.kit.env.DB, sql, params);
const sessions = (id: string) =>
  rows<{ id: string; accepts: string; hours: string | null; status: string }>(
    'SELECT id, accepts, hours, status FROM scanning_sessions WHERE org_id = ? AND setup_template_id = ?',
    fixture.kit.org.id,
    id,
  );
const eventNames = (org = fixture.kit.org.id) =>
  rows<{ name: string; opens_at: number; closes_at: number; note: string | null }>(
    'SELECT name, opens_at, closes_at, note FROM scan_events WHERE org_id = ? AND archived_at IS NULL ORDER BY opens_at',
    org,
  );

describe('template scan setup', () => {
  it('makes the events issued passes name, and one session, once', async () => {
    const id = await eventTemplate(fixture.kit, 'Event ticket');
    await ticket(id, { venueName: 'Sample Hall', venueRegion: 'Cupertino, CA' });
    await ticket(id, { memberName: 'Second holder' });
    const before =
      (await first<{ n: number }>(fixture.kit.env.DB, 'SELECT MAX(id) AS n FROM audit_log'))?.n ??
      0;
    const made = await setup(id);
    expect(made).toMatchObject({ created: true, noEvents: false });
    expect(made.events.map((e) => [e.name, e.created])).toEqual([['Harbour Lights', true]]);
    const [event] = (await eventNames()).filter((e) => e.name === 'Harbour Lights');
    expect(
      await first(
        fixture.kit.env.DB,
        'SELECT match_input AS i, match_values AS v FROM scan_events WHERE id = ?',
        [made.events[0]?.id ?? ''],
      ),
    ).toEqual({ i: 'eventName', v: '["Harbour Lights"]' });
    expect(event).toMatchObject({
      opens_at: now() - HOUR / 6 - HOUR / 2,
      closes_at: now() + HOUR + HOUR / 2,
      note: 'Sample Hall, Cupertino, CA',
    });
    const [session] = await sessions(id);
    expect(JSON.parse(session?.accepts ?? '')).toEqual({
      templateIds: [id],
      eventIds: [made.events[0]?.id],
    });
    expect(session?.hours).toBeNull();
    expect(await setup(id)).toEqual({
      session: made.session,
      created: false,
      events: [],
      noEvents: false,
    });
    expect(await sessions(id)).toHaveLength(1);
    const audits = await rows<{ action: string }>(
      "SELECT action FROM audit_log WHERE id > ? AND org_id = ? AND action IN ('scan.template_setup','scan_event.create','scanning.session_create') ORDER BY id",
      before,
      fixture.kit.org.id,
    );
    expect(audits.map((a) => a.action)).toEqual(['scan_event.create', 'scan.template_setup']);
  });

  it('never reads the sample: no event, no hours, and a real pass scans outside the sample slot', async () => {
    const id = await eventTemplate(fixture.kit, 'Timed ticket');
    const made = await setup(id);
    expect(made).toMatchObject({ created: true, events: [], noEvents: true });
    expect((await eventNames()).map((e) => e.name)).not.toContain('Ocean Light');
    const [session] = await sessions(id);
    expect(session?.hours).toBeNull();
    expect(JSON.parse(session?.accepts ?? '')).toEqual({ templateIds: [id] });

    const slot = await ticket(id, { eventName: 'Late slot' });
    const dev = await fixture.device(made.session.id, 'Timed door');
    const headers = await fixture.pair(dev.pairing?.code ?? '');
    const res = await fixture.kit.post(headers, '/actions', {
      idempotencyKey: key(),
      input: { code: slot.scanCode ?? '', method: 'camera' },
      clientTs: now(),
      actionId: 'auto',
    });
    expect(((await res.json()) as { kind: string }).kind).toBe('ok');

    // Passes issued since add their event to the same session on the next call.
    const next = await setup(id);
    expect(next).toMatchObject({ created: false, noEvents: false });
    expect(next.events.map((e) => [e.name, e.created])).toEqual([['Late slot', true]]);
    expect(next.session).toEqual(made.session);
    // A pass for an event nobody named yet still gets in: the template stays a pass type of the session.
    const unlisted = await ticket(id, { eventName: 'Unlisted', memberName: 'Unlisted guest' });
    const again = await fixture.kit.post(headers, '/actions', {
      idempotencyKey: key(),
      input: { code: unlisted.scanCode ?? '', method: 'camera' },
      clientTs: now(),
      actionId: 'auto',
    });
    expect(((await again.json()) as { kind: string }).kind).toBe('ok');
    expect(await sessions(id)).toHaveLength(1);
  });

  it('adds an event a later pass names to the existing session', async () => {
    const id = await eventTemplate(fixture.kit, 'Season ticket');
    await ticket(id, { eventName: 'Night One' });
    const first = await setup(id);
    await ticket(id, {
      eventName: 'Night Two',
      startsAt: iso(now() + 24 * HOUR),
      endsAt: iso(now() + 27 * HOUR),
    });
    const second = await setup(id);
    expect(second).toMatchObject({ created: false, session: first.session });
    expect(second.events.map((e) => e.name)).toEqual(['Night Two']);
    const [session] = await sessions(id);
    expect(JSON.parse(session?.accepts ?? '').eventIds).toHaveLength(2);
    expect(await setup(id)).toMatchObject({ created: false, events: [] });
  });

  it('makes one event per entry of an upcoming-events list, skips past ones, and cleans the text', async () => {
    const id = await eventTemplate(fixture.kit, 'Season pass', {
      behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcomingEvents' } }],
    });
    await fixture.kit.scanPass(id, {
      upcomingEvents: [
        { name: 'Opener', startsAt: iso(now() + 2 * HOUR), endsAt: iso(now() + 4 * HOUR) },
        { name: 'Finale\n‮txt', startsAt: iso(now() + 48 * HOUR) },
        { name: 'Opener', startsAt: iso(now() + 2 * HOUR), endsAt: iso(now() + 4 * HOUR) },
        { name: 'Long gone', startsAt: iso(now() - 48 * HOUR), endsAt: iso(now() - 40 * HOUR) },
        { name: 'No date yet' },
      ],
    });
    const made = await setup(id);
    expect(made.events.map((e) => e.name)).toEqual(['Opener', 'Finale txt']);
  });

  it('ignores passes of the other mode and passes that are not issued', async () => {
    const id = await eventTemplate(fixture.kit, 'Mode ticket');
    await ticket(id, { eventName: 'Test only' }, 'test');
    expect((await setup(id)).events).toEqual([]);
    const test = await setup(id, fixture.fake.admin({ mode: 'test' }));
    expect(test.events.map((e) => e.name)).toEqual(['Test only']);
    expect(test.session.id).not.toBe((await setup(id)).session.id);
  });

  it('makes only a session for a door template, with the template check-in rules', async () => {
    const id = await fixture.kit.scanTemplate('Monthly pass', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
      checkIn: { mode: 'daily', days: 30 },
    });
    const made = await setup(id);
    expect(made).toMatchObject({
      created: true,
      events: [],
      noEvents: false,
      session: { name: 'Monthly pass' },
    });
    const detail = (await (
      await fixture.call('GET', `/scanning-sessions/${made.session.id}`)
    ).json()) as {
      accepts: unknown;
      settings: { checkIn: unknown };
    };
    expect(detail.accepts).toEqual({ templateIds: [id] });
    expect(detail.settings.checkIn).toEqual({ mode: 'daily', days: 30 });
  });

  it('reuses a paused session and a session made in the console, and starts a new one after End', async () => {
    const id = await fixture.kit.scanTemplate('Day pass', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    });
    const first = await setup(id);
    const patch = (sessionId: string, status: string) =>
      fixture.call('PATCH', `/scanning-sessions/${sessionId}`, { status });
    expect((await patch(first.session.id, 'paused')).status).toBe(200);
    expect(await setup(id)).toMatchObject({ created: false, session: first.session });
    expect((await patch(first.session.id, 'ended')).status).toBe(200);
    const next = await setup(id);
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(first.session.id);

    const other = await fixture.kit.scanTemplate('Guest pass', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    });
    const manual = await fixture.call('POST', '/scanning-sessions', {
      orgId: fixture.kit.org.id,
      name: 'Front door',
      timeZone: 'UTC',
      accepts: { templateIds: [other] },
    });
    const { id: manualId } = (await manual.json()) as { id: string };
    expect(await setup(other)).toMatchObject({ created: false, session: { id: manualId } });
  });

  it('builds one session and one event when two calls race', async () => {
    const id = await eventTemplate(fixture.kit, 'Race ticket');
    await ticket(id, { eventName: 'Race night' });
    const [a, b] = await Promise.all([post(id), post(id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [x, y] = (await Promise.all([a.json(), b.json()])) as TemplateScanSetup[];
    expect(x?.session.id).toBe(y?.session.id);
    expect([x?.created, y?.created].sort()).toEqual([false, true]);
    expect(await sessions(id)).toHaveLength(1);
    expect((await eventNames()).filter((e) => e.name === 'Race night')).toHaveLength(1);
    const [session] = await sessions(id);
    expect(JSON.parse(session?.accepts ?? '').eventIds).toHaveLength(1);
  });

  it('refuses another organization, its templates and a read-only member', async () => {
    const { kit } = fixture;
    const id = await kit.scanTemplate('Isolated', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    });
    const other = await makeOrg(kit.fx);
    const stranger = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, other.id, stranger.id);
    const asStranger = fixture.fake.session({ userId: stranger.id, roles: ['user'] });
    await expectProblem(await post(id, {}, asStranger), 403, 'FORBIDDEN');
    await expectProblem(await post(id, { orgId: other.id }, asStranger), 404, 'TEMPLATE_NOT_FOUND');
    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    await expectProblem(
      await post(id, {}, fixture.fake.session({ userId: reader.id, roles: ['user'] })),
      403,
      'FORBIDDEN',
    );
    expect(await sessions(id)).toHaveLength(0);
  });

  it('is not open to an API key, scoped or not, or to a signed-out caller', async () => {
    const { kit } = fixture;
    const id = await kit.scanTemplate('Keyed', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    });
    for (const scopes of [
      ['scans:read', 'scans:write', 'templates:read'],
      ['passes:read'],
    ] as const)
      expect(
        (await post(id, {}, fixture.fake.apiKey({ orgId: kit.org.id, scopes: [...scopes] })))
          .status,
      ).toBe(401);
    expect((await post(id, {}, {})).status).toBe(401);
    expect(await sessions(id)).toHaveLength(0);
  });

  it('refuses a blueprint and a template with no release', async () => {
    const { kit } = fixture;
    const scan = { actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' as const }] };
    const bp = await kit.scanTemplate('Starter', scan);
    await run(kit.env.DB, 'UPDATE templates SET blueprint = 1 WHERE id = ?', [bp]);
    await expectProblem(await post(bp), 422, 'BLUEPRINT_NOT_SCANNABLE');
    const draft = await kit.scanTemplate('Draft', scan);
    await run(kit.env.DB, 'UPDATE templates SET active_version = NULL WHERE id = ?', [draft]);
    await expectProblem(await post(draft), 409, 'TEMPLATE_NOT_RELEASED');
  });
});
