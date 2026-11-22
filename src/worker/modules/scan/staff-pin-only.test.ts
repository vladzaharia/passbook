import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { pinOnlyDailyCap, pinOnlyHourlyCap } from './staff-pin-only.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);
const DAY = 86_400_000;

// A clean org each time: no earlier staff (they change the budget) and no counters.
beforeEach(async () => {
  const { kit } = fixture;
  kit.clock.advance(DAY);
  await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at = ? WHERE org_id = ?', [
    kit.clock.now(),
    kit.org.id,
  ]);
  await run(kit.env.DB, "DELETE FROM counters WHERE key LIKE 'scan:pinonly:%'");
  await run(kit.env.DB, "DELETE FROM settings WHERE key = 'scan.pinOnly'");
});

const pinOnly = (headers: Record<string, string>, pin: string) =>
  fixture.call('POST', '/scan/staff', headers, { pin });

async function device(mode: 'live' | 'test' = 'live') {
  const { kit, deskTemplate } = fixture;
  const event = mode === 'test' ? await kit.event({ mode, templateIds: [deskTemplate] }) : null;
  return kit.scanner({
    templateIds: [deskTemplate],
    mode,
    ...(event ? { eventId: event.id } : {}),
    settings: { staffSignIn: true },
  });
}
const audits = async (action: string) => {
  await fixture.settle();
  return all<{ target_id: string; actor_id: string }>(
    fixture.kit.env.DB,
    'SELECT target_id, actor_id FROM audit_log WHERE org_id = ? AND action = ?',
    [fixture.kit.org.id, action],
  );
};

describe('the PIN-only budget scales with the staff count', () => {
  it.each([
    [1, 15, 40],
    [10, 15, 40],
    [50, 3, 8],
    [100, 1, 4],
    [101, 1, 4],
  ])('%i staff: %i an hour, %i a day', (staff, hour, day) => {
    expect(pinOnlyHourlyCap(staff)).toBe(hour);
    expect(pinOnlyDailyCap(staff)).toBe(day);
  });
});

describe('staff sign-in with a PIN alone', () => {
  it('signs in the one active member who has the PIN', async () => {
    const { kit, session } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'desk', pin: '246801' });
    const scanner = await device();
    const body = await session(await pinOnly(scanner.headers, staff.pin), staff.pin);
    expect(body.staff).toEqual({ id: staff.id, name: staff.name, role: 'desk' });
  });

  it('answers a wrong PIN as a named miss does, and counts a try', async () => {
    const { kit, problem } = fixture;
    await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '135790' });
    const scanner = await device();
    const miss = await problem(await pinOnly(scanner.headers, '999999'), 400, 'PIN_INVALID');
    expect(miss).toMatchObject({ issues: [{ path: 'triesLeft', message: '4' }] });
  });

  it('never matches a disabled member or another org', async () => {
    const { kit, problem } = fixture;
    const off = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '314159', disabled: true });
    const other = await makeOrg(kit.fx);
    const foreign = await makeScanStaff(kit.fx, { orgId: other.id, pin: '271828' });
    const scanner = await device();
    await problem(await pinOnly(scanner.headers, off.pin), 400, 'PIN_INVALID', off.pin);
    await problem(await pinOnly(scanner.headers, foreign.pin), 400, 'PIN_INVALID', foreign.pin);
  });

  it('answers a shared PIN exactly as a wrong one, audits and flags both people, and a name still signs in with a new PIN asked for', async () => {
    const { kit, problem, binding, session, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'desk', pin: '112358' });
    const b = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'door', pin: '112358' });
    const first = await device();
    const second = await device();
    const before = await binding(first.id);
    const shared = await problem(await pinOnly(first.headers, a.pin), 400, 'PIN_INVALID', a.pin);
    const wrong = await problem(await pinOnly(second.headers, '000000'), 400, 'PIN_INVALID');
    expect(shared).toEqual(wrong);
    expect(await binding(first.id)).toEqual(before);
    expect((await audits('scan_staff.pin_shared')).map((r) => r.target_id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // Both are flagged. A name and the shared PIN still sign each in, and the session asks for a new PIN.
    expect((await session(await signIn(first.headers, b), b.pin)).staff).toMatchObject({
      id: b.id,
      pinResetRequired: true,
    });
    expect((await session(await signIn(first.headers, a), a.pin)).staff).toMatchObject({
      id: a.id,
      pinResetRequired: true,
    });
  });

  it('never signs a Manager in by PIN alone: a miss, audited; the name still works', async () => {
    const { kit, problem, session, signIn } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '557799',
    });
    const first = await device();
    const second = await device();
    const refused = await problem(
      await pinOnly(first.headers, manager.pin),
      400,
      'PIN_INVALID',
      manager.pin,
    );
    expect(refused).toEqual(
      await problem(await pinOnly(second.headers, '000000'), 400, 'PIN_INVALID'),
    );
    expect((await audits('scan_staff.pin_only_manager')).map((r) => r.target_id)).toEqual([
      manager.id,
    ]);
    expect((await session(await signIn(first.headers, manager), manager.pin)).staff?.id).toBe(
      manager.id,
    );
  });

  it('defers the audit of a Manager or shared PIN, so the answer is no slower than a plain miss', async () => {
    const { kit, problem, deferred, settle } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '664422',
    });
    const scanner = await device();
    await settle();
    await problem(await pinOnly(scanner.headers, manager.pin), 400, 'PIN_INVALID', manager.pin);
    // The answer is out while the audit is still queued on waitUntil, not awaited.
    expect(deferred.length).toBeGreaterThan(0);
    expect(
      (await audits('scan_staff.pin_only_manager')).filter((r) => r.target_id === manager.id),
    ).toHaveLength(1);
    // A plain miss defers the same work.
    await problem(await pinOnly(scanner.headers, '000003'), 400, 'PIN_INVALID');
    expect(deferred.length).toBeGreaterThan(0);
  });

  it('turns PIN-only off when an admin sets scan.pinOnly to false, with no lockout', async () => {
    const { kit, problem, session } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '775533' });
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'scan.pinOnly', 'false', ?)",
      [`org:${kit.org.id}`, kit.clock.now()],
    );
    const scanner = await device();
    await problem(await pinOnly(scanner.headers, staff.pin), 409, 'STAFF_NAME_REQUIRED', staff.pin);
    await run(kit.env.DB, "UPDATE settings SET value = 'true' WHERE key = 'scan.pinOnly'");
    expect((await session(await pinOnly(scanner.headers, staff.pin))).staff?.id).toBe(staff.id);
  });

  it('locks the device after five misses; another device is unaffected', async () => {
    const { kit, problem, session } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '161803' });
    const scanner = await device();
    const neighbor = await device();
    for (let i = 0; i < 5; i++)
      await problem(await pinOnly(scanner.headers, '000001'), 400, 'PIN_INVALID');
    await problem(await pinOnly(scanner.headers, staff.pin), 429, 'RATE_LIMITED', staff.pin);
    expect((await audits('scanner.pin_only_locked')).map((r) => r.target_id)).toEqual([scanner.id]);
    expect((await session(await pinOnly(neighbor.headers, staff.pin))).staff?.id).toBe(staff.id);
  });

  it('refunds the org budget on a match, and pauses at the hourly cap with an audit row', async () => {
    const { kit, problem, session, signIn } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '173205' });
    const cap = pinOnlyHourlyCap(1);
    // Matches cost nothing against the hour.
    for (let i = 0; i < cap + 1; i++)
      expect((await session(await pinOnly((await device()).headers, staff.pin))).staff?.id).toBe(
        staff.id,
      );
    for (let d = 0; d < cap / 5; d++) {
      const scanner = await device();
      for (let i = 0; i < 5; i++)
        await problem(await pinOnly(scanner.headers, '000002'), 400, 'PIN_INVALID');
    }
    const fresh = await device();
    await problem(await pinOnly(fresh.headers, staff.pin), 409, 'STAFF_NAME_REQUIRED', staff.pin);
    expect((await audits('scanner.pin_only_paused')).length).toBeGreaterThan(0);
    expect((await session(await signIn(fresh.headers, staff), staff.pin)).staff?.id).toBe(staff.id);
    kit.clock.advance(3_600_000);
    expect((await session(await pinOnly((await device()).headers, staff.pin))).staff?.id).toBe(
      staff.id,
    );
  });

  it('serves live and test devices from the same staff', async () => {
    const { kit, session } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'desk', pin: '141421' });
    const live = await device('live');
    const test = await device('test');
    expect((await session(await pinOnly(live.headers, staff.pin))).scanner?.mode).toBe('live');
    const signed = await session(await pinOnly(test.headers, staff.pin));
    expect(signed.scanner?.mode).toBe('test');
    expect(signed.staff?.id).toBe(staff.id);
  });
});
