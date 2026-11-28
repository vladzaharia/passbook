import { beforeAll, describe, expect, it } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { RACE_EPOCH_SESSION, RACE_TAG_BIND } from './race-tags.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

const WED = '{"wed":["08:00-22:00"]}';
// June 2026, from the kit's clock: the 3rd is a Wednesday.
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 5, d, h, m);

const DESK = { ...DEFAULT_SETTINGS, roleWithoutSignIn: 'desk' };
let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

/** A desk scanner in its own session with `hours`, at a Wednesday clock reading. */
async function session(hours: string | null, status = 'active') {
  const s = await f.desk();
  const id = await f.workspace(f.kit, s, { templateIds: [f.tpl] }, DESK);
  await run(f.kit.env.DB, 'UPDATE scanning_sessions SET hours = ?, status = ? WHERE id = ?', [
    hours,
    status,
    id,
  ]);
  return { s, id };
}
const probe = (s: ScannerFixture) => f.kit.post(s.headers, '/tags/inspect', { tag: f.read() });
const code = async (res: Response) => {
  const text = await res.text();
  return text ? (JSON.parse(text) as { code?: string }).code : undefined;
};

describe('admission by session hours', () => {
  it('admits inside the hours and refuses outside them', async () => {
    const { s } = await session(WED);
    f.kit.clock.set(at(3, 9));
    expect((await probe(s)).status).toBe(200);
    f.kit.clock.set(at(3, 23));
    const refused = await probe(s);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe('SCANNING_SESSION_CLOSED');
    f.kit.clock.set(at(4, 9));
    expect(await code(await probe(s))).toBe('SCANNING_SESSION_CLOSED');
  });

  it('admits always when there are no hours', async () => {
    const { s } = await session(null);
    f.kit.clock.set(at(3, 3));
    expect((await probe(s)).status).toBe(200);
  });

  it('runs an overnight span into the next day', async () => {
    const { s } = await session('{"fri":["18:00-02:00"]}');
    f.kit.clock.set(at(6, 1));
    expect((await probe(s)).status).toBe(200);
    f.kit.clock.set(at(6, 3));
    expect(await code(await probe(s))).toBe('SCANNING_SESSION_CLOSED');
  });

  it('lets a hold override the hours until its end', async () => {
    const { s, id } = await session(WED);
    f.kit.clock.set(at(3, 23));
    const set = (hold: object) =>
      run(f.kit.env.DB, 'UPDATE scanning_sessions SET hold = ? WHERE id = ?', [
        JSON.stringify(hold),
        id,
      ]);
    await set({ state: 'open', until: at(4, 1) });
    expect((await probe(s)).status).toBe(200);
    f.kit.clock.set(at(4, 1, 1));
    expect(await code(await probe(s))).toBe('SCANNING_SESSION_CLOSED');
    f.kit.clock.set(at(3, 9));
    await set({ state: 'closed', until: at(3, 10) });
    expect(await code(await probe(s))).toBe('SCANNING_SESSION_CLOSED');
    f.kit.clock.set(at(3, 10, 1));
    expect((await probe(s)).status).toBe(200);
  });

  it('keeps a paused or ended session refused inside its hours', async () => {
    f.kit.clock.set(at(3, 9));
    for (const status of ['paused', 'ended']) {
      const { s } = await session(WED, status);
      expect(await code(await probe(s))).toBe('SCANNING_SESSION_PAUSED');
    }
  });

  it('still takes mark-out and unpair while closed', async () => {
    const { s } = await session(WED);
    f.kit.clock.set(at(3, 23));
    const out = await f.kit.post(s.headers, '/mark-out', {
      idempotencyKey: key(),
      passId: 'missing',
      place: 'zone:none',
    });
    expect(await code(out)).not.toBe('SCANNING_SESSION_CLOSED');
    const unpair = await f.kit.post(s.headers, '/unpair', {});
    expect(await code(unpair)).not.toBe('SCANNING_SESSION_CLOSED');
  });

  it('shows the workspace as closed, with when it opens', async () => {
    const { s } = await session(WED);
    f.kit.clock.set(at(3, 23));
    const res = await f.kit.get(s.headers, '/session');
    expect(res.status).toBe(200);
    const { workspace } = (await res.json()) as {
      workspace: { session: { window: unknown; hours: unknown } };
    };
    const body = workspace;
    expect(body.session.window).toEqual({
      open: false,
      by: 'hours',
      opensAt: at(10, 8),
      closesAt: null,
    });
    expect(body.session.hours).toEqual({ wed: ['08:00-22:00'] });
  });

  it('is not admitted by a cron that has not run', async () => {
    const { s, id } = await session(WED);
    await run(f.kit.env.DB, 'UPDATE scanning_sessions SET hours_next_at = ? WHERE id = ?', [
      at(3, 22),
      id,
    ]);
    f.kit.clock.set(at(3, 22, 30));
    expect(await code(await probe(s))).toBe('SCANNING_SESSION_CLOSED');
  });

  it('fails a scan as stale when the hours change between the guard and the commit', async () => {
    const { s, id } = await session(WED);
    f.kit.clock.set(at(3, 9));
    const { card } = await f.pass();
    const { result, fired } = await beforeBatch(
      f.kit.env,
      RACE_TAG_BIND,
      (db) =>
        run(
          db,
          `UPDATE scanning_sessions SET hours = '{"wed":["08:00-09:00"]}', updated_at = updated_at + 1 WHERE id = ?`,
          [id],
        ),
      () => f.bind(s, { card }),
    );
    expect(fired).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await code(result)).toBe('SCAN_CONFIG_CHANGED');
  });
});

describe('closed sessions, more doors', () => {
  const doAct = (s: ScannerFixture, input: unknown, idempotencyKey = key()) =>
    f.kit.post(s.headers, '/actions', {
      idempotencyKey,
      input,
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
    });

  it('refuses an action while closed', async () => {
    const { s } = await session(WED);
    const { pass } = await f.pass();
    f.kit.clock.set(at(3, 23));
    const res = await doAct(s, codeOf(pass));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('SCANNING_SESSION_CLOSED');
  });

  it('lets staff sign in while closed, and still refuses their action', async () => {
    const door = await f.kit.staff('door');
    const s = await f.desk({ settings: { staffSignIn: true } });
    const id = await f.workspace(
      f.kit,
      s,
      { templateIds: [f.tpl] },
      { ...DEFAULT_SETTINGS, staffSignIn: true },
    );
    await run(f.kit.env.DB, 'UPDATE scanning_sessions SET hours = ? WHERE id = ?', [WED, id]);
    f.kit.clock.set(at(3, 23));
    const res = await f.kit.post(s.headers, '/staff', { staffId: door.id, pin: door.pin });
    expect(res.status).toBe(200);
    const { pass } = await f.pass();
    expect(await code(await doAct(s, codeOf(pass)))).toBe('SCANNING_SESSION_CLOSED');
  });

  it('answers a retry of a scan committed before close with its stored result', async () => {
    const { s } = await session(WED);
    const { pass } = await f.pass();
    f.kit.clock.set(at(3, 21, 59));
    const retryKey = key();
    const first = await doAct(s, codeOf(pass), retryKey);
    expect(first.status).toBe(200);
    f.kit.clock.set(at(3, 22, 1));
    const again = await doAct(s, codeOf(pass), retryKey);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replay?: boolean }).replay).toBe(true);
    expect(await code(await doAct(s, codeOf(pass)))).toBe('SCANNING_SESSION_CLOSED');
  });

  it('answers a retry of a tag assign committed before close with its stored result', async () => {
    const { s } = await session(WED);
    const { card } = await f.pass();
    f.kit.clock.set(at(3, 21, 59));
    const tag = f.read();
    const bindKey = key();
    const body = { card, tag, idempotencyKey: bindKey };
    const first = await f.kit.post(s.headers, '/tags/bind', body);
    expect(first.status).toBe(200);
    f.kit.clock.set(at(3, 22, 1));
    const again = await f.kit.post(s.headers, '/tags/bind', body);
    expect(again.status).toBe(200);
    const fresh = await f.kit.post(s.headers, '/tags/bind', { ...body, idempotencyKey: key() });
    expect(await code(fresh)).toBe('SCANNING_SESSION_CLOSED');
  });

  it('refuses a bind preview while closed, even with a used key', async () => {
    const { s } = await session(WED);
    const { card } = await f.pass();
    f.kit.clock.set(at(3, 21, 59));
    const bindKey = key();
    expect(
      (await f.kit.post(s.headers, '/tags/bind', { card, tag: f.read(), idempotencyKey: bindKey }))
        .status,
    ).toBe(200);
    f.kit.clock.set(at(3, 22, 1));
    const preview = await f.kit.post(s.headers, '/tags/bind', {
      card,
      tag: f.read(),
      idempotencyKey: bindKey,
      preview: true,
    });
    expect(await code(preview)).toBe('SCANNING_SESSION_CLOSED');
  });

  it('fails a reused key with another pass after close, writing nothing', async () => {
    const { s } = await session(WED);
    const { pass } = await f.pass();
    const other = await f.pass();
    f.kit.clock.set(at(3, 21, 59));
    const reuse = key();
    expect((await doAct(s, codeOf(pass), reuse)).status).toBe(200);
    const count = () =>
      first<{ n: number }>(
        f.kit.env.DB,
        'SELECT count(*) AS n FROM scans WHERE idempotency_key = ?',
        [reuse],
      );
    const before = await count();
    f.kit.clock.set(at(3, 22, 1));
    const res = await doAct(s, codeOf(other.pass), reuse);
    expect(await code(res)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await count()).toEqual(before);
  });

  it('refuses a lookup by pass while closed', async () => {
    const { s } = await session(WED);
    f.kit.clock.set(at(3, 23));
    const res = await f.kit.post(s.headers, '/resolve', { input: 'x' });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('SCANNING_SESSION_CLOSED');
  });

  it('still takes a device report while closed', async () => {
    const { s } = await session(WED);
    f.kit.clock.set(at(3, 23));
    const res = await f.kit.post(s.headers, '/device', {
      capabilities: {
        width: 400,
        height: 800,
        touch: true,
        camera: 'available',
        keyboard: false,
        nativeBarcode: false,
        surfaces: ['phone'],
        preferred: 'phone',
      },
    });
    expect(await code(res)).not.toBe('SCANNING_SESSION_CLOSED');
    expect(res.status).toBeLessThan(400);
  });

  it('does not open a paused session from the door', async () => {
    const m = await f.manager();
    const id = await f.workspace(
      f.kit,
      m.scanner,
      { templateIds: [f.tpl] },
      { ...DEFAULT_SETTINGS, staffSignIn: true },
    );
    await run(
      f.kit.env.DB,
      "UPDATE scanning_sessions SET hours = ?, status = 'paused' WHERE id = ?",
      [WED, id],
    );
    f.kit.clock.set(at(3, 6));
    const res = await f.kit.post(m.scanner.headers, '/session/open-now', {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      await first(
        f.kit.env.DB,
        'SELECT 1 FROM scanning_sessions WHERE id = ? AND hold IS NOT NULL',
        [id],
      ),
    ).toBeNull();
  });

  it('fails a scan as stale when a Close now lands between the guard and the epoch capture', async () => {
    const { s, id } = await session(WED);
    f.kit.clock.set(at(3, 9));
    const { result, fired } = await beforeBatch(
      f.kit.env,
      RACE_EPOCH_SESSION,
      (db) =>
        run(db, 'UPDATE scanning_sessions SET hold = ?, updated_at = updated_at + 1 WHERE id = ?', [
          JSON.stringify({ state: 'closed', until: at(10, 8) }),
          id,
        ]),
      () => probe(s),
    );
    expect(fired).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).not.toBe(200);
  });
});

describe('Open now at the door', () => {
  async function closed() {
    const m = await f.manager();
    const id = await f.workspace(
      f.kit,
      m.scanner,
      { templateIds: [f.tpl] },
      { ...DEFAULT_SETTINGS, staffSignIn: true },
    );
    await run(f.kit.env.DB, 'UPDATE scanning_sessions SET hours = ? WHERE id = ?', [WED, id]);
    f.kit.clock.set(at(3, 6));
    return { ...m, id };
  }
  const audits = (id: string) =>
    all<{ actor_type: string; detail: string }>(
      f.kit.env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE action = 'scanning.session_opened' AND target_id = ?",
      [id],
    );

  it('lets a signed-in manager open early, audited, and scanning follows', async () => {
    const { scanner, id } = await closed();
    expect(await code(await probe(scanner))).toBe('SCANNING_SESSION_CLOSED');
    const res = await f.kit.post(scanner.headers, '/session/open-now', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { open: boolean; by: string; closesAt: number } };
    expect(body.window).toMatchObject({ open: true, by: 'hold', closesAt: at(3, 22) });
    expect((await probe(scanner)).status).toBe(200);
    const rows = await audits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_type).toBe('scanner');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({ by: 'user', via: 'scanner' });
  });

  it('refuses another role with no code, and takes a manager code from one', async () => {
    const { s: desk, id } = await session(WED);
    f.kit.clock.set(at(3, 6));
    const bare = await f.kit.post(desk.headers, '/session/open-now', {});
    expect(bare.status).toBe(403);
    expect(await code(bare)).toBe('SESSION_OPEN_FORBIDDEN');
    const mgr = await f.kit.staff('manager');
    const wrong = await f.kit.post(desk.headers, '/session/open-now', {
      approval: { staffId: mgr.id, pin: '000000' },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(
      await first(
        f.kit.env.DB,
        'SELECT hold FROM scanning_sessions WHERE id = ? AND hold IS NOT NULL',
        [id],
      ),
    ).toBeNull();
    const ok = await f.kit.post(desk.headers, '/session/open-now', {
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(ok.status).toBe(200);
    const row = (await audits(id))[0];
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ approvedBy: mgr.id });
  });

  it('does not take a Desk or Door code as the manager code', async () => {
    const { s: desk, id } = await session(WED);
    f.kit.clock.set(at(3, 6));
    for (const role of ['desk', 'door'] as const) {
      const staff = await f.kit.staff(role);
      const res = await f.kit.post(desk.headers, '/session/open-now', {
        approval: { staffId: staff.id, pin: staff.pin },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const held = await first(
      f.kit.env.DB,
      'SELECT hold FROM scanning_sessions WHERE id = ? AND hold IS NOT NULL',
      [id],
    );
    expect(held).toBeNull();
  });

  it('refuses an open that runs past 24 hours, and one on an open session', async () => {
    const { scanner } = await closed();
    const long = await f.kit.post(scanner.headers, '/session/open-now', {
      until: at(3, 6) + 25 * 3_600_000,
    });
    expect(long.status).toBe(400);
    expect((await f.kit.post(scanner.headers, '/session/open-now', {})).status).toBe(200);
    const already = await f.kit.post(scanner.headers, '/session/open-now', {});
    expect(already.status).toBe(409);
  });
});
