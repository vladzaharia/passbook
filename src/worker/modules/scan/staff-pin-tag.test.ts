import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { pinOnlyCandidatesStatement } from './repo-staff.ts';
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

  it('flags both people when a shared PIN meets a tag, and refuses their sign-in', async () => {
    const { kit, problem, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '555123' });
    const b = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '555123' });
    const scanner = await device();
    expect((await signIn(scanner.headers, a)).status).toBe(200);
    expect((await row(a.id))?.pin_reset_required).toBe(0);
    await problem(await signIn(scanner.headers, b), 409, 'STAFF_PIN_RESET_REQUIRED', a.pin);
    expect((await row(a.id))?.pin_reset_required).toBe(1);
    expect((await row(b.id))?.pin_reset_required).toBe(1);
    expect((await audits('scan_staff.pin_shared')).map((r) => r.target_id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    await problem(await signIn(scanner.headers, a), 409, 'STAFF_PIN_RESET_REQUIRED', a.pin);
  });

  it('keeps a wrong PIN a plain wrong PIN for a flagged person', async () => {
    const { kit, problem, signIn } = fixture;
    const a = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '448812' });
    await run(kit.env.DB, 'UPDATE scan_staff SET pin_reset_required = 1 WHERE id = ?', [a.id]);
    const scanner = await device();
    await problem(await signIn(scanner.headers, a, '000000'), 400, 'PIN_INVALID');
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
