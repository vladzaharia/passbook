import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { accessTemplate, grantOf, makeZone } from './access-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { admitsJson } from './admits.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

type Lists = { templateIds: string[]; eventIds: string[] };

/** A paired scanner in a session whose stored `accepts` is `accepts` (raw, so legacy and foreign ids can be stored). */
async function door(accepts: string, entries: string[] = [], zoneIds: string[] = []) {
  const scanner = await kit.scanner({ templateIds: entries });
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, accepts, scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  for (const [sort, zoneId] of zoneIds.entries())
    await run(
      kit.env.DB,
      'INSERT INTO scanning_session_zones (session_id, zone_id, sort) VALUES (?, ?, ?)',
      [sessionId, zoneId, sort],
    );
  return { headers: scanner.headers, sessionId };
}
const mixed = (lists: Lists, zoneIds: string[] = []) =>
  door(admitsJson(lists), lists.templateIds, zoneIds);

const eventOf = async (scanId: string | null) =>
  (
    await first<{ event_id: string | null }>(kit.env.DB, 'SELECT event_id FROM scans WHERE id=?', [
      scanId,
    ])
  )?.event_id ?? null;

const template = (name: string) => kit.scanTemplate(name, { actions: [CHECK_IN] });

describe('admits: which entry admits a pass', () => {
  it('admits through an event that takes the pass before a template entry', async () => {
    const tpl = await template('Precedence');
    const event = await kit.event({ templateIds: [tpl] });
    const d = await mixed({ templateIds: [tpl], eventIds: [event.id] });
    const done = await out(await act(d.headers, codeOf(await kit.scanPass(tpl))));
    expect(done).toMatchObject({ kind: 'ok' });
    expect(await eventOf(done.scanId)).toBe(event.id);
  });

  it('falls back to the template entry, zones and all, while the event holding it is closed', async () => {
    const tpl = await accessTemplate(undefined, 'Closed event access');
    const gym = await makeZone('closed-event-gym');
    const now = kit.clock.now();
    const closed = await kit.event({
      templateIds: [tpl],
      opensAt: now - 3 * HOUR,
      closesAt: now - HOUR,
    });
    const open = await kit.event({ templateIds: [tpl] });
    const byClosed = await mixed({ templateIds: [tpl], eventIds: [closed.id] }, [gym]);
    expect(
      await grantOf(byClosed.headers, await kit.scanPass(tpl, { plan: 'pool_only' })),
    ).toMatchObject({
      kind: 'refused',
      reason: 'zone_not_included',
    });
    const byOpen = await mixed({ templateIds: [tpl], eventIds: [open.id] }, [gym]);
    const admitted = await grantOf(byOpen.headers, await kit.scanPass(tpl, { plan: 'pool_only' }));
    expect(admitted).toMatchObject({ kind: 'ok' });
    expect(await eventOf(admitted.scanId)).toBe(open.id);
  });

  it('takes the open event, then the earliest close, of two that take the pass', async () => {
    const tpl = await template('Two events');
    const now = kit.clock.now();
    const later = await kit.event({
      templateIds: [tpl],
      opensAt: now + HOUR,
      closesAt: now + HOUR * 1.5,
    });
    const open = await kit.event({ templateIds: [tpl], closesAt: now + HOUR * 2 });
    const d = await mixed({ templateIds: [], eventIds: [later.id, open.id] });
    const first = await out(await act(d.headers, codeOf(await kit.scanPass(tpl))));
    expect(first).toMatchObject({ kind: 'ok' });
    expect(await eventOf(first.scanId)).toBe(open.id);
    const sooner = await kit.event({ templateIds: [tpl], closesAt: now + HOUR / 2 });
    const both = await mixed({ templateIds: [], eventIds: [open.id, sooner.id] });
    const second = await out(await act(both.headers, codeOf(await kit.scanPass(tpl))));
    expect(await eventOf(second.scanId)).toBe(sooner.id);
  });

  it('admits through a template entry when no event takes the pass, and refuses as before otherwise', async () => {
    const tpl = await template('Entry');
    const eventOnly = await template('Event only');
    const other = await template('Not admitted');
    const event = await kit.event({ templateIds: [eventOnly] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input=?,match_values=? WHERE id=?', [
      'tier',
      JSON.stringify(['gold']),
      event.id,
    ]);
    const d = await mixed({ templateIds: [tpl], eventIds: [event.id] });
    const entry = await out(await act(d.headers, codeOf(await kit.scanPass(tpl))));
    expect(entry).toMatchObject({ kind: 'ok' });
    expect(await eventOf(entry.scanId)).toBeNull();
    const gold = await out(
      await act(d.headers, codeOf(await kit.scanPass(eventOnly, { tier: 'gold' }))),
    );
    expect(await eventOf(gold.scanId)).toBe(event.id);
    expect(
      await out(await act(d.headers, codeOf(await kit.scanPass(eventOnly, { tier: 'silver' })))),
    ).toMatchObject({ kind: 'refused', reason: 'wrong_event' });
    expect(await out(await act(d.headers, codeOf(await kit.scanPass(other))))).toMatchObject({
      kind: 'refused',
      reason: 'not_accepted',
    });
  });

  it('checks zones only for a pass admitted through a template entry', async () => {
    const tpl = await accessTemplate(undefined, 'Admits access');
    const gym = await makeZone('admits-gym');
    const event = await kit.event({ templateIds: [tpl] });
    const byEntry = await mixed({ templateIds: [tpl], eventIds: [] }, [gym]);
    const byEvent = await mixed({ templateIds: [], eventIds: [event.id] }, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'pool_only' });
    expect(await grantOf(byEntry.headers, pass)).toMatchObject({
      kind: 'refused',
      reason: 'zone_not_included',
    });
    const admitted = await grantOf(byEvent.headers, await kit.scanPass(tpl, { plan: 'pool_only' }));
    expect(admitted).toMatchObject({ kind: 'ok' });
    expect(await eventOf(admitted.scanId)).toBe(event.id);
  });

  it('resolves with the event counts and undoes under the entry the scan ran under', async () => {
    const tpl = await template('Resolve undo');
    const entry = await template('Resolve undo entry');
    const event = await kit.event({ templateIds: [tpl] });
    const d = await mixed({ templateIds: [entry], eventIds: [event.id] });
    const pass = await kit.scanPass(tpl);
    const read = await out(
      await kit.post(d.headers, '/resolve', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
      }),
    );
    expect(read).toMatchObject({ kind: 'ready', counts: { event: { arrived: 0 } } });
    const done = await out(await act(d.headers, codeOf(pass)));
    const undone = await kit.post(d.headers, `/scans/${done.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
  });
});

describe('admits: grants made under the narrowed entry', () => {
  it('serves the card assets of an event-admitted pass to the device that read it', async () => {
    const tpl = await template('Asset event');
    const event = await kit.event({ templateIds: [tpl] });
    await run(kit.env.DB, "UPDATE scan_events SET time_zone='Europe/Berlin' WHERE id=?", [
      event.id,
    ]);
    const d = await mixed({ templateIds: [await template('Asset entry')], eventIds: [event.id] });
    const read = await out(
      await kit.post(d.headers, '/resolve', {
        idempotencyKey: key(),
        input: codeOf(await kit.scanPass(tpl)),
        clientTs: kit.clock.now(),
      }),
    );
    const view = read.card?.passView;
    if (!view) throw new Error('Missing card');
    const icon = `${view.assetBaseUrl}icon.png?g=${encodeURIComponent(view.assetGrant)}`;
    const served = await kit.get(d.headers, icon.replace('/api/v1/scan', ''));
    expect(served.status).toBe(200);
    await served.body?.cancel();
  });
});

describe('admits: scope fences', () => {
  it('reads one event stored in the older form or as lists', async () => {
    const tpl = await template('Legacy');
    const event = await kit.event({ templateIds: [tpl] });
    for (const accepts of [
      JSON.stringify({ eventId: event.id }),
      JSON.stringify({ templateIds: [], eventIds: [event.id] }),
    ]) {
      const d = await door(accepts);
      const done = await out(await act(d.headers, codeOf(await kit.scanPass(tpl))));
      expect(await eventOf(done.scanId)).toBe(event.id);
    }
    // A single shape is stored in the older one-key form, which a Worker before Admits reads.
    expect(admitsJson({ templateIds: [], eventIds: [event.id] })).toBe(
      JSON.stringify({ eventId: event.id }),
    );
    expect(admitsJson({ templateIds: [tpl], eventIds: [] })).toBe(
      JSON.stringify({ templateIds: [tpl] }),
    );
  });

  it("never admits through another org's event or template, or an event of the other mode", async () => {
    const tpl = await template('Fenced');
    const other = await makeOrg(kit.fx);
    const foreignTpl = await kit.scanTemplate(
      'Foreign',
      { actions: [CHECK_IN] },
      { orgId: other.id },
    );
    const foreignEvent = await kit.event({ orgId: other.id, templateIds: [foreignTpl] });
    const testEvent = await kit.event({ mode: 'test', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    for (const lists of [
      { templateIds: [tpl], eventIds: [foreignEvent.id] },
      { templateIds: [tpl, foreignTpl], eventIds: [] },
      { templateIds: [tpl], eventIds: [testEvent.id] },
    ]) {
      const d = await mixed(lists);
      expect(await out(await act(d.headers, codeOf(pass)))).toMatchObject({
        kind: 'refused',
        reason: 'not_accepted',
      });
    }
    const foreignPass = await kit.scanPass(foreignTpl, {}, { orgId: other.id });
    const d = await mixed({ templateIds: [tpl], eventIds: [] });
    expect(await out(await act(d.headers, codeOf(foreignPass)))).toMatchObject({ kind: 'refused' });
  });

  it('admits nothing once an admitted event is archived', async () => {
    const tpl = await template('Event drift');
    const entry = await template('Event drift entry');
    const event = await kit.event({ templateIds: [tpl] });
    const d = await mixed({ templateIds: [entry], eventIds: [event.id] });
    await run(kit.env.DB, 'UPDATE scan_events SET archived_at=? WHERE id=?', [
      kit.clock.now(),
      event.id,
    ]);
    expect(await out(await act(d.headers, codeOf(await kit.scanPass(entry))))).toMatchObject({
      kind: 'refused',
      reason: 'not_accepted',
    });
  });

  it('refuses the commit when the admitting event changes after the read', async () => {
    const tpl = await template('Event race');
    const event = await kit.event({ templateIds: [tpl] });
    const second = await kit.event({ templateIds: [await template('Event race other')] });
    const d = await mixed({ templateIds: [], eventIds: [event.id, second.id] });
    const pass = await kit.scanPass(tpl);
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      (db) => run(db, 'UPDATE scan_events SET capacity = 5 WHERE id = ?', [event.id]),
      () => act(d.headers, codeOf(pass)),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
  });
});
