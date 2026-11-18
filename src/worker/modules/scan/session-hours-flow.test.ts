import { beforeAll, describe, expect, it } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

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
      /INSERT INTO tag_bindings|INSERT INTO nfc_tags/i,
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
