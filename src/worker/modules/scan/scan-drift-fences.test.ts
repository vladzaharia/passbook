import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { credentialGone, getScanner } from './repo-device.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

const sessions = scanningSessionsFixture();
beforeAll(sessions.setup);

describe('scanning sessions are fenced to the console mode and write only what they name', () => {
  it('refuses a device edit from the other mode', async () => {
    const { kit, call, fake } = sessions;
    const made = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name: 'Fence',
      timeZone: 'UTC',
    });
    const session = (await made.json()) as { id: string };
    const dev = await call('POST', `/scanning-sessions/${session.id}/devices`, {
      name: 'Door',
      surface: 'phone',
    });
    const device = (await dev.json()) as { id: string };
    const res = await call(
      'PATCH',
      `/scanning-sessions/${session.id}/devices/${device.id}`,
      { name: 'Hijacked' },
      fake.admin({ mode: 'test' }),
    );
    expect(res.status).toBe(404);
    const row = await first<{ name: string }>(
      kit.env.DB,
      'SELECT name FROM scanners WHERE id = ?',
      [device.id],
    );
    expect(row?.name).toBe('Door');
  });

  it('a concurrent rename survives a status-only session edit', async () => {
    const { kit, call } = sessions;
    const made = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name: 'Original',
      timeZone: 'UTC',
    });
    const session = (await made.json()) as { id: string };
    const { result, fired } = await beforeBatch(
      kit.env,
      /UPDATE scanning_sessions SET/i,
      async (db) =>
        void (await run(
          db,
          "UPDATE scanning_sessions SET name = 'Renamed meanwhile' WHERE id = ?",
          [session.id],
        )),
      () => call('PATCH', `/scanning-sessions/${session.id}`, { timeZone: 'Europe/Berlin' }),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(200);
    const row = await first<{ name: string; time_zone: string }>(
      kit.env.DB,
      'SELECT name, time_zone FROM scanning_sessions WHERE id = ?',
      [session.id],
    );
    expect(row).toEqual({ name: 'Renamed meanwhile', time_zone: 'Europe/Berlin' });
  });
});

describe('only a changed device credential unpairs', () => {
  it('token, CSRF secret, revocation and expiry are gone; an epoch move alone is not', async () => {
    const kit = await setupScanKit();
    const device = await kit.scanner({ settings: { staffSignIn: true } });
    const read = async () => {
      const row = await getScanner(kit.env.DB, device.id);
      if (!row) throw new Error('Missing scanner.');
      return row;
    };
    const held = await read();
    const gone = () => credentialGone(kit.env.DB, held, kit.clock.now());
    expect(await gone()).toBe(false);
    const change = (set: string, ...params: (string | number | null)[]) =>
      run(kit.env.DB, `UPDATE scanners SET ${set}, updated_at = updated_at + 1 WHERE id = ?`, [
        ...params,
        device.id,
      ]);
    // A pair code issued, a mode move: the credential epoch moves, the token and secret stay.
    await change("pair_code_hash = 'x', pair_expires_at = ?", kit.clock.now() + 1000);
    expect((await read()).credentialEpoch).toBeGreaterThan(held.credentialEpoch ?? 0);
    expect(await gone()).toBe(false);
    await change("csrf_secret = 'rotated'");
    expect(await gone()).toBe(true);
    await change('csrf_secret = ?', held.csrfSecret);
    expect(await gone()).toBe(false);
    await change("token_hash = 'other'");
    expect(await gone()).toBe(true);
    await change('token_hash = ?, revoked_at = ?', held.tokenHash, kit.clock.now());
    expect(await gone()).toBe(true);
    await change('revoked_at = NULL, expires_at = ?', kit.clock.now() - 1);
    expect(await gone()).toBe(true);
  });
});

describe('staff sign-in answers from the committed state', () => {
  it('retries a capture that lost a race instead of answering 409', async () => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
    });
    const person = await kit.staff('door', 'Dana');
    const { result, fired } = await beforeBatch(
      kit.env,
      /SELECT role, disabled_at, pin_hash, auth_epoch FROM scan_staff/i,
      async (db) =>
        void (await run(db, "UPDATE scan_staff SET role = 'desk' WHERE id = ?", [person.id])),
      () => kit.post(scanner.headers, '/staff', { staffId: person.id, pin: person.pin }),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(200);
    expect(((await result.json()) as { staff: { role: string } | null }).staff?.role).toBe('desk');
  });
});

describe('a PIN reset is derived from the credential it read', () => {
  const staffKit = setupStaffAdminTestKit();
  it('is refused with 409 when the credential changed before the commit', async () => {
    const person = await staffKit.create('Stale');
    const before = await first<{ pin_hash: string }>(
      staffKit.env.DB,
      'SELECT pin_hash FROM scan_staff WHERE name = ?',
      ['Stale'],
    );
    const { result, fired } = await beforeBatch(
      staffKit.env,
      /UPDATE scan_staff SET/i,
      async (db) =>
        void (await run(db, "UPDATE scan_staff SET pin_hash = 'moved' WHERE name = 'Stale'")),
      () => staffKit.send('POST', staffKit.resetPath(person.staff.id)),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    const after = await first<{ pin_hash: string }>(
      staffKit.env.DB,
      'SELECT pin_hash FROM scan_staff WHERE name = ?',
      ['Stale'],
    );
    expect(after?.pin_hash).toBe('moved');
    expect(before?.pin_hash).not.toBe('moved');
  });
});
