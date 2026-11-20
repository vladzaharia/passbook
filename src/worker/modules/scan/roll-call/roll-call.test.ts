import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../../test/helpers/index.ts';
import { all, run } from '../../../platform/db.ts';
import { AppError } from '../../../platform/errors.ts';
import { createJobContext } from '../../../platform/service-context.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import { autoTapOut } from '../occupancy/jobs.ts';
import {
  DISPLAY_TPL,
  personInside,
  station,
  trackedZone,
  useKit,
} from '../occupancy/whos-in-test-fixtures.ts';
import { current, end, mark, read, start } from './roll-call-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

describe('roll call: freeze and scope', () => {
  it('freezes the session list, and nobody drops when they leave mid-call', async () => {
    const pool = await trackedZone();
    const ana = await personInside(tpl, 'Ana Reyes', [`zone:${pool.id}`], {
      at: kit.clock.now() - 5000,
    });
    const ben = await personInside(tpl, 'Ben Okoro', [`zone:${pool.id}`], {
      at: kit.clock.now() - 2000,
    });
    const s = await station([tpl], [pool.id]);
    const { status, body } = await start(s);
    expect(status).toBe(200);
    expect(body.people.map((p) => p.holder)).toEqual(['Ana Reyes', 'Ben Okoro']);
    expect(body.counts).toMatchObject({ total: 2, unconfirmed: 2, present: 0, late: 0 });
    await run(kit.env.DB, "UPDATE scan_presence SET state = 'out' WHERE pass_id = ?", [ana.id]);
    const after = await read(s, body.id);
    expect(after.people).toHaveLength(2);
    expect(after.people.find((p) => p.passId === ana.id)).toMatchObject({ presence: 'left' });
    expect(after.people.find((p) => p.passId === ben.id)).toMatchObject({ presence: 'in' });
  });

  it('starting twice joins the open call; each session has its own', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Solo', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const b = await station([tpl], [pool.id]);
    const first = await start(a);
    expect((await start(a)).body.id).toBe(first.body.id);
    const other = await start(b);
    expect(other.body.id).not.toBe(first.body.id);
    expect(await current(a)).toMatchObject({ id: first.body.id });
  });

  it('keeps the tenant, mode and session: another session cannot read, mark or end it', async () => {
    const pool = await trackedZone();
    const other = await trackedZone();
    const p = await personInside(tpl, 'Private Person', [`zone:${pool.id}`]);
    await personInside(tpl, 'Test Mode', [`zone:${pool.id}`], { mode: 'test' });
    const a = await station([tpl], [pool.id]);
    const b = await station([tpl], [other.id]);
    const call = (await start(a)).body;
    expect(JSON.stringify(call)).not.toContain('Test Mode');
    expect(call.people).toHaveLength(1);
    expect(await current(b)).toBeNull();
    const peek = await kit.get(b.headers, `/roll-call/${call.id}`);
    expect(peek.status).toBe(404);
    expect(await peek.text()).not.toContain('Private Person');
    expect((await mark(b, call.id, [{ passId: p.id, status: 'present' }])).status).toBe(404);
    expect((await end(b, call.id)).status).toBe(404);
    expect((await read(a, call.id)).endedAt).toBeNull();
  });

  it('refuses a Door role and a customer screen, and names nobody', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Hidden', [`zone:${pool.id}`]);
    for (const opts of [{ role: 'door' as const }, { deviceRole: 'customer' as const }]) {
      const s = await station([tpl], [pool.id], opts);
      const res = await kit.post(s.headers, '/roll-call', {});
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('Hidden');
    }
  });

  it('has nothing to call when no place is tracked', async () => {
    const s = await station([tpl], []);
    const res = await kit.post(s.headers, '/roll-call', {});
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('ROLL_CALL_NO_PLACES');
  });
});

describe('roll call: confirmations', () => {
  it('two devices racing on one person: the later mark by time wins whatever order they arrive in', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Race', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    // The later mark (out at t) reaches the server first; the earlier one (present at t - 1000) arrives after.
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t }]);
    const late = await mark(a, call.id, [{ passId: p.id, status: 'present', at: t - 1000 }]);
    expect(late.body.people[0]?.mark).toMatchObject({ status: 'out', at: t });
    const rows = await all(
      kit.env.DB,
      'SELECT status FROM roll_call_marks WHERE roll_call_id = ?',
      [call.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('merges an offline queue by time and counts each person once', async () => {
    const pool = await trackedZone();
    const x = await personInside(tpl, 'X', [`zone:${pool.id}`]);
    const y = await personInside(tpl, 'Y', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    const res = await mark(a, call.id, [
      { passId: x.id, status: 'present', at: t - 3000 },
      { passId: y.id, status: 'present', at: t - 2000 },
      { passId: x.id, status: 'none', at: t - 1000 },
    ]);
    expect(res.body.counts).toMatchObject({ present: 1, unconfirmed: 1, total: 2 });
    expect(res.body.rev).toBeGreaterThan(0);
  });

  it('adds a person who taps in after the start as late, and keeps them when they leave', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Early', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const l = await personInside(tpl, 'Latecomer', [`zone:${pool.id}`]);
    const seen = await read(a, call.id);
    expect(seen.counts.late).toBe(1);
    expect(seen.people.find((p) => p.passId === l.id)).toMatchObject({ late: true });
    await mark(a, call.id, [{ passId: l.id, status: 'present' }]);
    await run(kit.env.DB, "UPDATE scan_presence SET state = 'out' WHERE pass_id = ?", [l.id]);
    const kept = await read(a, call.id);
    expect(kept.people.find((p) => p.passId === l.id)).toMatchObject({
      late: true,
      mark: { status: 'present' },
    });
  });

  it('refuses a mark for someone who is not on the call', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Listed', [`zone:${pool.id}`]);
    const stranger = await personInside(tpl, 'Elsewhere', [`zone:${(await trackedZone()).id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const res = await mark(a, call.id, [{ passId: stranger.id, status: 'present' }]);
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ status: 'refused', code: 'ROLL_CALL_NOT_LISTED' }]);
    expect(res.body.counts.present).toBe(0);
  });

  it('refuses marks after the call ended, and ending twice answers with the record', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Done', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const ended = await end(a, call.id);
    expect(ended.body.endedAt).not.toBeNull();
    expect((await end(a, call.id)).body.endedAt).toBe(ended.body.endedAt);
    const res = await mark(a, call.id, [{ passId: p.id, status: 'present' }]);
    expect(res.status).toBe(409);
    expect(await current(a)).toBeNull();
    const next = await start(a);
    expect(next.body.id).not.toBe(call.id);
  });
});

describe('roll call: mark time and call identity', () => {
  it('refuses a mark queued for an earlier call, and writes none of that request', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Stale', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const first = (await start(a)).body;
    await end(a, first.id);
    const second = (await start(a)).body;
    const res = await kit.post(a.headers, `/roll-call/${second.id}/marks`, {
      marks: [{ rollCallId: first.id, passId: p.id, status: 'present' }],
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(((await res.json()) as { results: unknown }).results)).toContain(
      'ROLL_CALL_MARK_MISMATCH',
    );
    expect((await read(a, second.id)).counts.present).toBe(0);
  });

  it('a fast device clock cannot place its mark after the server: it counts as received now', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Fast', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const now = kit.clock.now();
    const res = await mark(a, call.id, [{ passId: p.id, status: 'present', at: now + 3_600_000 }]);
    expect(res.body.people[0]?.mark?.at).toBe(now);
    expect(res.body.serverNow).toBe(now);
    // A later, honest Out from another desk still beats it.
    kit.clock.advance(1000);
    const out = await mark(a, call.id, [{ passId: p.id, status: 'out', at: kit.clock.now() }]);
    expect(out.body.people[0]?.mark?.status).toBe('out');
  });
});

describe('roll call: one refused mark does not fail the batch', () => {
  it('applies the good marks around a refused take-back, a stranger and a stale call id', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const gone = await personInside(tpl, 'Scanned Again', [place], {
      at: kit.clock.now() - 60_000,
    });
    const ok1 = await personInside(tpl, 'Fine One', [place]);
    const ok2 = await personInside(tpl, 'Fine Two', [place]);
    const stranger = await personInside(tpl, 'Not Here', [`zone:${(await trackedZone()).id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    kit.clock.advance(3_600_000);
    const t = kit.clock.now();
    await mark(a, call.id, [{ passId: gone.id, status: 'out', at: t - 9000 }]);
    await run(
      kit.env.DB,
      "UPDATE scan_presence SET state = 'in', last_scan_id = 'door-tap' WHERE pass_id = ?",
      [gone.id],
    );
    const res = await kit.post(a.headers, `/roll-call/${call.id}/marks`, {
      marks: [
        { rollCallId: call.id, passId: ok1.id, status: 'present', at: t - 5000 },
        { rollCallId: call.id, passId: gone.id, status: 'none', at: t - 4000 },
        { rollCallId: call.id, passId: stranger.id, status: 'present', at: t - 3000 },
        { rollCallId: 'an-earlier-call', passId: ok2.id, status: 'present', at: t - 2000 },
        { rollCallId: call.id, passId: ok2.id, status: 'present', at: t - 1000 },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { passId: string; status: string; code?: string }[];
    };
    const by = (id: string) =>
      body.results.filter((r) => r.passId === id).map((r) => r.code ?? r.status);
    expect(by(ok1.id)).toEqual(['applied']);
    expect(by(gone.id)).toEqual(['ROLL_CALL_SCANNED_SINCE']);
    expect(by(stranger.id)).toEqual(['ROLL_CALL_NOT_LISTED']);
    expect(by(ok2.id).sort()).toEqual(['ROLL_CALL_MARK_MISMATCH', 'applied']);
    const after = await read(a, call.id);
    expect(after.counts.present).toBe(2);
    expect(after.people.find((p) => p.passId === gone.id)?.mark?.status).toBe('out');
  });
});

describe('roll call: what counts as a refused mark', () => {
  it('only mark-level refusals are refused per mark; capacity, auth and server errors fail the request', async () => {
    const { isMarkRefusal } = await import('./marks.ts');
    for (const code of [
      'UNDO_SUPERSEDED',
      'SCAN_UNDO_FORBIDDEN',
      'SCAN_UNDO_EXPIRED',
      'SCAN_NOT_FOUND',
      'NOT_INSIDE',
    ])
      expect(isMarkRefusal(new AppError(code, 409, 'x')), code).toBe(true);
    for (const [code, status] of [
      ['SCAN_TOO_MANY_OVERRIDES', 429],
      ['SCANNER_REVOKED', 403],
      ['INTERNAL', 500],
      ['SCAN_CONFIG_CHANGED', 409],
    ] as const)
      expect(isMarkRefusal(new AppError(code, status, 'x')), code).toBe(false);
    expect(isMarkRefusal(new Error('boom'))).toBe(false);
  });

  it('roll call Outs do not count toward the desk override cap', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const people = [];
    for (let i = 0; i < 3; i++) people.push(await personInside(tpl, `Evac ${i}`, [place]));
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    await mark(
      a,
      call.id,
      people.map((p, i) => ({ passId: p.id, status: 'out' as const, at: t - 3000 + i })),
    );
    const rows = await all(kit.env.DB, "SELECT 1 FROM counters WHERE key LIKE 'scan:ovr:%'");
    expect(rows).toHaveLength(0);
    for (const p of people)
      expect(
        (
          await all<{ state: string }>(
            kit.env.DB,
            'SELECT state FROM scan_presence WHERE pass_id = ?',
            [p.id],
          )
        )[0]?.state,
      ).toBe('out');
  });
});

describe('roll call: an Out where nothing is tracked', () => {
  it('is recorded as a confirmation alone and reported, when the zone left the session', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Untracked', [place]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    await run(kit.env.DB, 'DELETE FROM scanning_session_zones WHERE session_id = ?', [a.sessionId]);
    const res = await mark(a, call.id, [
      { passId: p.id, status: 'out', at: kit.clock.now() - 1000 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { status: 'applied', code: 'ROLL_CALL_OUT_NOT_TRACKED' },
    ]);
    const [m] = await all<{ status: string; exit_scan_id: string | null }>(
      kit.env.DB,
      'SELECT status, exit_scan_id FROM roll_call_marks WHERE pass_id = ?',
      [p.id],
    );
    expect(m).toMatchObject({ status: 'out', exit_scan_id: null });
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.state,
    ).toBe('in');
  });
});

describe('roll call: Out exits the person', () => {
  const state = async (passId: string) =>
    (
      await all<{ state: string }>(
        kit.env.DB,
        'SELECT state FROM scan_presence WHERE pass_id = ?',
        [passId],
      )
    )[0]?.state;

  it('exits their presence like Mark as out, and taking the mark back undoes the exit', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Leaver', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    kit.clock.advance(3_600_000);
    const t = kit.clock.now();
    const out = await mark(a, call.id, [{ passId: p.id, status: 'out', at: t - 3000 }]);
    expect(out.status).toBe(200);
    expect(await state(p.id)).toBe('out');
    const rows = await all<{ exit_scan_id: string | null }>(
      kit.env.DB,
      'SELECT exit_scan_id FROM roll_call_marks WHERE pass_id = ?',
      [p.id],
    );
    expect(rows[0]?.exit_scan_id).toBeTruthy();
    // The same Out again does not exit twice.
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t - 2000 }]);
    expect(await state(p.id)).toBe('out');
    await mark(a, call.id, [{ passId: p.id, status: 'none', at: t - 1000 }]);
    expect(await state(p.id)).toBe('in');
    expect(
      (
        await all<{ exit_scan_id: string | null }>(
          kit.env.DB,
          'SELECT exit_scan_id FROM roll_call_marks WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.exit_scan_id,
    ).toBeNull();
  });

  it('take-back restores entered_at, and the exit is a real undone scan', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const entered = kit.clock.now() - 90 * 60_000;
    const p = await personInside(tpl, 'Keeps Clock', [place], { at: entered });
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    kit.clock.advance(3_600_000);
    const t = kit.clock.now();
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t - 3000 }]);
    const [row] = await all<{ exit_scan_id: string }>(
      kit.env.DB,
      'SELECT exit_scan_id FROM roll_call_marks WHERE pass_id = ?',
      [p.id],
    );
    const [exit] = await all<{ out_cause: string; undone_by: string | null }>(
      kit.env.DB,
      'SELECT out_cause, undone_by FROM scans WHERE id = ?',
      [row?.exit_scan_id],
    );
    expect(exit).toMatchObject({ out_cause: 'desk', undone_by: null });
    await mark(a, call.id, [{ passId: p.id, status: 'none', at: t - 1000 }]);
    const [back] = await all<{ state: string; entered_at: number }>(
      kit.env.DB,
      'SELECT state, entered_at FROM scan_presence WHERE pass_id = ?',
      [p.id],
    );
    expect(back).toMatchObject({ state: 'in', entered_at: entered });
    const [undone] = await all<{ undone_by: string | null }>(
      kit.env.DB,
      'SELECT undone_by FROM scans WHERE id = ?',
      [row?.exit_scan_id],
    );
    expect(undone?.undone_by).toBeTruthy();
    const ledger = await all(
      kit.env.DB,
      "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.undone'",
      [p.id],
    );
    expect(ledger).toHaveLength(1);
  });

  it('take-back after a later door scan is refused and the Out stays', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Scanned Since', [place], { at: kit.clock.now() - 60_000 });
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    kit.clock.advance(3_600_000);
    const t = kit.clock.now();
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t - 3000 }]);
    // The door tapped them in again: the exit is no longer their last scan.
    await run(
      kit.env.DB,
      "UPDATE scan_presence SET state = 'in', last_scan_id = 'door-tap', entered_at = ? WHERE pass_id = ?",
      [t - 500, p.id],
    );
    const res = await mark(a, call.id, [{ passId: p.id, status: 'none', at: t - 1000 }]);
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { status: 'refused', code: 'ROLL_CALL_SCANNED_SINCE' },
    ]);
    const [m] = await all<{ status: string }>(
      kit.env.DB,
      'SELECT status FROM roll_call_marks WHERE pass_id = ?',
      [p.id],
    );
    expect(m?.status).toBe('out');
    expect(
      (
        await all<{ last_scan_id: string }>(
          kit.env.DB,
          'SELECT last_scan_id FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.last_scan_id,
    ).toBe('door-tap');
  });

  it('an Out for someone already out is a confirmation alone, with no exit to take back', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Already Out', [place]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    await run(kit.env.DB, "UPDATE scan_presence SET state = 'out' WHERE pass_id = ?", [p.id]);
    const res = await mark(a, call.id, [
      { passId: p.id, status: 'out', at: kit.clock.now() - 1000 },
    ]);
    expect(res.status).toBe(200);
    const [m] = await all<{ status: string; exit_scan_id: string | null }>(
      kit.env.DB,
      'SELECT status, exit_scan_id FROM roll_call_marks WHERE pass_id = ?',
      [p.id],
    );
    expect(m).toMatchObject({ status: 'out', exit_scan_id: null });
  });

  it('Safe leaves presence alone, and an older Out that loses the race exits no one', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Stays', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    await mark(a, call.id, [{ passId: p.id, status: 'present', at: t }]);
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t - 5000 }]);
    expect(await state(p.id)).toBe('in');
  });
});

describe('roll call: max stay hold', () => {
  it('holds the stay exit while the call is open, lists the person as not confirmed out, and exits after', async () => {
    const pool = await trackedZone({ maxStayMinutes: 60 });
    const place = `zone:${pool.id}`;
    const now = kit.clock.now();
    const p = await personInside(tpl, 'Long Stay', [place], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    expect(call.people[0]?.presence).toBe('in');
    kit.clock.advance(35 * 60_000);
    await autoTapOut(jobCtx());
    const held = await read(a, call.id);
    // Past its due time and still listed, flagged for the desk: nobody confirmed the exit.
    expect(held.people[0]).toMatchObject({ presence: 'lapsed', notConfirmedOut: true });
    expect(held.counts.notConfirmedOut).toBe(1);
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.state,
    ).toBe('in');
    await mark(a, call.id, [{ passId: p.id, status: 'out' }]);
    expect((await read(a, call.id)).people[0]).toMatchObject({ notConfirmedOut: false });
    await end(a, call.id);
    await autoTapOut(jobCtx());
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.state,
    ).toBe('out');
    expect((await read(a, call.id)).people[0]).toMatchObject({ presence: 'lapsed' });
  });

  it('held rows are left out of the due query, so 250 of them never starve another org', async () => {
    const places = [];
    for (let i = 0; i < 250; i++) places.push(`zone:z${i}`);
    for (const place of places)
      await run(
        kit.env.DB,
        `INSERT OR IGNORE INTO scan_zones (id, org_id, key, name, time_zone, occupancy, max_stay_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'UTC', 'track', 60, 1, 1)`,
        [place.slice(5), kit.org.id, place.slice(5), place],
      );
    const now = kit.clock.now();
    const big = await personInside(tpl, 'Held Many', places, {
      at: now - 120 * 60_000,
      dueAt: now - 60_000,
    });
    await run(
      kit.env.DB,
      `INSERT INTO roll_calls (id, org_id, mode, scope_key, places, snapshot, started_by, started_at)
       VALUES (?, ?, 'live', 'held-many', ?, '[]', 'Desk', ?)`,
      [
        kit.fx.ids.id(),
        kit.org.id,
        JSON.stringify(places.map((place) => ({ place, name: place, basis: 'tapped_in' }))),
        now - 1000,
      ],
    );
    const other = await makeOrg(kit.fx);
    const zone = await trackedZone({ maxStayMinutes: 60, orgId: other.id });
    const otherTpl = await kit.scanTemplate('Gym other', DISPLAY_TPL as never, { orgId: other.id });
    const due = await personInside(otherTpl, 'Due Elsewhere', [`zone:${zone.id}`], {
      orgId: other.id,
      at: now - 120 * 60_000,
      dueAt: now - 60_000,
    });
    await autoTapOut(jobCtx());
    const states = (id: string) =>
      all<{ state: string }>(kit.env.DB, 'SELECT state FROM scan_presence WHERE pass_id = ?', [id]);
    expect((await states(due.id))[0]?.state).toBe('out');
    expect((await states(big.id)).every((r) => r.state === 'in')).toBe(true);
  });

  it('does not hold exits for another org or place, or once the call is stale', async () => {
    const held = await trackedZone({ maxStayMinutes: 60 });
    const free = await trackedZone({ maxStayMinutes: 60 });
    const now = kit.clock.now();
    await personInside(tpl, 'Held', [`zone:${held.id}`], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const loose = await personInside(tpl, 'Loose', [`zone:${free.id}`], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const a = await station([tpl], [held.id]);
    await start(a);
    kit.clock.advance(35 * 60_000);
    await autoTapOut(jobCtx());
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [loose.id],
        )
      )[0]?.state,
    ).toBe('out');
  });
});

const jobCtx = () => createJobContext(kit.env, 'test', { clock: kit.clock });
