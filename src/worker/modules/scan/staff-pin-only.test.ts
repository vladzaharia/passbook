import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeScanStaff } from '../../../../test/helpers/index.ts';
import { PIN_ONLY_MISSES_PER_ORG, PIN_ONLY_ORG_WINDOW_MS } from './staff-pin-only.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);
// A fresh window each time, so one test's misses are not the next one's.
beforeEach(() => {
  fixture.kit.clock.advance(PIN_ONLY_ORG_WINDOW_MS);
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

  it('never matches a disabled member', async () => {
    const { kit, problem } = fixture;
    const off = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      pin: '314159',
      disabled: true,
    });
    const scanner = await device();
    await problem(await pinOnly(scanner.headers, off.pin), 400, 'PIN_INVALID', off.pin);
  });

  it('never matches another org', async () => {
    const { kit, problem } = fixture;
    const other = await makeOrg(kit.fx);
    const foreign = await makeScanStaff(kit.fx, { orgId: other.id, pin: '271828' });
    const scanner = await device();
    await problem(await pinOnly(scanner.headers, foreign.pin), 400, 'PIN_INVALID', foreign.pin);
  });

  it('asks for a name when two members share the PIN, and a name still signs in', async () => {
    const { kit, problem, binding, session, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'manager', pin: '112358' });
    const b = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'door', pin: '112358' });
    const scanner = await device();
    const before = await binding(scanner.id);
    const refusal = await problem(
      await pinOnly(scanner.headers, a.pin),
      409,
      'STAFF_PIN_AMBIGUOUS',
      a.pin,
    );
    expect(JSON.stringify(refusal)).not.toContain(b.id);
    expect(await binding(scanner.id)).toEqual(before);
    expect((await session(await signIn(scanner.headers, b), b.pin)).staff?.id).toBe(b.id);
  });

  it('locks the device after five misses; another device is unaffected', async () => {
    const { kit, problem, session } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '161803' });
    const scanner = await device();
    const neighbor = await device();
    for (let i = 0; i < 5; i++)
      await problem(await pinOnly(scanner.headers, '000001'), 400, 'PIN_INVALID');
    await problem(await pinOnly(scanner.headers, staff.pin), 429, 'RATE_LIMITED', staff.pin);
    expect((await session(await pinOnly(neighbor.headers, staff.pin))).staff?.id).toBe(staff.id);
  });

  it('pauses PIN-only for the org after its misses, then asks for a name until the window ends', async () => {
    const { kit, problem, session, signIn } = fixture;
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '173205' });
    // Keep every miss inside one window.
    kit.clock.set(kit.clock.now() - (kit.clock.now() % PIN_ONLY_ORG_WINDOW_MS) + 1000);
    // Three devices of five misses each reach the org's budget without locking any one device.
    for (let d = 0; d < PIN_ONLY_MISSES_PER_ORG / 5; d++) {
      const scanner = await device();
      for (let i = 0; i < 5; i++)
        await problem(await pinOnly(scanner.headers, '000002'), 400, 'PIN_INVALID');
    }
    const fresh = await device();
    await problem(await pinOnly(fresh.headers, staff.pin), 409, 'STAFF_PIN_AMBIGUOUS', staff.pin);
    expect((await session(await signIn(fresh.headers, staff), staff.pin)).staff?.id).toBe(staff.id);
    kit.clock.set(kit.clock.now() + PIN_ONLY_ORG_WINDOW_MS);
    const later = await device();
    expect((await session(await pinOnly(later.headers, staff.pin))).staff?.id).toBe(staff.id);
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
