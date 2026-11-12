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
const windowOf = (size: number) => clock.now() - (clock.now() % size);

async function seed(key: string, window: number, count: number) {
  await run(f.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,?)', [
    key,
    window,
    count,
  ]);
}

async function counter(key: string, window: number) {
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

/** Deliver or lose the response only after the underlying transaction has committed. */
function afterBatch(db: D1Database, after: (number: number) => void): D1Database {
  let calls = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          after(++calls);
          return results;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('PIN reservation recovery', () => {
  it('refunds an unverified reservation when its committed response is lost', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const staff = await getStaff(f.env.DB, orgId, manager.id);
    const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
    const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
    await seed(personKey(manager.id), personWindow, 2);
    await seed(scannerKey(), scannerWindow, 3);
    const db = afterBatch(f.env.DB, (number) => {
      if (number === 1) throw new Error('reservation response lost');
    });
    const ctx = createServiceContext({ ...f.env, DB: db }, { clock });
    await expect(
      checkPin(ctx, { orgId, scannerId, staffId: manager.id, staff, pin: manager.pin }),
    ).rejects.toThrow('reservation response lost');
    expect(await counter(personKey(manager.id), personWindow)).toBe(2);
    expect(await counter(scannerKey(), scannerWindow)).toBe(3);
  });

  it('does not double-refund when a successful effect and refund commit but the response is lost', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
    const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
    await seed(personKey(manager.id), personWindow, 2);
    await seed(scannerKey(), scannerWindow, 3);
    const db = afterBatch(f.env.DB, (number) => {
      if (number === 2) throw new Error('effect response lost');
    });
    const reservation = preparePinReservation(
      createServiceContext({ ...f.env, DB: db }, { clock }),
      { orgId, scannerId, staffId: manager.id },
    );
    const results = await db.batch([staffStatement(db, orgId, manager.id), ...reservation.stmts]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
    try {
      await expect(
        db.batch([
          db
            .prepare('UPDATE scan_staff SET name=? WHERE id=?')
            .bind('effect committed', manager.id),
          ...reservation.refundStatements(),
        ]),
      ).rejects.toThrow('effect response lost');
    } finally {
      await reservation.refund();
      await reservation.refund();
    }
    expect((await getStaff(f.env.DB, orgId, manager.id))?.name).toBe('effect committed');
    expect(await counter(personKey(manager.id), personWindow)).toBe(2);
    expect(await counter(scannerKey(), scannerWindow)).toBe(3);
  });

  it('serializes concurrent refund attempts and preserves previous misses', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
    const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
    await seed(personKey(manager.id), personWindow, 2);
    await seed(scannerKey(), scannerWindow, 3);
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
    await Promise.all([reservation.refund(), reservation.refund(), reservation.refund()]);
    expect(await counter(personKey(manager.id), personWindow)).toBe(2);
    expect(await counter(scannerKey(), scannerWindow)).toBe(3);
  });

  it('returns a refused guard without hashing, writing counters, or issuing a refund trip', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    // The database is shared by the file's tests: compare against the counters already present.
    const pinCounters = () => all(f.env.DB, "SELECT * FROM counters WHERE key LIKE 'scan:pin%'");
    const existing = await pinCounters();
    const counted = countD1(f.env.DB);
    const reservation = preparePinReservation(
      createServiceContext({ ...f.env, DB: counted.db }, { clock }),
      { orgId, scannerId, staffId: manager.id },
      { sql: '0', params: [] },
    );
    const sign = vi.spyOn(crypto.subtle, 'sign');
    try {
      const results = await counted.db.batch([
        staffStatement(counted.db, orgId, manager.id),
        ...reservation.stmts,
      ]);
      const found = pinStaffFromResult(results[0]);
      if (!found) throw new Error('Missing manager fixture');
      const unreadable = new Proxy(found, {
        get() {
          throw new Error('A denied request inspected the manager');
        },
      });
      expect(await reservation.verify(results.slice(1), unreadable, manager.pin, true)).toBeNull();
      await reservation.refund();
      expect(sign).not.toHaveBeenCalled();
    } finally {
      sign.mockRestore();
    }
    expect(counted.count()).toBe(1);
    expect(await pinCounters()).toEqual(existing);
  });

  it('does not use or release another attempt when an injected marker collides', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
    const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
    await seed(personKey(manager.id), personWindow, 5);
    const ctx = context();
    ctx.ids = { ...ctx.ids, token: () => 'forced-marker-collision' };
    const subject = { orgId, scannerId, staffId: manager.id };
    const firstReservation = preparePinReservation(ctx, subject);
    const firstResults = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...firstReservation.stmts,
    ]);
    await expect(
      firstReservation.verify(
        firstResults.slice(1),
        pinStaffFromResult(firstResults[0]),
        manager.pin,
        true,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // A previously verified concurrent attempt may now return its provisional slot.
    await run(f.env.DB, 'UPDATE counters SET count=4 WHERE key=? AND window_start=?', [
      personKey(manager.id),
      personWindow,
    ]);
    const second = preparePinReservation(ctx, subject);
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...second.stmts,
    ]);
    expect(
      await second.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true),
    ).toBeNull();
    await second.refund();
    expect(await counter(personKey(manager.id), personWindow)).toBe(4);
    expect(await counter(scannerKey(), scannerWindow)).toBe(0);
  });

  it('captures the exact verified manager before awaiting cryptography', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    const original = pinStaffFromResult(results[0])!;
    const candidate = { ...original, pinHash: original.pinHash };
    try {
      const verifying = reservation.verify(results.slice(1), candidate, manager.pin, true);
      candidate.role = 'door';
      candidate.pinHash = '0'.repeat(64);
      candidate.updatedAt += 1;
      const verified = await verifying;
      expect(verified).toMatchObject({
        id: manager.id,
        role: 'manager',
        updatedAt: original.updatedAt,
      });
      expect(verified?.pinHash).toBe(original.pinHash);
      expect(JSON.stringify(verified)).not.toContain(original.pinHash);
      expect(JSON.stringify(verified)).not.toContain(manager.pin);
    } finally {
      await reservation.refund();
    }
  });

  it('keeps the login staff, PIN, database, KEK and subject captured across the first await', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager', pin: '482913' });
    const staff = await getStaff(f.env.DB, orgId, manager.id);
    if (!staff) throw new Error('Missing staff fixture');
    const input = { orgId, scannerId, staffId: manager.id, staff, pin: manager.pin };
    const env = { ...f.env };
    const real = env.DB;
    env.DB = afterBatch(real, (number) => {
      if (number !== 1) return;
      input.orgId = 'other-org';
      input.scannerId = 'other-scanner';
      input.staffId = 'other-staff';
      input.pin = '000000';
      staff.disabledAt = clock.now();
      staff.pinHash = '0'.repeat(64);
      env.KEK_V1 = btoa('x'.repeat(32));
      env.DB = new Proxy(real, {
        get(target, property) {
          if (property === 'batch')
            return () => {
              throw new Error('Used replacement database');
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    await expect(checkPin(createServiceContext(env, { clock }), input)).resolves.toBeUndefined();
    expect(await counter(personKey(manager.id), windowOf(PIN_PERSON_WINDOW_MS))).toBe(0);
    expect(await counter(scannerKey(), windowOf(PIN_SCANNER_WINDOW_MS))).toBe(0);
  });

  it('does not recreate a removed counter with a negative value when refunding', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
    await run(f.env.DB, 'DELETE FROM counters WHERE key IN (?,?)', [
      personKey(manager.id),
      scannerKey(),
    ]);
    await reservation.refund();
    expect(
      await all(f.env.DB, 'SELECT count FROM counters WHERE key IN (?,?)', [
        personKey(manager.id),
        scannerKey(),
      ]),
    ).toEqual([]);
  });

  it('refunds the original windows even if the clock passes both boundaries', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
    const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
    await seed(personKey(manager.id), personWindow, 2);
    await seed(scannerKey(), scannerWindow, 3);
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
    clock.advance(PIN_SCANNER_WINDOW_MS + 1);
    await reservation.refund();
    expect(await counter(personKey(manager.id), personWindow)).toBe(2);
    expect(await counter(scannerKey(), scannerWindow)).toBe(3);
    expect(await counter(personKey(manager.id), windowOf(PIN_PERSON_WINDOW_MS))).toBe(0);
    expect(await counter(scannerKey(), windowOf(PIN_SCANNER_WINDOW_MS))).toBe(0);
  });
});
