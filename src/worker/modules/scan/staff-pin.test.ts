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
import { all } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff } from './repo-staff.ts';
import { checkPin, hashPin } from './staff-pin.ts';

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
