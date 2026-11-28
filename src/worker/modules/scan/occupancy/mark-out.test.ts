import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../../platform/db.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import { beforeBatch } from '../batch-interceptor-test-support.ts';
import { RACE_PRESENCE_WRITE } from '../race-tags.ts';
import { key } from '../test-kit.ts';
import {
  DISPLAY_TPL,
  personInside,
  presenceOf,
  station,
  trackedZone,
  useKit,
} from './whos-in-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

const markOut = (
  h: Record<string, string>,
  passId: string,
  place: string,
  over: Record<string, unknown> = {},
) => kit.post(h, '/mark-out', { idempotencyKey: key(), passId, place, ...over });

describe('mark as out', () => {
  it('closes the row, records an exit scan with out_cause desk, audits it and bumps the revision', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Forgot Out', [place], { at: kit.clock.now() - 3_600_000 });
    const s = await station([tpl], [pool.id]);
    const res = await markOut(s.headers, p.id, place);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      scanId: string;
      occupancy: { stayMs: number; state: string; inNow: number };
    };
    expect(body).toMatchObject({
      kind: 'ok',
      occupancy: { state: 'out', stayMs: 3_600_000, inNow: 0 },
    });
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
    const scan = await all<{
      direction: string;
      out_cause: string;
      outcome: string;
      actor_key: string;
    }>(kit.env.DB, 'SELECT direction, out_cause, outcome, actor_key FROM scans WHERE id = ?', [
      body.scanId,
    ]);
    expect(scan).toEqual([
      { direction: 'out', out_cause: 'desk', outcome: 'ok', actor_key: `s:${s.scanner.id}` },
    ]);
    const audit = await all<{ action: string; target_id: string }>(
      kit.env.DB,
      "SELECT action, target_id FROM audit_log WHERE action = 'scan.mark_out' AND target_id = ?",
      [p.id],
    );
    expect(audit).toHaveLength(1);
    const rev = await all<{ rev: number }>(
      kit.env.DB,
      'SELECT rev FROM scan_place_revs WHERE place = ?',
      [place],
    );
    expect(rev[0]?.rev).toBe(1);
  });

  it('replays a repeated key and answers NOT_INSIDE to a second request', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Twice', [place]);
    const s = await station([tpl], [pool.id]);
    const k = key();
    const first = await kit.post(s.headers, '/mark-out', {
      idempotencyKey: k,
      passId: p.id,
      place,
    });
    const again = await kit.post(s.headers, '/mark-out', {
      idempotencyKey: k,
      passId: p.id,
      place,
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      replay: true,
      scanId: ((await first.json()) as { scanId: string }).scanId,
    });
    const other = await markOut(s.headers, p.id, place);
    expect(other.status).toBe(409);
    expect(await other.text()).toContain('NOT_INSIDE');
  });

  it('is allowed while the session is paused', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Paused', [place]);
    const s = await station([tpl], [pool.id], { status: 'paused' });
    expect((await markOut(s.headers, p.id, place)).status).toBe(200);
  });

  it('refuses a Door role, a customer screen and a monitor without Desk actions', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Stays In', [place]);
    for (const opts of [
      { role: 'door' },
      { deviceRole: 'customer' },
      { deviceRole: 'monitor' },
    ] as const) {
      const s = await station([tpl], [pool.id], opts);
      expect((await markOut(s.headers, p.id, place)).status, JSON.stringify(opts)).toBe(403);
    }
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
  });

  it('lets a monitor with Desk actions mark out', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'By Monitor', [place]);
    const s = await station([tpl], [pool.id], {
      deviceRole: 'monitor',
      deskActions: true,
      signedIn: true,
    });
    expect((await markOut(s.headers, p.id, place)).status).toBe(200);
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
  });

  it('answers a place outside the session, or a foreign pass, like an unknown one', async () => {
    const pool = await trackedZone();
    const other = await trackedZone();
    const p = await personInside(tpl, 'Elsewhere', [`zone:${other.id}`]);
    const s = await station([tpl], [pool.id]);
    const outside = await markOut(s.headers, p.id, `zone:${other.id}`);
    const unknown = await markOut(s.headers, 'no-such-pass', `zone:${pool.id}`);
    expect(outside.status).toBe(422);
    expect(unknown.status).toBe(422);
    const shape = async (res: Response) => {
      const { code, detail, title } = (await res.json()) as Record<string, unknown>;
      return { code, detail, title };
    };
    expect(await shape(outside)).toEqual(await shape(unknown));
    expect((await presenceOf(p.id, `zone:${other.id}`))[0]?.state).toBe('in');
  });

  it('stops at 120 an hour with 429 and audits the cap once', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Capped', [place]);
    const s = await station([tpl], [pool.id]);
    const now = kit.clock.now();
    await run(kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 120)', [
      `scan:ovr:s:${s.scanner.id}`,
      now - (now % 3_600_000),
    ]);
    for (let i = 0; i < 2; i++) {
      const res = await markOut(s.headers, p.id, place);
      expect(res.status).toBe(429);
      expect(await res.text()).toContain('SCAN_TOO_MANY_OVERRIDES');
    }
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
    const audits = await all<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'scan.overrides_capped' AND actor_id = ?",
      [s.scanner.id],
    );
    expect(audits[0]?.n).toBe(1);
  });

  it('exits the places below it too', async () => {
    const gym = await trackedZone();
    const pool = await trackedZone({ parentId: gym.id });
    const p = await personInside(tpl, 'Both', [`zone:${gym.id}`, `zone:${pool.id}`]);
    const s = await station([tpl], [gym.id]);
    expect((await markOut(s.headers, p.id, `zone:${gym.id}`)).status).toBe(200);
    expect((await presenceOf(p.id, `zone:${pool.id}`))[0]?.state).toBe('out');
  });
});

describe('staff routes on a monitor', () => {
  it('admit a monitor with Desk actions and refuse one without', async () => {
    const pool = await trackedZone();
    const on = await station([tpl], [pool.id], {
      deviceRole: 'monitor',
      deskActions: true,
      staffSignIn: true,
    });
    const off = await station([tpl], [pool.id], { deviceRole: 'monitor', staffSignIn: true });
    expect((await kit.get(on.headers, '/staff?q=a')).status).toBe(200);
    const refused = await kit.get(off.headers, '/staff?q=a');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('SCREEN_ONLY');
  });
});

describe('mark as out: races, keys and the ledger', () => {
  it('leaves a new stay alone when the person tapped out and in before it landed', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Back In', [place]);
    const s = await station([tpl], [pool.id]);
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_PRESENCE_WRITE,
      async (db) => {
        await run(
          db,
          "UPDATE scan_presence SET last_scan_id = 'later', entered_at = entered_at + 1 WHERE pass_id = ? AND scope = ?",
          [p.id, place],
        );
      },
      () => markOut(s.headers, p.id, place),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
  });

  it('refuses a reused key for another pass instead of replaying', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const a = await personInside(tpl, 'A', [place]);
    const b = await personInside(tpl, 'B', [place]);
    const s = await station([tpl], [pool.id]);
    const k = key();
    expect(
      (await kit.post(s.headers, '/mark-out', { idempotencyKey: k, passId: a.id, place })).status,
    ).toBe(200);
    const reused = await kit.post(s.headers, '/mark-out', {
      idempotencyKey: k,
      passId: b.id,
      place,
    });
    expect(reused.status).toBe(409);
    expect((await presenceOf(b.id, place))[0]?.state).toBe('in');
  });

  it('writes the exit into the pass ledger like a tap-out', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Ledger', [place]);
    const s = await station([tpl], [pool.id]);
    expect((await markOut(s.headers, p.id, place)).status).toBe(200);
    const events = await all<{ kind: string }>(
      kit.env.DB,
      "SELECT kind FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'",
      [p.id],
    );
    expect(events).toHaveLength(1);
  });
});

describe('mark as out: an unattended monitor', () => {
  it('answers STAFF_REQUIRED', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Nobody', [place]);
    const s = await station([tpl], [pool.id], { deviceRole: 'monitor', deskActions: true });
    const res = await markOut(s.headers, p.id, place);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('STAFF_REQUIRED');
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
  });
});
