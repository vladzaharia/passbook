import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countD1,
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff, staffStatement } from './repo-staff.ts';
import {
  checkPin,
  hashPin,
  PIN_PERSON_WINDOW_MS,
  PIN_SCANNER_WINDOW_MS,
  pinStaffFromResult,
  preparePinReservation,
} from './staff-pin.ts';

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

const context = () => createServiceContext(f.env, { clock });
const personKey = (id: string) => `scan:pin:${scannerId}:${id}`;
const scannerKey = () => `scan:pinall:${scannerId}`;
const personWindow = () => clock.now() - (clock.now() % PIN_PERSON_WINDOW_MS);
const scannerWindow = () => clock.now() - (clock.now() % PIN_SCANNER_WINDOW_MS);
async function counter(key: string, window: number): Promise<number> {
  return (
    (
      await first<{ count: number }>(
        f.env.DB,
        'SELECT count FROM counters WHERE key=? AND window_start=?',
        [key, window],
      )
    )?.count ?? 0
  );
}
async function seed(key: string, window: number, count: number): Promise<void> {
  await run(f.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,?)', [
    key,
    window,
    count,
  ]);
}
async function attempt(id: string, pin: string, managerOnly = true): Promise<void> {
  const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: id });
  try {
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, id),
      ...reservation.stmts,
    ]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), pin, managerOnly);
  } finally {
    await reservation.refund();
  }
}

describe('atomic PIN reservations', () => {
  it('does not reserve or expose staff through a rejected trusted predicate', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const reservation = preparePinReservation(
      context(),
      { orgId, scannerId, staffId: manager.id },
      { sql: '0', params: [] },
    );
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    expect(
      await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true),
    ).toBeNull();
    await reservation.refund();
    expect(await all(f.env.DB, "SELECT key FROM counters WHERE key LIKE 'scan:pin%'")).toEqual([]);
  });

  it('serializes a burst at the person limit without inflating either counter', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const errors = await Promise.all(
      Array.from({ length: 12 }, () =>
        attempt(manager.id, '000000').catch((error: { code: string }) => error.code),
      ),
    );
    expect(errors.filter((code) => code === 'PIN_INVALID')).toHaveLength(5);
    expect(errors.filter((code) => code === 'RATE_LIMITED')).toHaveLength(7);
    expect(await counter(personKey(manager.id), personWindow())).toBe(5);
    expect(await counter(scannerKey(), scannerWindow())).toBe(5);
    expect(
      await all(
        f.env.DB,
        "SELECT id FROM audit_log WHERE action='scan_staff.pin_locked' AND actor_id=?",
        [scannerId],
      ),
    ).toHaveLength(1);
  });

  it('serializes guesses across names at the scanner limit and compensates each person', async () => {
    const errors = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        attempt(`unknown-${i}`, '000000').catch((error: { code: string }) => error.code),
      ),
    );
    expect(errors.filter((code) => code === 'PIN_INVALID')).toHaveLength(20);
    expect(errors.filter((code) => code === 'RATE_LIMITED')).toHaveLength(20);
    expect(await counter(scannerKey(), scannerWindow())).toBe(20);
    const people = await all<{ count: number }>(
      f.env.DB,
      'SELECT count FROM counters WHERE key LIKE ? AND window_start=?',
      [`scan:pin:${scannerId}:%`, personWindow()],
    );
    expect(people.filter((row) => row.count === 1)).toHaveLength(20);
    expect(people.filter((row) => row.count === 0)).toHaveLength(20);
    expect(
      await all(
        f.env.DB,
        "SELECT id FROM audit_log WHERE action='scanner.pin_flood' AND actor_id=?",
        [scannerId],
      ),
    ).toHaveLength(1);
  });

  it('gives person lock precedence without touching the full scanner counter', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    await seed(personKey(manager.id), personWindow(), 5);
    await seed(scannerKey(), scannerWindow(), 20);
    clock.advance(12_001);
    await expect(attempt(manager.id, manager.pin)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      headers: { 'retry-after': '288' },
    });
    expect(await counter(personKey(manager.id), personWindow())).toBe(5);
    expect(await counter(scannerKey(), scannerWindow())).toBe(20);
  });

  it('returns the person reservation when only the scanner is locked', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    await seed(personKey(manager.id), personWindow(), 2);
    await seed(scannerKey(), scannerWindow(), 20);
    clock.advance(12_001);
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    let committed = false;
    const cleanup = f.env.DB.prepare('UPDATE scan_staff SET name=? WHERE id=?').bind(
      'locked',
      manager.id,
    );
    await expect(
      reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true, {
        failureStatements: [cleanup],
        onFailureCommitted() {
          committed = true;
        },
      }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      headers: { 'retry-after': '3588' },
    });
    await reservation.refund();
    expect(committed).toBe(true);
    expect((await getStaff(f.env.DB, orgId, manager.id))?.name).toBe('locked');
    expect(await counter(personKey(manager.id), personWindow())).toBe(2);
    expect(await counter(scannerKey(), scannerWindow())).toBe(20);
  });

  it('reserves the last person and scanner slots until a correct PIN is refunded', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    await seed(personKey(manager.id), personWindow(), 4);
    await seed(scannerKey(), scannerWindow(), 19);
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    try {
      await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
      await expect(attempt('another-person', '000000')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(await counter(personKey(manager.id), personWindow())).toBe(5);
      expect(await counter(scannerKey(), scannerWindow())).toBe(20);
    } finally {
      await reservation.refund();
    }
    expect(await counter(personKey(manager.id), personWindow())).toBe(4);
    expect(await counter(scannerKey(), scannerWindow())).toBe(19);
    expect(
      await all(
        f.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('scan_staff.pin_locked','scanner.pin_flood') AND actor_id=?",
        [scannerId],
      ),
    ).toHaveLength(0);
    await expect(attempt(manager.id, '000000')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(
      await all(
        f.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('scan_staff.pin_locked','scanner.pin_flood') AND actor_id=?",
        [scannerId],
      ),
    ).toHaveLength(2);
  });

  it('retains both counters on a miss and cannot check one reservation twice', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    const staff = pinStaffFromResult(results[0]);
    expect(() => reservation.refundStatements()).toThrow();
    await expect(reservation.verify(results.slice(1), staff, '000000', true)).rejects.toMatchObject(
      { code: 'PIN_INVALID', issues: [{ path: 'triesLeft', message: '4' }] },
    );
    expect(reservation.refundStatements()).toEqual([]);
    await expect(reservation.verify(results.slice(1), staff, manager.pin, true)).rejects.toThrow();
    await reservation.refund();
    expect(await counter(personKey(manager.id), personWindow())).toBe(1);
    expect(await counter(scannerKey(), scannerWindow())).toBe(1);
  });

  it('refunds only once if the effect committed but its response was lost', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    expect(
      await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true),
    ).toMatchObject({ id: manager.id, role: 'manager' });
    const refund = reservation.refundStatements();
    await f.env.DB.batch(refund);
    await reservation.refund();
    await f.env.DB.batch(refund);
    expect(await counter(personKey(manager.id), personWindow())).toBe(0);
    expect(await counter(scannerKey(), scannerWindow())).toBe(0);
  });

  it('refunds an unused reservation even after the original authority is revoked', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const reservation = preparePinReservation(
      context(),
      { orgId, scannerId, staffId: manager.id },
      {
        sql: "EXISTS (SELECT 1 FROM scan_staff WHERE id=? AND role='manager')",
        params: [manager.id],
      },
    );
    await f.env.DB.batch(reservation.stmts);
    await run(f.env.DB, "UPDATE scan_staff SET role='door' WHERE id=?", [manager.id]);
    await reservation.refund();
    await reservation.refund();
    expect(await counter(personKey(manager.id), personWindow())).toBe(0);
    expect(await counter(scannerKey(), scannerWindow())).toBe(0);
  });

  it('refunds after a cryptographic error before determining a PIN match', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    const sign = vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('crypto failure'));
    try {
      await expect(
        reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true),
      ).rejects.toThrow('crypto failure');
    } finally {
      sign.mockRestore();
      await reservation.refund();
    }
    expect(await counter(personKey(manager.id), personWindow())).toBe(0);
    expect(await counter(scannerKey(), scannerWindow())).toBe(0);
  });

  it('treats unknown, foreign, disabled and non-manager staff as ordinary misses', async () => {
    const other = await makeOrg(f);
    const foreign = await makeScanStaff(f, { orgId: other.id, role: 'manager' });
    const disabled = await makeScanStaff(f, { orgId, role: 'manager', disabled: true });
    const door = await makeScanStaff(f, { orgId, role: 'door' });
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      for (const staff of [foreign, disabled, door, { id: 'unknown', pin: '482913' }]) {
        digest.mockClear();
        await expect(attempt(staff.id, staff.pin)).rejects.toMatchObject({ code: 'PIN_INVALID' });
        expect(digest.mock.calls).toHaveLength(2);
        const comparedHash = digest.mock.calls[1]?.[1];
        expect(comparedHash).toBeDefined();
        expect(new TextDecoder().decode(comparedHash)).toBe('0'.repeat(64));
      }
    } finally {
      digest.mockRestore();
    }
    expect(await counter(scannerKey(), scannerWindow())).toBe(4);
  });

  it.each(['role', 'disabled', 'pin', 'revision'] as const)(
    'verifies the immutable captured manager and rejects a later %s change at its fence',
    async (change) => {
      const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
      const reservation = preparePinReservation(context(), {
        orgId,
        scannerId,
        staffId: manager.id,
      });
      const results = await f.env.DB.batch([
        staffStatement(f.env.DB, orgId, manager.id),
        ...reservation.stmts,
      ]);
      const captured = pinStaffFromResult(results[0]);
      expect(captured).not.toBeNull();
      const oldHash = captured!.pinHash;
      expect(Object.isFrozen(captured)).toBe(true);
      expect(JSON.stringify(captured)).not.toContain(oldHash);
      expect(JSON.stringify(captured)).not.toContain(manager.pin);
      if (change === 'role')
        await run(f.env.DB, "UPDATE scan_staff SET role='door' WHERE id=?", [manager.id]);
      if (change === 'disabled')
        await run(f.env.DB, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
          clock.now(),
          manager.id,
        ]);
      if (change === 'pin')
        await run(f.env.DB, 'UPDATE scan_staff SET pin_hash=? WHERE id=?', [
          await hashPin(f.env, manager.id, '835104'),
          manager.id,
        ]);
      if (change === 'revision')
        await run(f.env.DB, 'UPDATE scan_staff SET updated_at=updated_at+1 WHERE id=?', [
          manager.id,
        ]);
      try {
        const verified = await reservation.verify(results.slice(1), captured, manager.pin, true);
        expect(verified).not.toBeNull();
        expect(Object.isFrozen(verified)).toBe(true);
        expect(verified!.pinHash).toBe(oldHash);
        expect(JSON.stringify(verified)).not.toContain(oldHash);
        expect(JSON.stringify(verified)).not.toContain(manager.pin);
        const fence = await first<{ allowed: number }>(
          f.env.DB,
          `SELECT EXISTS (
          SELECT 1 FROM scan_staff WHERE id=? AND org_id=? AND disabled_at IS NULL
            AND role=? AND updated_at=? AND pin_hash=?) AS allowed`,
          [verified!.id, orgId, verified!.role, verified!.updatedAt, verified!.pinHash],
        );
        expect(fence?.allowed).toBe(0);
      } finally {
        await reservation.refund();
      }
    },
  );

  it.each([0, 4, 5])(
    'batches claim failure with the PIN error at person count %i',
    async (before) => {
      const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
      if (before) await seed(personKey(manager.id), personWindow(), before);
      const counted = countD1(f.env.DB);
      const ctx = createServiceContext({ ...f.env, DB: counted.db }, { clock });
      const reservation = preparePinReservation(ctx, { orgId, scannerId, staffId: manager.id });
      const results = await counted.db.batch([
        staffStatement(counted.db, orgId, manager.id),
        ...reservation.stmts,
      ]);
      let committed = false;
      const cleanup = counted.db
        .prepare('UPDATE scan_staff SET name=? WHERE id=?')
        .bind('failed', manager.id);
      await expect(
        reservation.verify(results.slice(1), pinStaffFromResult(results[0]), '000000', true, {
          failureStatements: [cleanup],
          onFailureCommitted() {
            committed = true;
          },
        }),
      ).rejects.toMatchObject({ code: before === 5 ? 'RATE_LIMITED' : 'PIN_INVALID' });
      await reservation.refund();
      expect(committed).toBe(true);
      expect(counted.count()).toBe(2);
      expect((await getStaff(f.env.DB, orgId, manager.id))?.name).toBe('failed');
      expect(await counter(personKey(manager.id), personWindow())).toBe(Math.min(before + 1, 5));
      expect(await counter(scannerKey(), scannerWindow())).toBe(before === 5 ? 0 : 1);
      const audits = await all(
        f.env.DB,
        "SELECT id FROM audit_log WHERE action='scan_staff.pin_locked' AND actor_id=?",
        [scannerId],
      );
      expect(audits).toHaveLength(before === 4 ? 1 : 0);
    },
  );

  it('retains an invalid guess if the failure batch rolls back', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    let committed = false;
    const broken = f.env.DB.prepare("SELECT json_extract('not-json', '$.value')");
    await expect(
      reservation.verify(results.slice(1), pinStaffFromResult(results[0]), '000000', true, {
        failureStatements: [broken],
        onFailureCommitted() {
          committed = true;
        },
      }),
    ).rejects.toThrow();
    await reservation.refund();
    expect(committed).toBe(false);
    expect(await counter(personKey(manager.id), personWindow())).toBe(1);
    expect(await counter(scannerKey(), scannerWindow())).toBe(1);
  });

  it('uses at most two trips for standalone success and simultaneous lock audits', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const staff = await getStaff(f.env.DB, orgId, manager.id);
    const counted = countD1(f.env.DB);
    const ctx = createServiceContext({ ...f.env, DB: counted.db }, { clock });
    await checkPin(ctx, { scannerId, orgId, staffId: manager.id, staff, pin: manager.pin });
    expect(counted.count()).toBe(2);
    await run(f.env.DB, 'UPDATE counters SET count=4 WHERE key=? AND window_start=?', [
      personKey(manager.id),
      personWindow(),
    ]);
    await run(f.env.DB, 'UPDATE counters SET count=19 WHERE key=? AND window_start=?', [
      scannerKey(),
      scannerWindow(),
    ]);
    counted.reset();
    await expect(
      checkPin(ctx, { scannerId, orgId, staffId: manager.id, staff, pin: '000000' }),
    ).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(counted.count()).toBe(2);
    const auditRows = await all<{ action: string }>(
      f.env.DB,
      "SELECT action FROM audit_log WHERE action IN ('scan_staff.pin_locked','scanner.pin_flood') AND actor_id=?",
      [scannerId],
    );
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      'scan_staff.pin_locked',
      'scanner.pin_flood',
    ]);
  });
});
