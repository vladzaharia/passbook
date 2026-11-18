import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { ScanningSessionDetailSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { all, first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { sweepSessionHours } from './session-hours-job.ts';

// June 2026, from the kit's clock (Monday the 1st): the 3rd is a Wednesday.
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 5, d, h, m);
const WED = { wed: ['08:00-22:00'] };
const HOUR = 3_600_000;
// The kit's clock reads Monday 12:00: MON is open, LATER opens at 14:00.
const MON = { mon: ['08:00-22:00'] };
const LATER = { mon: ['14:00-22:00'] };

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);
beforeEach(() => fixture.kit.clock.set(TEST_NOW));

const session = async (hours: object | null = WED, extra: object = {}) => {
  const { kit, call } = fixture;
  const res = await call('POST', '/scanning-sessions', {
    orgId: kit.org.id,
    name: `Hours ${kit.fx.ids.id()}`,
    timeZone: 'UTC',
    hours,
    ...extra,
  });
  expect(res.status).toBe(201);
  return ScanningSessionDetailSchema.parse(await res.json());
};
const hold = (id: string, body: object) =>
  fixture.call('POST', `/scanning-sessions/${id}/hold`, body);
const row = (id: string) =>
  first<{
    config_epoch: number;
    updated_at: number;
    hours_next_at: number | null;
    hold: string | null;
    status: string;
  }>(
    fixture.kit.env.DB,
    'SELECT config_epoch, updated_at, hours_next_at, hold, status FROM scanning_sessions WHERE id = ?',
    [id],
  );
const audits = (id: string, action: string) =>
  all<{ actor_type: string; detail: string | null }>(
    fixture.kit.env.DB,
    'SELECT actor_type, detail FROM audit_log WHERE action = ? AND target_id = ? ORDER BY rowid',
    [action, id],
  );

describe('session hours in the console', () => {
  it('creates with hours and reports the window, hours and bookmark', async () => {
    const s = await session();
    expect(s.hours).toEqual(WED);
    expect(s.window).toEqual({ open: false, by: 'hours', opensAt: at(3, 8), closesAt: null });
    expect((await row(s.id))?.hours_next_at).toBe(at(3, 8));
    const plain = await session(null);
    expect(plain.window).toMatchObject({ open: true, by: 'always' });
    expect((await row(plain.id))?.hours_next_at).toBeNull();
  });

  it('refuses empty or zero-length hours', async () => {
    const { kit, call } = fixture;
    for (const hours of [{}, { wed: ['08:00-08:00'] }]) {
      const res = await call('POST', '/scanning-sessions', {
        orgId: kit.org.id,
        name: 'Bad hours',
        timeZone: 'UTC',
        hours,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('edits and clears the hours, audited, and moves the epoch', async () => {
    const s = await session();
    const before = await row(s.id);
    const res = await fixture.call('PATCH', `/scanning-sessions/${s.id}`, {
      hours: { thu: ['10:00-12:00'] },
    });
    expect(res.status).toBe(200);
    const after = await row(s.id);
    expect(after?.config_epoch).toBeGreaterThan(before?.config_epoch ?? 0);
    expect(after?.hours_next_at).toBe(at(4, 10));
    const cleared = await fixture.call('PATCH', `/scanning-sessions/${s.id}`, { hours: null });
    expect(((await cleared.json()) as { hours: unknown }).hours).toBeNull();
    expect((await row(s.id))?.hours_next_at).toBeNull();
    const rows = await audits(s.id, 'scanning.session_hours');
    expect(rows.map((r) => JSON.parse(r.detail ?? '{}'))).toEqual([{ set: true }, { set: false }]);
  });

  it('closes now until the next opening and goes back to hours', async () => {
    const s = await session(MON);
    expect((await hold(s.id, { action: 'open' })).status).toBe(409);
    const closed = await hold(s.id, { action: 'close' });
    expect(closed.status).toBe(200);
    const body = ScanningSessionDetailSchema.parse(await closed.json());
    expect(body.hold).toEqual({ state: 'closed', until: at(8, 8) });
    expect(body.window).toEqual({ open: false, by: 'hold', opensAt: at(8, 8), closesAt: null });
    // The bookmark wakes at the 22:00 edge too; it changes nothing under the hold.
    expect((await row(s.id))?.hours_next_at).toBe(at(1, 22));
    expect((await hold(s.id, { action: 'close' })).status).toBe(409);
    const cleared = ScanningSessionDetailSchema.parse(
      await (await hold(s.id, { action: 'clear' })).json(),
    );
    expect(cleared.hold).toBeNull();
    expect(cleared.window).toMatchObject({ open: true, by: 'hours', closesAt: at(1, 22) });
    expect(await audits(s.id, 'scanning.session_closed')).toHaveLength(1);
    expect(await audits(s.id, 'scanning.session_hold_cleared')).toHaveLength(1);
  });

  it('opens a closed session early, by default until the coming window closes', async () => {
    const s = await session(LATER);
    const res = await hold(s.id, { action: 'open' });
    expect(res.status).toBe(200);
    const body = ScanningSessionDetailSchema.parse(await res.json());
    expect(body.hold).toEqual({ state: 'open', until: at(1, 22) });
    expect(body.window).toEqual({ open: true, by: 'hold', opensAt: null, closesAt: at(1, 22) });
    const [event] = await audits(s.id, 'scanning.session_opened');
    expect(event?.actor_type).toBe('user');
    expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({ by: 'user', until: at(1, 22) });
  });

  it('refuses an open hold over 24 hours with 400 and a close with nothing to open with 422', async () => {
    const s = await session(LATER);
    const now = fixture.kit.clock.now();
    expect((await hold(s.id, { action: 'open', until: now + 25 * HOUR })).status).toBe(400);
    expect((await hold(s.id, { action: 'open', until: now - HOUR })).status).toBe(400);
    const always = await session(null);
    const none = await hold(always.id, { action: 'close' });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { code: string }).code).toBe('SCANNING_HOURS_NONE');
  });

  it('refuses a hold on a stale revision', async () => {
    const s = await session(LATER);
    const res = await hold(s.id, { action: 'open', revision: s.updatedAt - 1 });
    expect(res.status).toBe(409);
  });

  it('resume clears the hold; pause ignores the hours and drops the bookmark', async () => {
    const s = await session(LATER);
    expect((await hold(s.id, { action: 'open' })).status).toBe(200);
    const paused = await fixture.call('PATCH', `/scanning-sessions/${s.id}`, { status: 'paused' });
    expect(paused.status).toBe(200);
    expect((await row(s.id))?.hours_next_at).toBeNull();
    expect((await hold(s.id, { action: 'open' })).status).toBe(409);
    const resumed = await fixture.call('PATCH', `/scanning-sessions/${s.id}`, { status: 'active' });
    const body = ScanningSessionDetailSchema.parse(await resumed.json());
    expect(body.hold).toBeNull();
    expect(body.window).toMatchObject({ open: false, by: 'hours' });
    const stored = await row(s.id);
    expect(stored?.hold).toBeNull();
    expect(stored?.hours_next_at).toBe(at(1, 14));
  });
});

describe('the session hours cron', () => {
  it('writes one audit row per flip, kicks screens, moves no epoch and is idempotent', async () => {
    const { kit } = fixture;
    const s = await session();
    await fixture.device(s.id, 'Door');
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    const info = vi.spyOn(ctx.log, 'info');
    const before = await row(s.id);

    kit.clock.set(at(3, 7));
    await sweepSessionHours(ctx);
    expect(await audits(s.id, 'scanning.session_opened')).toHaveLength(0);

    kit.clock.set(at(3, 8, 1));
    await sweepSessionHours(ctx);
    await sweepSessionHours(ctx);
    const opened = await audits(s.id, 'scanning.session_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.actor_type).toBe('system');
    expect(JSON.parse(opened[0]?.detail ?? '{}')).toEqual({ by: 'hours' });
    const mid = await row(s.id);
    expect(mid?.hours_next_at).toBe(at(3, 22));
    expect(mid?.config_epoch).toBe(before?.config_epoch);
    expect(mid?.updated_at).toBe(before?.updated_at);
    expect(info.mock.calls.some(([event]) => event === 'scan.live_kicked')).toBe(true);

    kit.clock.set(at(3, 22, 1));
    await sweepSessionHours(ctx);
    expect(await audits(s.id, 'scanning.session_closed')).toHaveLength(1);
    const end = await row(s.id);
    expect(end?.hours_next_at).toBe(at(10, 8));
    expect(end?.config_epoch).toBe(before?.config_epoch);
  });

  it('passes an edge that changes nothing, and leaves paused sessions alone', async () => {
    const { kit } = fixture;
    const s = await session(MON);
    expect((await hold(s.id, { action: 'close' })).status).toBe(200);
    const p = await session(MON);
    await fixture.call('PATCH', `/scanning-sessions/${p.id}`, { status: 'paused' });
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
    // The close edge at 22:00 changes nothing: the hold already closes it until next Monday.
    kit.clock.set(at(1, 22, 1));
    await sweepSessionHours(ctx);
    expect(await audits(s.id, 'scanning.session_closed')).toHaveLength(1);
    expect((await row(s.id))?.hours_next_at).toBe(at(8, 8));
    kit.clock.set(at(8, 9));
    await sweepSessionHours(ctx);
    expect(await audits(p.id, 'scanning.session_opened')).toHaveLength(0);
  });

  it('skips a session it cannot write and settles the rest of the batch', async () => {
    const { kit } = fixture;
    const bad = await session();
    const good = await session();
    const { run } = await import('../../platform/db.ts');
    await run(
      kit.env.DB,
      `CREATE TRIGGER zz_hours_boom BEFORE UPDATE OF hours_next_at ON scanning_sessions
       WHEN OLD.id = '${bad.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
      const warn = vi.spyOn(ctx.log, 'warn');
      kit.clock.set(at(3, 8, 1));
      await sweepSessionHours(ctx);
      expect(await audits(good.id, 'scanning.session_opened')).toHaveLength(1);
      expect(await audits(bad.id, 'scanning.session_opened')).toHaveLength(0);
      expect(
        warn.mock.calls.some(
          ([, data]) => (data as { code?: string }).code === 'SCAN_SESSION_HOURS_FAILED',
        ),
      ).toBe(true);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER zz_hours_boom');
    }
  });
});
