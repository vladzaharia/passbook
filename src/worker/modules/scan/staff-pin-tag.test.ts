import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { approverStatement, pinOnlyCandidatesStatement } from './repo-staff.ts';
import { PIN_MISSES_PER_STAFF_DAY } from './staff-pin-day.ts';
import { pinTag } from './staff-pin-hash.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

const device = () =>
  fixture.kit.scanner({ templateIds: [fixture.deskTemplate], settings: { staffSignIn: true } });
const row = (id: string) =>
  first<{ pin_tag: string | null; pin_reset_required: number }>(
    fixture.kit.env.DB,
    'SELECT pin_tag, pin_reset_required FROM scan_staff WHERE id = ?',
    [id],
  );
const audits = async (action: string) => {
  await fixture.settle();
  return all<{ target_id: string }>(
    fixture.kit.env.DB,
    'SELECT target_id FROM audit_log WHERE org_id = ? AND action = ?',
    [fixture.kit.org.id, action],
  );
};

describe('the PIN tag', () => {
  it('is filled by the next verified sign-in, by name or by PIN alone', async () => {
    const { kit, session, signIn, call } = fixture;
    const named = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '731904' });
    const alone = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '640218' });
    expect((await row(named.id))?.pin_tag).toBeNull();
    const scanner = await device();
    await session(await signIn(scanner.headers, named), named.pin);
    expect((await row(named.id))?.pin_tag).toBe(await pinTag(kit.env, kit.org.id, named.pin));
    await session(await call('POST', '/scan/staff', (await device()).headers, { pin: alone.pin }));
    expect((await row(alone.id))?.pin_tag).toBe(await pinTag(kit.env, kit.org.id, alone.pin));
  });

  it('keeps a PIN-only lookup to the tagged person and those not tagged yet', async () => {
    const { kit } = fixture;
    const tagged = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '305917' });
    const legacy = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '862041' });
    const tag = await pinTag(kit.env, kit.org.id, tagged.pin);
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_tag = ? WHERE id = ?', [tag, tagged.id]);
    const ids = async (t: string) =>
      (
        await pinOnlyCandidatesStatement(kit.env.DB, kit.org.id, t).all<{ id: string }>()
      ).results.map((r) => r.id);
    expect(await ids(tag)).toContain(tagged.id);
    expect(await ids(await pinTag(kit.env, kit.org.id, '000000'))).not.toContain(tagged.id);
    expect(await ids(await pinTag(kit.env, kit.org.id, '000000'))).toContain(legacy.id);
  });

  it('refuses a second active person with the same tag', async () => {
    const { kit } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '119283' });
    const b = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '119284' });
    const tag = await pinTag(kit.env, kit.org.id, '119283');
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_tag = ? WHERE id = ?', [tag, a.id]);
    await expect(
      run(kit.env.DB, 'UPDATE scan_staff SET pin_tag = ? WHERE id = ?', [tag, b.id]),
    ).rejects.toThrow(/UNIQUE/);
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at = 1 WHERE id = ?', [a.id]);
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_tag = ? WHERE id = ?', [tag, b.id]);
  });

  it('flags both people when a shared PIN meets a tag, and signs them in asking for a new PIN', async () => {
    const { kit, session, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '555123' });
    const b = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '555123' });
    const scanner = await device();
    expect(
      (await session(await signIn(scanner.headers, a))).staff?.pinResetRequired,
    ).toBeUndefined();
    expect((await row(a.id))?.pin_reset_required).toBe(0);
    expect((await session(await signIn(scanner.headers, b))).staff?.pinResetRequired).toBe(true);
    expect((await row(a.id))?.pin_reset_required).toBe(1);
    expect((await row(b.id))?.pin_reset_required).toBe(1);
    expect((await audits('scan_staff.pin_shared')).map((r) => r.target_id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
  });

  describe('getting a new PIN', () => {
    const getPin = (headers: Record<string, string>) =>
      fixture.call('POST', '/scan/staff/pin', headers);
    const issued = async (response: Response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      return (await response.json()) as { pin: string; session: { staff: unknown } };
    };
    async function flagged(pin: string) {
      const { kit, signIn } = fixture;
      const person = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin });
      await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [
        person.id,
      ]);
      const scanner = await device();
      await signIn(scanner.headers, person);
      return { person, scanner };
    }

    it('sets a random unique PIN, returns it once, clears the flag, audits, and it signs in', async () => {
      const { kit, session, signIn, call } = fixture;
      const other = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '730482' });
      const { person, scanner } = await flagged('381726');
      const done = await issued(await getPin(scanner.headers));
      expect(done.pin).toMatch(/^\d{6}$/);
      expect(done.pin).not.toBe('381726');
      expect(done.pin).not.toBe(other.pin);
      expect(done.session.staff).toEqual({
        id: person.id,
        name: person.name,
        role: expect.any(String),
      });
      expect(await row(person.id)).toEqual({
        pin_tag: await pinTag(kit.env, kit.org.id, done.pin),
        pin_reset_required: 0,
      });
      expect((await audits('scan_staff.pin_self_reset')).map((r) => r.target_id)).toEqual([
        person.id,
      ]);
      // The new PIN signs in alone; the old one is a miss.
      expect(
        (
          await session(
            await call('POST', '/scan/staff', (await device()).headers, { pin: done.pin }),
          )
        ).staff?.id,
      ).toBe(person.id);
      expect(
        (await call('POST', '/scan/staff', (await device()).headers, { pin: '381726' })).status,
      ).toBe(400);
      await session(await signIn((await device()).headers, person, done.pin));
    });

    it('draws another PIN within 10 minutes on the same scanner and voids the first; not later, not elsewhere', async () => {
      const { kit, problem, signIn, call } = fixture;
      const { person, scanner } = await flagged('381729');
      const first = await issued(await getPin(scanner.headers));
      kit.clock.advance(5 * 60_000);
      const second = await issued(await getPin(scanner.headers));
      expect(second.pin).not.toBe(first.pin);
      expect(
        (await audits('scan_staff.pin_self_reset')).filter((r) => r.target_id === person.id),
      ).toHaveLength(2);
      expect(
        (await call('POST', '/scan/staff', (await device()).headers, { pin: first.pin })).status,
      ).toBe(400);
      expect(
        (await call('POST', '/scan/staff', (await device()).headers, { pin: second.pin })).status,
      ).toBe(200);
      // Another device signed in as the same person has no window of its own.
      const other = await device();
      await signIn(other.headers, person, second.pin);
      await problem(await getPin(other.headers), 409, 'STAFF_PIN_RESET_NOT_REQUIRED');
      kit.clock.advance(11 * 60_000);
      await problem(await getPin(scanner.headers), 409, 'STAFF_PIN_RESET_NOT_REQUIRED');
    });

    it('is refused for a flagged Manager: only an admin resets that PIN', async () => {
      const { kit, problem, signIn } = fixture;
      const manager = await makeScanStaff(kit.fx, {
        orgId: kit.org.id,
        role: 'manager',
        pin: '381730',
      });
      await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [
        manager.id,
      ]);
      const scanner = await device();
      await signIn(scanner.headers, manager);
      await problem(await getPin(scanner.headers), 409, 'STAFF_PIN_ADMIN_RESET');
    });

    it("allows one repeat only, without extending the window, and ends the person's other sign-ins", async () => {
      const { kit, problem, signIn, session, getSession } = fixture;
      const { person, scanner } = await flagged('381731');
      const elsewhere = await device();
      await signIn(elsewhere.headers, person);
      kit.clock.advance(1000);
      await issued(await getPin(scanner.headers));
      // The other device is signed out by the new PIN; this one keeps its sign-in.
      expect((await session(await getSession(elsewhere.headers))).staff).toBeNull();
      expect((await session(await getSession(scanner.headers))).staff?.id).toBe(person.id);
      kit.clock.advance(6 * 60_000);
      await issued(await getPin(scanner.headers));
      kit.clock.advance(60_000);
      await problem(await getPin(scanner.headers), 409, 'STAFF_PIN_RESET_NOT_REQUIRED');
    });

    it('works from a desk monitor', async () => {
      const { kit, signIn } = fixture;
      const person = await makeScanStaff(kit.fx, {
        orgId: kit.org.id,
        role: 'desk',
        pin: '381732',
      });
      await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [
        person.id,
      ]);
      const monitor = await kit.scanner({
        deviceRole: 'monitor',
        templateIds: [fixture.deskTemplate],
        settings: { staffSignIn: true, deskActions: true },
      });
      await signIn(monitor.headers, person);
      await issued(await getPin(monitor.headers));
    });

    it('keeps a flagged person off every other route until they take the PIN', async () => {
      const { problem, call } = fixture;
      const { scanner } = await flagged('381733');
      await problem(
        await call('GET', '/scan/summary', scanner.headers),
        409,
        'STAFF_PIN_RESET_REQUIRED',
      );
      await issued(await getPin(scanner.headers));
      expect((await call('GET', '/scan/summary', scanner.headers)).status).not.toBe(409);
    });

    it('is only for a person whose PIN needs replacing, and is rate limited', async () => {
      const { kit, problem, signIn } = fixture;
      const fine = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '264813' });
      const scanner = await device();
      await signIn(scanner.headers, fine);
      await problem(await getPin(scanner.headers), 409, 'STAFF_PIN_RESET_NOT_REQUIRED');
      const { person, scanner: mine } = await flagged('381728');
      await issued(await getPin(mine.headers));
      for (let i = 0; i < 5; i++) await getPin(mine.headers);
      await problem(await getPin(mine.headers), 429, 'RATE_LIMITED');
      expect(person.id).toBeTruthy();
    });

    it('needs a signed-in person', async () => {
      const { problem } = fixture;
      const scanner = await device();
      await problem(await getPin(scanner.headers), 409, 'STAFF_SIGN_IN_REQUIRED');
    });
  });

  it('leaves a flagged Manager out of approvals: their PIN is a plain miss', async () => {
    const { kit } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '119290',
    });
    const rows = async () => ({
      named: (await approverStatement(kit.env.DB, kit.org.id, manager.id).all()).results.length,
      roster: (
        await approverStatement(kit.env.DB, kit.org.id, undefined).all<{ id: string }>()
      ).results.filter((r) => r.id === manager.id).length,
    });
    expect(await rows()).toEqual({ named: 1, roster: 1 });
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [
      manager.id,
    ]);
    expect(await rows()).toEqual({ named: 0, roster: 0 });
  });

  it('keeps a wrong PIN a plain wrong PIN for a flagged person', async () => {
    const { kit, problem, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '448812' });
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [a.id]);
    const scanner = await device();
    await problem(await signIn(scanner.headers, a, '000000'), 400, 'PIN_INVALID');
  });
});

describe('wrong named PINs per device and across the org', () => {
  const setCount = (key: string, count: number) => {
    const now = fixture.kit.clock.now();
    return run(
      fixture.kit.env.DB,
      'INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT (key, window_start) DO UPDATE SET count = ?',
      [key, now - (now % 86_400_000), count, count],
    );
  };

  it('refuses the device that spent its day, and signs in on another with the right PIN', async () => {
    const { kit, problem, signIn } = fixture;
    const person = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '270915' });
    const spent = await device();
    await setCount(`scan:pinday-dev:${spent.id}`, 99);
    await problem(await signIn(spent.headers, person, '000000'), 400, 'PIN_INVALID');
    await problem(await signIn(spent.headers, person), 429, 'RATE_LIMITED', person.pin);
    expect((await signIn((await device()).headers, person)).status).toBe(200);
  });

  it('only alerts at the org level: the audit is written and a right PIN still signs in', async () => {
    const { kit, problem, signIn } = fixture;
    const person = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '270916' });
    await setCount(`scan:pinday-org:${kit.org.id}`, 299);
    const scanner = await device();
    await problem(await signIn(scanner.headers, person, '000000'), 400, 'PIN_INVALID');
    expect((await audits('scan.pin_named_org_cap')).length).toBeGreaterThan(0);
    expect((await signIn(scanner.headers, person)).status).toBe(200);
    await run(kit.env.DB, 'DELETE FROM counters WHERE key = ?', [`scan:pinday-org:${kit.org.id}`]);
  });
});

describe('wrong PINs for one named person per day', () => {
  it('locks the account for the day at the cap, with an audit row, and does not count other people', async () => {
    const { kit, problem, signIn, session } = fixture;
    const target = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '270913' });
    const other = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '270914' });
    const now = kit.clock.now();
    await run(kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)', [
      `scan:pinday:${target.id}`,
      now - (now % 86_400_000),
      PIN_MISSES_PER_STAFF_DAY - 1,
    ]);
    const scanner = await device();
    await problem(await signIn(scanner.headers, target, '000000'), 400, 'PIN_INVALID');
    expect((await audits('scan_staff.pin_day_limit')).map((r) => r.target_id)).toEqual([target.id]);
    const locked = await problem(
      await signIn(scanner.headers, target),
      429,
      'RATE_LIMITED',
      target.pin,
    );
    expect(locked).toMatchObject({ issues: [{ path: 'pin', message: 'locked' }] });
    expect((await session(await signIn(scanner.headers, other), other.pin)).staff?.id).toBe(
      other.id,
    );
    kit.clock.advance(86_400_000);
    expect((await signIn(scanner.headers, target)).status).toBe(200);
  });
});
