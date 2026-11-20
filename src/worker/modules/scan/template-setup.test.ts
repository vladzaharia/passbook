import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import type { TemplateScanSetup } from '../../../shared/contracts/scan-template-setup.ts';
import { all, first, run } from '../../platform/db.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { ownEventValues } from './repo-template-setup.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import type { EventSource } from './template-setup-plan.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const HOUR = 3_600_000;
const CHECK_IN = { id: 'enter', label: 'Let in', kind: 'check_in' } as const;
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
      truncated: false,
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

  // Before: no key reached this route (scanning had no key scope), so any key was 401. Now a key with
  // `scanning:write` may call it (template-setup-key.test.ts); a key without it is still refused,
  // as 403 MISSING_SCOPE, and a signed-out caller is still 401.
  it('is not open to a key without scanning:write, or to a signed-out caller', async () => {
    const { kit } = fixture;
    const id = await kit.scanTemplate('Keyed', {
      actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    });
    for (const scopes of [
      ['scans:read', 'scans:write', 'templates:read'],
      ['passes:read'],
    ] as const)
      await expectProblem(
        await post(id, {}, fixture.fake.apiKey({ orgId: kit.org.id, scopes: [...scopes] })),
        403,
        'MISSING_SCOPE',
      );
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

  it('finds the setup session by its key when it was edited, and puts the template back', async () => {
    const id = await eventTemplate(fixture.kit, 'Edited ticket');
    const other = await fixture.kit.scanTemplate('Other pass', { actions: [CHECK_IN] });
    const made = await setup(id);
    const patch = (accepts: unknown) =>
      fixture.call('PATCH', `/scanning-sessions/${made.session.id}`, { accepts });
    expect((await patch({ templateIds: [other] })).status).toBe(200);
    await ticket(id, { eventName: 'After the edit' });
    const again = await setup(id);
    expect(again).toMatchObject({ created: false, session: made.session });
    expect(again.events.map((e) => e.name)).toEqual(['After the edit']);
    const [session] = await sessions(id);
    expect(JSON.parse(session?.accepts ?? '').templateIds.sort()).toEqual([id, other].sort());
    // A session set to admit every pass type already scans these passes; it is left as it is.
    expect((await patch(null)).status).toBe(200);
    expect(await setup(id)).toMatchObject({ created: false, events: [], session: made.session });
    expect(await sessions(id)).toHaveLength(1);
  });

  it('lets an ended setup session be reopened', async () => {
    const id = await fixture.kit.scanTemplate('Reopen pass', { actions: [CHECK_IN] });
    const first = await setup(id);
    const status = (sessionId: string, value: string) =>
      fixture.call('PATCH', `/scanning-sessions/${sessionId}`, { status: value });
    expect((await status(first.session.id, 'ended')).status).toBe(200);
    expect(await sessions(id)).toHaveLength(0);
    const next = await setup(id);
    expect(next.created).toBe(true);
    expect((await status(first.session.id, 'active')).status).toBe(200);
    expect(await setup(id)).toMatchObject({ created: false, session: next.session });
  });

  it('skips a list entry that is not an event', async () => {
    const id = await eventTemplate(fixture.kit, 'Messy list', {
      behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcomingEvents' } }],
    });
    const pass = await fixture.kit.scanPass(id, {});
    // The behavior refuses such a list at issue; stored data from elsewhere can still hold one.
    await run(fixture.kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({
        memberName: 'Anna',
        upcomingEvents: ['Show A', 7, null, { name: 'Real one', startsAt: iso(now() + 3 * HOUR) }],
      }),
      pass.id,
    ]);
    expect((await setup(id)).events.map((e) => e.name)).toEqual(['Real one']);
  });

  it('takes the soonest events and says when more were left out', async () => {
    const id = await eventTemplate(fixture.kit, 'Long season', {
      behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcomingEvents' } }],
    });
    await fixture.kit.scanPass(id, {
      upcomingEvents: Array.from({ length: 12 }, (_, i) => ({
        name: `Night ${String(i + 1).padStart(2, '0')}`,
        startsAt: iso(now() + (12 - i) * 24 * HOUR),
      })),
    });
    const made = await setup(id);
    expect(made.truncated).toBe(true);
    expect(made.events.map((e) => e.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Night ${String(12 - i).padStart(2, '0')}`),
    );
  });

  it('matches each timed slot on its slot key, not on the name they share', async () => {
    const id = await eventTemplate(fixture.kit, 'Slots');
    await ticket(id, {
      eventName: 'Ocean Light',
      slotKey: 'ocean-a',
      startsAt: iso(now() + 2 * HOUR),
      endsAt: iso(now() + 3 * HOUR),
    });
    await ticket(id, {
      eventName: 'Ocean Light',
      slotKey: 'ocean-b',
      startsAt: iso(now() + 5 * HOUR),
      endsAt: iso(now() + 6 * HOUR),
    });
    const made = await setup(id);
    expect(made.events).toHaveLength(2);
    const matches = await rows<{ i: string; v: string }>(
      'SELECT match_input AS i, match_values AS v FROM scan_events WHERE org_id = ? AND setup_key LIKE ? ORDER BY opens_at',
      fixture.kit.org.id,
      `${id}|%`,
    );
    expect(matches).toEqual([
      { i: 'slotKey', v: '["ocean-a"]' },
      { i: 'slotKey', v: '["ocean-b"]' },
    ]);
  });

  it('merges two repeat calls that add events at once, and archives what a failed call made', async () => {
    const id = await eventTemplate(fixture.kit, 'Repeat ticket');
    await ticket(id, { eventName: 'Night One' });
    const first = await setup(id);
    await ticket(id, {
      eventName: 'Night Two',
      startsAt: iso(now() + 24 * HOUR),
      endsAt: iso(now() + 26 * HOUR),
    });
    const [a, b] = await Promise.all([post(id), post(id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [session] = await sessions(id);
    expect(JSON.parse(session?.accepts ?? '').eventIds).toHaveLength(2);
    expect(session?.id).toBe(first.session.id);

    await ticket(id, {
      eventName: 'Night Three',
      startsAt: iso(now() + 48 * HOUR),
      endsAt: iso(now() + 50 * HOUR),
    });
    const db = fixture.kit.env.DB;
    await run(
      db,
      "CREATE TRIGGER setup_fail BEFORE UPDATE OF accepts ON scanning_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      expect((await post(id)).status).toBe(500);
    } finally {
      await run(db, 'DROP TRIGGER setup_fail');
    }
    const live = await rows<{ name: string }>(
      'SELECT name FROM scan_events WHERE org_id = ? AND archived_at IS NULL AND name = ?',
      fixture.kit.org.id,
      'Night Three',
    );
    expect(live).toEqual([]);
    expect((await setup(id)).events.map((e) => e.name)).toEqual(['Night Three']);
  });

  it("archives the events a lost race made past the winner's room of ten", async () => {
    const id = await eventTemplate(fixture.kit, 'Crowded ticket');
    for (const [n, name] of ['Crowd One', 'Crowd Two', 'Crowd Three'].entries())
      await ticket(id, {
        eventName: name,
        startsAt: iso(now() + n * 24 * HOUR),
        endsAt: iso(now() + n * 24 * HOUR + 2 * HOUR),
      });
    const db = fixture.kit.env.DB;
    const eventIds: string[] = [];
    for (let n = 0; n < 9; n++) eventIds.push((await fixture.kit.event({ templateIds: [id] })).id);
    const accepts = JSON.stringify({ templateIds: [id], eventIds });
    const settings = JSON.stringify(DEFAULT_SETTINGS);
    // The third event's insert lands a competing setup session that already admits nine events.
    await run(
      db,
      `CREATE TRIGGER setup_race AFTER INSERT ON scan_events WHEN NEW.name = 'Crowd Three'
       BEGIN
         INSERT INTO scanning_sessions (id, org_id, mode, name, status, accepts, settings, time_zone,
           created_at, updated_at, setup_template_id)
         VALUES ('race-winner', NEW.org_id, NEW.mode, 'Winner', 'active', '${accepts}', '${settings}', 'UTC', 1, 1, '${id}');
       END`,
    );
    let made: TemplateScanSetup;
    try {
      const res = await post(id);
      if (res.status !== 200) throw new Error(await res.text());
      made = (await res.json()) as TemplateScanSetup;
    } finally {
      await run(db, 'DROP TRIGGER setup_race');
    }
    expect(made.session.id).toBe('race-winner');
    expect(made.events.map((e) => e.name)).toEqual(['Crowd One']);
    const live = await rows<{ name: string }>(
      "SELECT name FROM scan_events WHERE org_id = ? AND archived_at IS NULL AND name LIKE 'Crowd%'",
      fixture.kit.org.id,
    );
    expect(live.map((e) => e.name)).toEqual(['Crowd One']);
  });

  it('logs a start value that is not a date, and skips its event', async () => {
    const id = await eventTemplate(fixture.kit, 'Loose ticket');
    const pass = await ticket(id, { eventName: 'Sometime' });
    await run(
      fixture.kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.startsAt', 'next Friday evening') WHERE id = ?",
      [pass.id],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const made = await setup(id);
      expect(made).toMatchObject({ events: [], noEvents: true });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('START_NOT_ISO'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the newest passes only, and says when older ones were left out', async () => {
    const id = await eventTemplate(fixture.kit, 'Huge ticket');
    await ticket(id, { eventName: 'Oldest night' });
    // Pass ids follow time: a later pass sorts after an earlier one.
    const same = { startsAt: iso(now() + HOUR), endsAt: iso(now() + 2 * HOUR) };
    fixture.kit.clock.advance(5);
    await ticket(id, { eventName: 'Busy night', ...same });
    fixture.kit.clock.advance(5);
    await ticket(id, { eventName: 'Busy night', ...same });
    const own = { name: 'eventName', start: 'startsAt' } as NonNullable<EventSource['own']>;
    const read = (limit: number) =>
      ownEventValues(fixture.kit.env.DB, fixture.kit.org.id, 'live', id, own, 0, limit);
    const bounded = await read(2);
    expect(bounded.more).toBe(true);
    expect(bounded.values.map((v) => v.name)).toEqual(['Busy night']);
    const all3 = await read(3);
    expect(all3.more).toBe(false);
    expect(all3.values.map((v) => v.name).sort()).toEqual(['Busy night', 'Oldest night']);
  });

  it('does not archive an event another session attached while this call failed', async () => {
    const id = await eventTemplate(fixture.kit, 'Shared ticket');
    await ticket(id, { eventName: 'Shared One' });
    const first = await setup(id);
    await ticket(id, {
      eventName: 'Shared Two',
      startsAt: iso(now() + 24 * HOUR),
      endsAt: iso(now() + 26 * HOUR),
    });
    const db = fixture.kit.env.DB;
    const settings = JSON.stringify(DEFAULT_SETTINGS);
    // Another call's session takes the new event the moment it exists; this call's own update then fails.
    await run(
      db,
      `CREATE TRIGGER setup_take AFTER INSERT ON scan_events WHEN NEW.name = 'Shared Two'
       BEGIN
         INSERT INTO scanning_sessions (id, org_id, mode, name, status, accepts, settings, time_zone, created_at, updated_at)
         VALUES ('takes-event', NEW.org_id, NEW.mode, 'Other', 'active',
           json_object('templateIds', json_array(), 'eventIds', json_array(NEW.id)), '${settings}', 'UTC', 1, 1);
       END`,
    );
    await run(
      db,
      `CREATE TRIGGER setup_fail2 BEFORE UPDATE OF accepts ON scanning_sessions WHEN OLD.id = '${first.session.id}'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      expect((await post(id)).status).toBe(500);
    } finally {
      await run(db, 'DROP TRIGGER setup_take');
      await run(db, 'DROP TRIGGER setup_fail2');
    }
    const live = await rows<{ id: string }>(
      "SELECT id FROM scan_events WHERE org_id = ? AND archived_at IS NULL AND name = 'Shared Two'",
      fixture.kit.org.id,
    );
    expect(live).toHaveLength(1);
    const [other] = await rows<{ accepts: string }>(
      "SELECT accepts FROM scanning_sessions WHERE id = 'takes-event'",
    );
    expect(JSON.parse(other?.accepts ?? '{}').eventIds).toEqual([live[0]?.id]);
  });
});
