import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import {
  PIN_MISSES_PER_PERSON,
  PIN_MISSES_PER_SCANNER,
  PIN_PERSON_WINDOW_MS,
  PIN_SCANNER_WINDOW_MS,
} from './staff-pin.ts';

const staffAdmin = setupStaffAdminTestKit();
const { create, list, pinAttempt } = staffAdmin;
let env: typeof staffAdmin.env;
let f: typeof staffAdmin.f;
let clock: typeof staffAdmin.clock;
let orgId: typeof staffAdmin.orgId;
beforeEach(() => {
  ({ env, f, clock, orgId } = staffAdmin);
});

describe('mode-specific staff activity and device PIN locks', () => {
  it('shows a person lock only in the mode of an actually locked, non-revoked scanner', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const another = await makeScanStaff(f, { orgId, name: 'Another', pin: '111111' });
    const live = await makeScanner(f, { orgId });
    const test = await makeScanner(f, { orgId, mode: 'test' });
    for (let i = 0; i < PIN_MISSES_PER_PERSON - 1; i++) {
      await expect(pinAttempt(person.id, '999999', test.id)).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
    }
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)?.locked).toBe(false);
    await expect(pinAttempt(person.id, '999999', test.id)).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
    await expect(pinAttempt(person.id, person.pin, test.id)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    await expect(pinAttempt(person.id, person.pin, live.id)).resolves.toBeUndefined();
    await expect(pinAttempt(another.id, another.pin, test.id)).resolves.toBeUndefined();
    expect((await list()).find((staff) => staff.id === person.id)?.locked).toBe(false);
    const sandbox = await list(orgId, 'test');
    expect(sandbox.find((staff) => staff.id === person.id)?.locked).toBe(true);
    expect(sandbox.find((staff) => staff.id === another.id)?.locked).toBe(false);
    await run(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [clock.now(), test.id]);
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)?.locked).toBe(false);
    await run(env.DB, 'UPDATE scanners SET revoked_at = NULL WHERE id = ?', [test.id]);
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)?.locked).toBe(true);
    clock.advance(PIN_PERSON_WINDOW_MS);
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)?.locked).toBe(false);
    await expect(pinAttempt(person.id, person.pin, test.id)).resolves.toBeUndefined();
  });

  it('does not attribute a lock to an unpaired or expired scanner credential', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const device = await makeScanner(f, { orgId, mode: 'test' });
    for (let i = 0; i < PIN_MISSES_PER_PERSON; i++) {
      await expect(pinAttempt(person.id, '999999', device.id)).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
    }
    expect((await list(orgId, 'test'))[0]?.locked).toBe(true);
    await run(env.DB, 'UPDATE scanners SET expires_at = ? WHERE id = ?', [clock.now(), device.id]);
    expect((await list(orgId, 'test'))[0]?.locked).toBe(false);
    await run(env.DB, 'UPDATE scanners SET expires_at = NULL, last_seen_at = NULL WHERE id = ?', [
      device.id,
    ]);
    expect((await list(orgId, 'test'))[0]?.locked).toBe(true);
    await run(env.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [
      clock.now() - DEVICE_IDLE_MS,
      device.id,
    ]);
    expect((await list(orgId, 'test'))[0]?.locked).toBe(false);
    await run(env.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [
      clock.now(),
      device.id,
    ]);
    expect((await list(orgId, 'test'))[0]?.locked).toBe(true);
    await run(
      env.DB,
      `UPDATE scanners SET token_prefix = NULL, token_hash = NULL, csrf_secret = NULL, paired_at = NULL,
       updated_at = updated_at + 1
       WHERE id = ?`,
      [device.id],
    );
    expect((await list(orgId, 'test'))[0]?.locked).toBe(false);

    // Terminals never accept staff PINs, even if stale counters exist for one.
    const terminal = await makeScanner(f, {
      orgId,
      mode: 'test',
      kind: 'terminal',
      lastSeenAt: clock.now() - DEVICE_IDLE_MS,
    });
    for (let i = 0; i < PIN_MISSES_PER_PERSON; i++) {
      await expect(pinAttempt(person.id, '999999', terminal.id)).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
    }
    expect((await list(orgId, 'test'))[0]?.locked).toBe(false);
  });

  it('shows a scanner-wide flood lock for every staff member only in that scanner mode', async () => {
    const people = [];
    for (let i = 0; i < 5; i++) {
      people.push(await makeScanStaff(f, { orgId, name: `Person ${i}`, pin: '482913' }));
    }
    const test = await makeScanner(f, { orgId, mode: 'test' });
    const otherTest = await makeScanner(f, { orgId, mode: 'test' });
    const live = await makeScanner(f, { orgId });
    for (let i = 0; i < PIN_MISSES_PER_SCANNER - 1; i++) {
      const person = people[i % people.length];
      if (!person) throw new Error('Missing staff fixture');
      await expect(pinAttempt(person.id, '999999', test.id)).rejects.toMatchObject({
        code: 'PIN_INVALID',
      });
    }
    expect((await list(orgId, 'test')).every((staff) => !staff.locked)).toBe(true);
    const last = people[(PIN_MISSES_PER_SCANNER - 1) % people.length];
    if (!last) throw new Error('Missing staff fixture');
    await expect(pinAttempt(last.id, '999999', test.id)).rejects.toMatchObject({
      code: 'PIN_INVALID',
    });
    await expect(pinAttempt(last.id, last.pin, test.id)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    await expect(pinAttempt(last.id, last.pin, otherTest.id)).resolves.toBeUndefined();
    await expect(pinAttempt(last.id, last.pin, live.id)).resolves.toBeUndefined();
    expect((await list(orgId, 'test')).every((staff) => staff.locked)).toBe(true);
    expect((await list()).every((staff) => !staff.locked)).toBe(true);
    const newcomer = await create('Newcomer', 'door', orgId, 'test');
    expect(newcomer.staff.locked).toBe(true);
    expect((await list()).find((staff) => staff.id === newcomer.staff.id)?.locked).toBe(false);
    clock.advance(PIN_SCANNER_WINDOW_MS);
    expect((await list(orgId, 'test')).every((staff) => !staff.locked)).toBe(true);
    await expect(pinAttempt(last.id, last.pin, test.id)).resolves.toBeUndefined();
  });
});
