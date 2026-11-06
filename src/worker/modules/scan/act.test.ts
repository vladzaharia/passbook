import { beforeAll, describe, expect, it } from 'vitest';
import { countD1, makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { requestHashOf } from './act-claim.ts';
import { safeDisplay } from './outcome.ts';
import { claimScan } from './repo-scans.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Gym card', { actions: [CHECK_IN] });
});

const act = (headers: Record<string, string>, input: unknown, over: Record<string, unknown> = {}) =>
  kit.post(headers, '/actions', {
    idempotencyKey: key(),
    input,
    clientTs: kit.clock.now(),
    actionId: 'auto',
    ...over,
  });
const out = async (res: Response) => (await res.json()) as ScanOutcome;
const mask = (o: ScanOutcome) => ({ ...o, scanId: null, at: null });
const rows = <T>(sql: string, params: (string | number)[] = []) => all<T>(kit.env.DB, sql, params);

describe('act: check-in', () => {
  it('lets a pass in once and answers with the count, the display and an undo time', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const res = await act(s.headers, codeOf(pass));
    const o = await out(res);
    expect(res.status).toBe(200);
    expect(o).toMatchObject({
      kind: 'ok',
      reason: null,
      replay: false,
      action: { id: 'check_in' },
      milestone: null,
    });
    expect(o.scanId).toEqual(expect.any(String));
    expect(o.counts.today).toBe(1);
    expect(o.undoUntil).toBe(kit.clock.now() + 10 * MINUTE);
    expect(o.display?.identity.holder).toBe('Anna Popescu');
    const row = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row).toMatchObject({
      state: 'done',
      outcome: 'ok',
      pass_id: pass.id,
      action_kind: 'check_in',
      pass_version: pass.version,
    });
  });

  it('creates no pass version and no pass.updated event', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const versions = () =>
      first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
        [pass.id],
      );
    const before = await versions();
    await act(s.headers, codeOf(pass));
    expect(await versions()).toEqual(before);
    const events = await rows<{ kind: string }>(
      'SELECT kind FROM pass_events WHERE pass_id = ? ORDER BY at',
      [pass.id],
    );
    expect(events.map((e) => e.kind).filter((k) => k.startsWith('scan.'))).toEqual([
      'scan.checked_in',
    ]);
    expect(events.map((e) => e.kind)).not.toContain('pass.updated');
    expect(
      (
        await first<{ version: number }>(kit.env.DB, 'SELECT version FROM passes WHERE id = ?', [
          pass.id,
        ])
      )?.version,
    ).toBe(pass.version);
  });

  it('the second scan is already_done and names the first scanner and time', async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const b = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const first = await out(await act(a.headers, codeOf(pass)));
    kit.clock.advance(5 * MINUTE);
    const second = await out(await act(b.headers, codeOf(pass)));
    expect(second).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    expect(second.previous).toMatchObject({
      scanId: first.scanId,
      scannerName: expect.stringContaining('Scanner'),
      override: false,
    });
    expect(second.previous?.at).toBe(kit.clock.now() - 5 * MINUTE);
  });
});

describe('act: idempotency', () => {
  it('the same key twice gives the same scanId, replay true and one ledger row', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const first = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    const second = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    expect(second).toMatchObject({ kind: 'ok', replay: true, scanId: first.scanId });
    const ledger = await rows('SELECT id FROM pass_events WHERE pass_id = ? AND kind = ?', [
      pass.id,
      'scan.checked_in',
    ]);
    expect(ledger).toHaveLength(1);
  });

  it('the same key with another body is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const idempotencyKey = key();
    await act(s.headers, codeOf(a), { idempotencyKey });
    const res = await act(s.headers, codeOf(b), { idempotencyKey });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a heads-up replays with the previous scan', async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await act(a.headers, codeOf(pass));
    const idempotencyKey = key();
    const first = await out(await act(a.headers, codeOf(pass), { idempotencyKey }));
    const again = await out(await act(a.headers, codeOf(pass), { idempotencyKey }));
    expect(again).toMatchObject({ reason: 'already_done', replay: true, scanId: first.scanId });
    expect(again.previous).not.toBeNull();
  });

  async function stage(
    s: { id: string },
    pass: { scanCode: string | null },
    idempotencyKey: string,
  ) {
    const req = {
      idempotencyKey,
      input: { code: pass.scanCode ?? '', method: 'camera' as const },
      clientTs: kit.clock.now(),
      actionId: 'auto',
    };
    await claimScan(kit.env.DB, {
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      mode: 'live',
      scannerId: s.id,
      eventId: null,
      actorType: 'scanner',
      actorId: s.id,
      actorKey: `s:${s.id}`,
      staffId: null,
      idempotencyKey,
      requestHash: await requestHashOf(req),
      method: 'camera',
      clientTs: req.clientTs,
      now: kit.clock.now(),
    });
    return req;
  }

  it('a request still pending under 15 s is 409 SCAN_IN_PROGRESS with Retry-After 1', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const res = await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey });
    expect(res.status).toBe(409);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_IN_PROGRESS');
  });

  it('one pending past 15 s is reconciled and then answered', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    kit.clock.advance(20_000);
    const res = await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey });
    expect(res.status).toBe(200);
    expect((await out(res)).kind).toBe('ok');
  });
});

describe('act: concurrency', () => {
  it('10 scanners racing for one ticket give one ok and nine already_done naming the winner', async () => {
    const scanners = await Promise.all(
      Array.from({ length: 10 }, () => kit.scanner({ templateIds: [tpl] })),
    );
    const pass = await kit.scanPass(tpl);
    const results = await Promise.all(
      scanners.map(async (s) => out(await act(s.headers, codeOf(pass)))),
    );
    const winners = results.filter((r) => r.kind === 'ok');
    const losers = results.filter((r) => r.kind === 'heads_up');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    for (const l of losers) {
      expect(l.reason).toBe('already_done');
      expect(l.previous?.scanId).toBe(winners[0]?.scanId);
      expect(l.previous?.at).toBe(kit.clock.now());
    }
    const ledger = await rows('SELECT id FROM pass_events WHERE pass_id = ? AND kind = ?', [
      pass.id,
      'scan.checked_in',
    ]);
    expect(ledger).toHaveLength(1);
  });

  it('the all_in milestone fires exactly once when the last pass arrives together', async () => {
    const t = await kit.scanTemplate('Ticket', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    const passes = await Promise.all(Array.from({ length: 4 }, () => kit.scanPass(t)));
    const scanners = await Promise.all(passes.map(() => kit.scanner({ eventId: ev.id })));
    const results = await Promise.all(
      passes.map(async (p, i) => out(await act(scanners[i]?.headers ?? {}, codeOf(p)))),
    );
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(results.filter((r) => r.milestone === 'all_in')).toHaveLength(1);
    expect(Math.max(...results.map((r) => r.counts.event?.arrived ?? 0))).toBe(4);
  });

  it('the count milestone fires once, on the 100th arrival', async () => {
    const t = await kit.scanTemplate('Crowd', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    const seed = await kit.scanPass(t);
    for (let i = 0; i < 98; i++)
      await run(
        kit.env.DB,
        `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, ?, ?, ?, 'live', ?, 'check_in', 'in', 1, 1, 1, 'seed')`,
        [seed.id, `seed${i}`, `event:${ev.id}`, kit.org.id, t],
      );
    const passes = await Promise.all(Array.from({ length: 5 }, () => kit.scanPass(t)));
    const scanners = await Promise.all(passes.map(() => kit.scanner({ eventId: ev.id })));
    const results = await Promise.all(
      passes.map(async (p, i) => out(await act(scanners[i]?.headers ?? {}, codeOf(p)))),
    );
    const hits = results.filter((r) => r.milestone === 'count');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.counts.event?.arrived).toBe(100);
  });
});

describe('act: gates', () => {
  it('daily resets at the venue midnight, in each time zone', async () => {
    const t = await kit.scanTemplate('Daily', { actions: [{ ...CHECK_IN, repeat: 'daily' }] });
    const utc = await kit.scanner({ templateIds: [t] });
    const nz = await kit.scanner({ templateIds: [t] });
    await run(kit.env.DB, "UPDATE scanners SET time_zone = 'Pacific/Auckland' WHERE id = ?", [
      nz.id,
    ]);
    const [p, q] = [await kit.scanPass(t), await kit.scanPass(t)];
    kit.clock.set((Math.floor(kit.clock.now() / (24 * HOUR)) + 1) * 24 * HOUR - 90 * MINUTE);
    expect((await out(await act(utc.headers, codeOf(p)))).kind).toBe('ok');
    expect((await out(await act(nz.headers, codeOf(q)))).kind).toBe('ok');
    kit.clock.advance(2 * HOUR);
    expect((await out(await act(utc.headers, codeOf(p)))).kind).toBe('ok');
    expect((await out(await act(nz.headers, codeOf(q)))).reason).toBe('already_done');
  });

  it('a cooldown action says how long is left', async () => {
    const t = await kit.scanTemplate('Cool', {
      actions: [{ ...CHECK_IN, repeat: 'cooldown', cooldownMinutes: 10 }],
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t);
    await act(s.headers, codeOf(pass));
    kit.clock.advance(4 * MINUTE);
    const second = await out(await act(s.headers, codeOf(pass)));
    expect(second).toMatchObject({ reason: 'cooldown', cooldownRemainingMs: 6 * MINUTE });
    kit.clock.advance(7 * MINUTE);
    expect((await out(await act(s.headers, codeOf(pass)))).kind).toBe('ok');
  });

  it('an unknown action id is 422 SCAN_ACTION_UNKNOWN and leaves no row', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const res = await act(s.headers, codeOf(pass), { actionId: 'nope', idempotencyKey });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_ACTION_UNKNOWN');
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
  });

  it('on a desk scanner (flow choose) auto answers ready and writes nothing', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { flow: 'choose' } });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const o = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    expect(o).toMatchObject({ kind: 'ready', reason: 'choose' });
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
  });

  it('refusals are recorded: a row, and a ledger event for a known pass', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const o = await out(await act(s.headers, codeOf(pass)));
    expect(o).toMatchObject({ kind: 'refused', reason: 'voided' });
    const row = await first<{ outcome: string; reason: string }>(
      kit.env.DB,
      'SELECT outcome, reason FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row).toEqual({ outcome: 'refused', reason: 'voided' });
    const events = await rows<{ kind: string }>(
      "SELECT kind FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(events).toEqual([{ kind: 'scan.rejected' }]);
  });
});

let manager: Awaited<ReturnType<ScanKit['staff']>> | undefined;
const ensureManager = async () => {
  manager ??= await kit.staff('manager', 'Boss');
  return manager;
};

describe('act: letInAgain and overrides', () => {
  async function doubled(letInAgain: 'anyone' | 'manager' | 'never') {
    await ensureManager();
    const s = await kit.scanner({ templateIds: [tpl], settings: { letInAgain } });
    const pass = await kit.scanPass(tpl);
    await act(s.headers, codeOf(pass));
    const heads = await out(await act(s.headers, codeOf(pass)));
    return { s, pass, heads };
  }

  it('anyone: Let in again records an override of the heads-up', async () => {
    const { s, pass, heads } = await doubled('anyone');
    expect(heads).toMatchObject({ reason: 'already_done', overridable: true });
    const o = await out(await act(s.headers, codeOf(pass), { overrideOf: heads.scanId }));
    expect(o.kind).toBe('ok');
    const row = await first<{ override_of: string }>(
      kit.env.DB,
      'SELECT override_of FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row?.override_of).toBe(heads.scanId);
    const again = await act(s.headers, codeOf(pass), { overrideOf: heads.scanId });
    expect(again.status).toBe(422);
  });

  it('manager: needs a Manager PIN, writes no row without it, records who approved', async () => {
    const { s, pass, heads } = await doubled('manager');
    const boss = await ensureManager();
    expect(heads.overridable).toBe(true);
    const idempotencyKey = key();
    const denied = await out(
      await act(s.headers, codeOf(pass), { overrideOf: heads.scanId, idempotencyKey }),
    );
    expect(denied).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
    const wrong = await act(s.headers, codeOf(pass), {
      overrideOf: heads.scanId,
      approval: { staffId: boss.id, pin: '000000' },
    });
    expect(wrong.status).toBe(400);
    const ok = await out(
      await act(s.headers, codeOf(pass), {
        overrideOf: heads.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(ok.kind).toBe('ok');
    const row = await first<{ approved_by: string }>(
      kit.env.DB,
      'SELECT approved_by FROM scans WHERE id = ?',
      [ok.scanId ?? ''],
    );
    expect(row?.approved_by).toBe(boss.id);
  });

  it('manager: a Desk person is not an approver', async () => {
    const { s, pass, heads } = await doubled('manager');
    const clerk = await kit.staff('desk');
    const res = await act(s.headers, codeOf(pass), {
      overrideOf: heads.scanId,
      approval: { staffId: clerk.id, pin: clerk.pin },
    });
    expect(res.status).toBe(400);
  });

  it('never: nobody can let the pass in again, and the heads-up is not overridable', async () => {
    const { s, pass, heads } = await doubled('never');
    expect(heads.overridable).toBe(false);
    const boss = await ensureManager();
    const o = await out(
      await act(s.headers, codeOf(pass), {
        overrideOf: heads.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(o).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
  });

  it("rejects an override of another scanner's scan, another pass, an ok row, or an 11-minute-old heads-up", async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const b = await kit.scanner({ templateIds: [tpl] });
    const [p, q] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const okA = await out(await act(a.headers, codeOf(p)));
    const headsA = await out(await act(a.headers, codeOf(p)));
    const code = async (res: Response) => ((await res.json()) as { code: string }).code;
    const bad = async (
      headers: Record<string, string>,
      pass: typeof p,
      overrideOf: string | null,
    ) => {
      const res = await act(headers, codeOf(pass), { overrideOf });
      return { status: res.status, code: await code(res) };
    };
    expect(await bad(b.headers, p, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, q, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, p, okA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, p, 'no-such-scan')).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    kit.clock.advance(11 * MINUTE);
    expect(await bad(a.headers, p, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
  });

  it('capacity: the next pass past Full is a heads-up, and an override lets it in', async () => {
    const t = await kit.scanTemplate('Small room', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity = 1 WHERE id = ?', [ev.id]);
    const s = await kit.scanner({ eventId: ev.id });
    const [p, q] = [await kit.scanPass(t), await kit.scanPass(t)];
    expect((await out(await act(s.headers, codeOf(p)))).kind).toBe('ok');
    const full = await out(await act(s.headers, codeOf(q)));
    expect(full).toMatchObject({ kind: 'heads_up', reason: 'capacity_full', overridable: true });
    const ok = await out(await act(s.headers, codeOf(q), { overrideOf: full.scanId }));
    expect(ok.kind).toBe('ok');
    expect(ok.counts.event).toMatchObject({ arrived: 2, capacity: 1 });
  });

  it('the pass window: a heads-up not_yet_valid can be let through', async () => {
    const t = await kit.scanTemplate('Timed', {
      actions: [CHECK_IN],
      window: { from: 'startsAt' },
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t, {
      startsAt: new Date(kit.clock.now() + HOUR).toISOString(),
    });
    const early = await out(await act(s.headers, codeOf(pass)));
    expect(early).toMatchObject({ reason: 'not_yet_valid', overridable: true });
    expect((await out(await act(s.headers, codeOf(pass), { overrideOf: early.scanId }))).kind).toBe(
      'ok',
    );
  });

  it('a stop flag holds the check-in until confirmed', async () => {
    const t = await kit.scanTemplate('Flagged', {
      actions: [CHECK_IN],
      flags: [{ input: 'tier', label: 'Unpaid dues', equals: ['overdue'], stop: true }],
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t, { tier: 'overdue' });
    expect(await out(await act(s.headers, codeOf(pass)))).toMatchObject({
      reason: 'check_required',
      flags: ['Unpaid dues'],
    });
    const ok = await out(await act(s.headers, codeOf(pass), { confirmed: true }));
    expect(ok).toMatchObject({ kind: 'ok', flags: ['Unpaid dues'] });
  });
});

describe('act: bodies and failures', () => {
  it('a refused body for an unknown code is the same across orgs, display null included', async () => {
    const orgB = await makeOrg(kit.fx, { name: 'Other Gym' });
    const tplB = await kit.scanTemplate('Gym card', { actions: [CHECK_IN] }, { orgId: orgB.id });
    const passB = await kit.scanPass(tplB, {}, { orgId: orgB.id });
    const s = await kit.scanner({ templateIds: [tpl] });
    const random = mask(await out(await act(s.headers, { code: 'ZZZZ-NOPE', method: 'camera' })));
    const foreign = mask(await out(await act(s.headers, codeOf(passB))));
    expect(foreign).toEqual(random);
    expect(random).toMatchObject({ reason: 'not_found', display: null, card: null });
  });

  it('a display that fails to build is logged and the verdict still goes out without it', () => {
    const errors: unknown[] = [];
    const ctx = {
      ...kit.ctx,
      log: { ...kit.ctx.log, error: (_: string, data: unknown) => errors.push(data) },
    };
    const broken = {
      id: 'p',
      get displayTitle(): string {
        throw new Error('display exploded');
      },
    };
    expect(safeDisplay(ctx as never, {} as never, broken, 'ok')).toBeNull();
    expect(errors).toMatchObject([{ code: 'SCAN_DISPLAY_FAILED', screen: 'ok' }]);
    expect(safeDisplay(ctx as never, {} as never, null, 'refused')).toBeNull();
  });

  it('an unexpected error leaves the row failed and the same key runs again', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const realBatch = kit.env.DB.batch.bind(kit.env.DB);
    let calls = 0;
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return (...args: Parameters<typeof realBatch>) =>
            ++calls === 2 ? Promise.reject(new Error('D1 down')) : realBatch(...args);
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const original = kit.env.DB;
    Object.assign(kit.env, { DB: db });
    try {
      expect((await act(s.headers, codeOf(pass), { idempotencyKey })).status).toBe(500);
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    const failed = await first<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM scans WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    expect(failed?.state).toBe('failed');
    const retry = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    expect(retry).toMatchObject({ kind: 'ok', replay: false });
  });
});

describe('act: round trips (SA 13.1)', () => {
  async function trips(run: () => Promise<unknown>) {
    const counted = countD1(kit.env.DB);
    const original = kit.env.DB;
    Object.assign(kit.env, { DB: counted.db });
    try {
      await run();
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    return counted.count();
  }

  /** The guard's own reads (credential, org, scope) are counted by a request that stops at validation. */
  async function guardTrips(headers: Record<string, string>) {
    return trips(() => kit.post(headers, '/actions', {}));
  }

  it('a door check-in takes at most 5 after the guard, for a winner and for a loser', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const warm = await kit.scanPass(tpl);
    await act(s.headers, codeOf(warm));
    const pass = await kit.scanPass(tpl);
    const base = await guardTrips(s.headers);
    const winner = (await trips(() => act(s.headers, codeOf(pass)))) - base;
    const loser = (await trips(() => act(s.headers, codeOf(pass)))) - base;
    expect(winner).toBeLessThanOrEqual(5);
    expect(loser).toBeLessThanOrEqual(5);
  });

  it('a refusal takes at most 4 after the guard', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    await act(s.headers, { code: 'WARM-UP-0001', method: 'camera' });
    const base = await guardTrips(s.headers);
    const refusal =
      (await trips(() => act(s.headers, { code: 'ZZZZ-1111', method: 'camera' }))) - base;
    expect(refusal).toBeLessThanOrEqual(4);
  });
});

describe('reads', () => {
  it('stats, scans and summary describe what this scanner did', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const [p, q] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    for (const input of [
      codeOf(p),
      codeOf(p),
      codeOf(q),
      { code: 'ZZZZ-2222', method: 'camera' },
    ]) {
      await act(s.headers, input);
      kit.clock.advance(1000);
    }
    const stats = (await (await kit.get(s.headers, '/stats')).json()) as { today: number };
    expect(stats.today).toBe(2);
    const recent = (await (await kit.get(s.headers, '/scans?limit=3')).json()) as {
      items: { outcome: string; actionLabel: string; title: string | null; undoable: boolean }[];
    };
    expect(recent.items).toHaveLength(3);
    expect(recent.items[0]).toMatchObject({ outcome: 'refused' });
    expect(recent.items.find((i) => i.outcome === 'ok')).toMatchObject({
      actionLabel: 'Check in',
      title: 'Anna Popescu',
      undoable: true,
    });
    const summary = (await (await kit.get(s.headers, '/summary')).json()) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      total: 4,
      ok: 2,
      headsUp: 1,
      refused: 1,
      undone: 0,
      byAction: [{ actionId: 'check_in', label: 'Check in', count: 2 }],
    });
  });

  it('an admin acts under u:<id> with the org in scope', async () => {
    const pass = await kit.scanPass(tpl);
    const res = await kit.post(kit.admin(), '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
      scope: { orgId: kit.org.id, templateIds: [tpl], timeZone: 'UTC' },
    });
    expect((await out(res)).kind).toBe('ok');
    const row = await first<{ actor_key: string; actor_type: string }>(
      kit.env.DB,
      "SELECT actor_key, actor_type FROM scans WHERE actor_key LIKE 'u:%' ORDER BY at DESC LIMIT 1",
    );
    expect(row).toEqual({ actor_key: 'u:admin-1', actor_type: 'user' });
  });
});
