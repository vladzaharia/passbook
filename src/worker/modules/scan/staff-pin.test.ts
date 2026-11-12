import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff, staffStatement } from './repo-staff.ts';
import { checkPin, hashPin, pinStaffFromResult, preparePinReservation } from './staff-pin.ts';

let f: Fixtures;
let clock: ManualClock;
let orgId: string;
let scannerId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  f = fixtures(await makeEnv(), clock);
  orgId = (await makeOrg(f)).id;
  scannerId = (await makeScanner(f, { orgId })).id;
});

const ctx = () => createServiceContext(f.env, { clock });
async function attempt(staffId: string, pin: string, forOrg = orgId, sid = scannerId) {
  const staff = await getStaff(f.env.DB, forOrg, staffId);
  return checkPin(ctx(), { scannerId: sid, orgId: forOrg, staffId, staff, pin });
}
const audits = async (action: string) =>
  all<{ actor_type: string }>(f.env.DB, 'SELECT actor_type FROM audit_log WHERE action = ?', [
    action,
  ]);

describe('staff PIN', () => {
  it('hashes per staff id', async () => {
    expect(await hashPin(f.env, 'a', '123456')).not.toBe(await hashPin(f.env, 'b', '123456'));
    expect(await hashPin(f.env, 'a', '123456')).toBe(await hashPin(f.env, 'a', '123456'));
  });

  it('captures the KEK, database and subject before a reservation is awaited', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const env = { ...f.env };
    const db = env.DB;
    const subject = { scannerId, orgId, staffId: manager.id };
    const reservation = preparePinReservation(createServiceContext(env, { clock }), subject);
    env.KEK_V1 = btoa('x'.repeat(32));
    env.DB = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return () => {
            throw new Error('Replaced database was used');
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    subject.scannerId = 'different-scanner';
    subject.orgId = 'different-org';
    subject.staffId = 'different-staff';
    const results = await db.batch([staffStatement(db, orgId, manager.id), ...reservation.stmts]);
    try {
      const verified = await reservation.verify(
        results.slice(1),
        pinStaffFromResult(results[0]),
        manager.pin,
        true,
      );
      expect(verified).toMatchObject({ id: manager.id, orgId, role: 'manager' });
    } finally {
      await reservation.refund();
    }
    const counts = await all<{ count: number }>(
      db,
      'SELECT count FROM counters WHERE key IN (?,?)',
      [`scan:pin:${scannerId}:${manager.id}`, `scan:pinall:${scannerId}`],
    );
    expect(counts.map((row) => row.count)).toEqual([0, 0]);
  });

  it('accepts the right PIN', async () => {
    const s = await makeScanStaff(f, { orgId, pin: '482913' });
    await expect(attempt(s.id, '482913')).resolves.toBeUndefined();
  });

  it('works only for the same org', async () => {
    const other = await makeOrg(f);
    const s = await makeScanStaff(f, { orgId: other.id, pin: '482913' });
    await expect(attempt(s.id, '482913')).rejects.toMatchObject({
      code: 'PIN_INVALID',
      status: 400,
    });
  });

  it('a disabled person is a plain miss', async () => {
    const s = await makeScanStaff(f, { orgId, pin: '482913', disabled: true });
    await expect(attempt(s.id, '482913')).rejects.toMatchObject({ code: 'PIN_INVALID' });
  });

  it.each(['rotation', 'disable'] as const)(
    'verifies the login caller’s captured row even after %s, leaving final binding to its CAS',
    async (change) => {
      const s = await makeScanStaff(f, { orgId, pin: '482913' });
      const captured = await getStaff(f.env.DB, orgId, s.id);
      if (change === 'rotation')
        await run(f.env.DB, 'UPDATE scan_staff SET pin_hash=?,updated_at=updated_at+1 WHERE id=?', [
          await hashPin(f.env, s.id, '719325'),
          s.id,
        ]);
      else
        await run(
          f.env.DB,
          'UPDATE scan_staff SET disabled_at=?,updated_at=updated_at+1 WHERE id=?',
          [clock.now(), s.id],
        );
      await expect(
        checkPin(ctx(), {
          scannerId,
          orgId,
          staffId: s.id,
          staff: captured,
          pin: '482913',
        }),
      ).resolves.toBeUndefined();
      const counts = await all<{ count: number }>(
        f.env.DB,
        'SELECT count FROM counters WHERE key IN (?,?)',
        [`scan:pin:${scannerId}:${s.id}`, `scan:pinall:${scannerId}`],
      );
      expect(counts.map((row) => row.count)).toEqual([0, 0]);
      await expect(attempt(s.id, '482913')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    },
  );

  it('5 misses lock that person and audit once; others still sign in', async () => {
    const a = await makeScanStaff(f, { orgId, pin: '111111' });
    const b = await makeScanStaff(f, { orgId, pin: '222222' });
    const left: string[] = [];
    for (let i = 0; i < 5; i++) {
      const err = (await attempt(a.id, '000000').catch((e: unknown) => e)) as {
        issues: { message: string }[];
      };
      left.push(err.issues[0]?.message ?? '');
    }
    expect(left).toEqual(['4', '3', '2', '1', '0']);
    await expect(attempt(a.id, '111111')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });
    await expect(attempt(a.id, '000000')).rejects.toMatchObject({ status: 429 });
    expect(await audits('scan_staff.pin_locked')).toEqual([{ actor_type: 'scanner' }]);
    await expect(attempt(b.id, '222222')).resolves.toBeUndefined();
  });

  it('10 concurrent wrong PINs evaluate at most 5', async () => {
    const a = await makeScanStaff(f, { orgId, pin: '111111' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => attempt(a.id, '000000').catch((e: { code: string }) => e)),
    );
    const codes = results.map((r) => (r as { code: string }).code);
    expect(codes.filter((c) => c === 'PIN_INVALID')).toHaveLength(5);
    expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(5);
  });

  it('a right PIN does not use up a try', async () => {
    const a = await makeScanStaff(f, { orgId, pin: '111111' });
    for (let i = 0; i < 4; i++) await attempt(a.id, '000000').catch(() => {});
    await expect(attempt(a.id, '111111')).resolves.toBeUndefined();
    await expect(attempt(a.id, '000000')).rejects.toMatchObject({ code: 'PIN_INVALID' });
  });

  it('the lock ends with the window', async () => {
    const a = await makeScanStaff(f, { orgId, pin: '111111' });
    for (let i = 0; i < 5; i++) await attempt(a.id, '000000').catch(() => {});
    clock.advance(5 * 60_000);
    await expect(attempt(a.id, '111111')).resolves.toBeUndefined();
  });

  it('20 misses across names lock every PIN on that scanner and audit once', async () => {
    const staff = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeScanStaff(f, { orgId, pin: `10000${i}` })),
    );
    for (let i = 0; i < 20; i++) {
      const s = staff[i % 5];
      // Spread across the 5-minute windows so no single person locks first.
      if (i % 4 === 0) clock.advance(5 * 60_000);
      await attempt(s?.id ?? '', '999999').catch(() => {});
    }
    await expect(attempt(staff[0]?.id ?? '', '100000')).rejects.toMatchObject({ status: 429 });
    expect(await audits('scanner.pin_flood')).toHaveLength(1);
    const other = (await makeScanner(f, { orgId })).id;
    await expect(attempt(staff[0]?.id ?? '', '100000', orgId, other)).resolves.toBeUndefined();
  });

  it('logs no PIN', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await makeScanStaff(f, { orgId, pin: '482913' });
    await attempt(s.id, '654321').catch(() => {});
    const text = [log, warn, err]
      .flatMap((m) => m.mock.calls)
      .map((c) => String(c[0]))
      .join('\n');
    expect(text).not.toMatch(/654321|482913/);
    vi.restoreAllMocks();
  });
});
