import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { PIN_ONLY_MAX_STAFF } from './staff-pin-only.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

// 100 active staff: the tightest budget (1 an hour, 4 a day), so each limit is a few requests away.
const fixture = staffSessionFixture();
let target: Awaited<ReturnType<typeof makeScanStaff>>;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  target = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'door', pin: '482913' });
  for (let i = 1; i < PIN_ONLY_MAX_STAFF; i++)
    await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: String(100000 + i) });
}, 120_000);

const DAY = 86_400_000;
const pinOnly = (headers: Record<string, string>, pin: string) =>
  fixture.call('POST', '/scan/staff', headers, { pin });
const device = () =>
  fixture.kit.scanner({
    templateIds: [fixture.deskTemplate],
    settings: { staffSignIn: true },
  });
const audits = (action: string) =>
  all<{ target_id: string }>(
    fixture.kit.env.DB,
    'SELECT target_id FROM audit_log WHERE org_id = ? AND action = ?',
    [fixture.kit.org.id, action],
  );

describe('PIN-only abuse limits at 100 staff', () => {
  it('lets concurrent attempts through only up to the hourly cap', async () => {
    const { kit } = fixture;
    kit.clock.set(kit.clock.now() - (kit.clock.now() % DAY) + 3_600_000);
    const devices = await Promise.all(Array.from({ length: 8 }, device));
    const responses = await Promise.all(devices.map((d) => pinOnly(d.headers, '000000')));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([400, 409, 409, 409, 409, 409, 409, 409]);
    const hour = await first<{ count: number }>(
      kit.env.DB,
      'SELECT SUM(count) AS count FROM counters WHERE key = ?',
      [`scan:pinonly:h:${kit.org.id}`],
    );
    expect(hour?.count).toBe(1);
  });

  it('refuses a PIN alone above 100 staff, and counts disabled staff out', async () => {
    const { kit, problem } = fixture;
    const extra = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '999001' });
    kit.clock.advance(DAY);
    const scanner = await device();
    await problem(
      await pinOnly(scanner.headers, target.pin),
      409,
      'STAFF_NAME_REQUIRED',
      target.pin,
    );
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at = ? WHERE id = ?', [
      kit.clock.now(),
      extra.id,
    ]);
    expect((await pinOnly(scanner.headers, target.pin)).status).toBe(200);
  });

  it('turns PIN-only off after the daily budget runs out on three days, until it is turned on', async () => {
    const { kit, problem, session, signIn } = fixture;
    for (let day = 0; day < 3; day++) {
      kit.clock.set(kit.clock.now() - (kit.clock.now() % DAY) + DAY + 3_600_000);
      for (let hour = 0; hour < 4; hour++) {
        const scanner = await device();
        await problem(await pinOnly(scanner.headers, '000000'), 400, 'PIN_INVALID');
        kit.clock.advance(3_600_000);
      }
    }
    expect((await audits('scanner.pin_only_daily_limit')).length).toBe(3);
    expect((await audits('scan.pin_only_off')).length).toBe(1);
    const scanner = await device();
    await problem(
      await pinOnly(scanner.headers, target.pin),
      409,
      'STAFF_NAME_REQUIRED',
      target.pin,
    );
    expect((await session(await signIn(scanner.headers, target), target.pin)).staff?.id).toBe(
      target.id,
    );
    // An admin turns it on again (the settings API writes this same row).
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'scan.pinOnly', 'true', ?)",
      [`org:${kit.org.id}`, kit.clock.now()],
    );
    kit.clock.advance(DAY);
    const again = await device();
    expect((await session(await pinOnly(again.headers, target.pin))).staff?.id).toBe(target.id);
  });
});
