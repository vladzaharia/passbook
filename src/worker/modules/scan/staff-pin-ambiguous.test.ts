import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { verifyApproval } from './approval.ts';
import { getStaff, staffStatement } from './repo-staff.ts';
import {
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

const context = (db = f.env.DB) => createServiceContext({ ...f.env, DB: db }, { clock });
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

describe('ambiguous PIN reservation responses', () => {
  it.each([
    'marker row',
    'person row',
    'scanner row',
    'missing results',
    'bad count',
    'bad metadata',
    'failed',
    'short batch',
    'sparse batch',
  ] as const)('recovers a committed reservation when %s is inconsistent', async (damage) => {
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
    const damaged = results.slice(1);
    const index = damage === 'person row' ? 1 : damage === 'scanner row' ? 3 : 0;
    const target = damaged[index];
    if (!target) throw new Error('Missing reservation fixture result');
    if (damage === 'short batch') damaged.pop();
    else if (damage === 'sparse batch') {
      damaged.length = 0;
      damaged.length = reservation.stmts.length;
    } else if (damage === 'missing results')
      damaged[index] = { ...target, results: undefined } as unknown as D1Result;
    else if (damage === 'bad count') damaged[index] = { ...target, results: [{ count: null }] };
    else if (damage === 'bad metadata')
      damaged[index] = { ...target, meta: { ...target.meta, changes: 0 } };
    else if (damage === 'failed')
      damaged[index] = { ...target, success: false } as unknown as D1Result;
    else damaged[index] = { ...target, results: [] };
    try {
      await expect(
        reservation.verify(damaged, pinStaffFromResult(results[0]), manager.pin, true),
      ).rejects.toThrow('PIN reservation');
    } finally {
      await reservation.refund();
    }
    expect(await counter(personKey(manager.id), personWindow)).toBe(2);
    expect(await counter(scannerKey(), scannerWindow)).toBe(3);
  });

  it('requires an explicit authority guard before reading an approver', async () => {
    await expect(
      verifyApproval(
        context(),
        null as never,
        { staffId: 'someone', pin: '123456' },
        undefined as never,
      ),
    ).rejects.toThrow('PIN approval requires an authority guard');
  });

  it.each([false, true])(
    'commits supplied cleanup with refund, already settled=%s',
    async (alreadySettled) => {
      const manager = await makeScanStaff(f, { orgId, role: 'manager' });
      const reservation = preparePinReservation(context(), {
        orgId,
        scannerId,
        staffId: manager.id,
      });
      const results = await f.env.DB.batch([
        staffStatement(f.env.DB, orgId, manager.id),
        ...reservation.stmts,
      ]);
      await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
      if (alreadySettled) {
        await f.env.DB.batch(reservation.refundStatements());
        reservation.markRefunded();
      }
      let committed = false;
      await reservation.refund({
        failureStatements: [
          f.env.DB.prepare('UPDATE scan_staff SET name=? WHERE id=?').bind('cleaned', manager.id),
        ],
        onFailureCommitted() {
          committed = true;
        },
      });
      expect(committed).toBe(true);
      expect((await getStaff(f.env.DB, orgId, manager.id))?.name).toBe('cleaned');
      expect(await counter(personKey(manager.id), windowOf(PIN_PERSON_WINDOW_MS))).toBe(0);
      expect(await counter(scannerKey(), windowOf(PIN_SCANNER_WINDOW_MS))).toBe(0);
    },
  );

  it('rolls back refund and leaves the callback unset when cleanup fails', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const reservation = preparePinReservation(context(), { orgId, scannerId, staffId: manager.id });
    const results = await f.env.DB.batch([
      staffStatement(f.env.DB, orgId, manager.id),
      ...reservation.stmts,
    ]);
    await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
    let committed = false;
    await expect(
      reservation.refund({
        failureStatements: [f.env.DB.prepare("SELECT json_extract('not-json', '$.value')")],
        onFailureCommitted() {
          committed = true;
        },
      }),
    ).rejects.toThrow();
    expect(committed).toBe(false);
    expect(await counter(personKey(manager.id), windowOf(PIN_PERSON_WINDOW_MS))).toBe(1);
    expect(await counter(scannerKey(), windowOf(PIN_SCANNER_WINDOW_MS))).toBe(1);
    await reservation.refund();
    expect(await counter(personKey(manager.id), windowOf(PIN_PERSON_WINDOW_MS))).toBe(0);
    expect(await counter(scannerKey(), windowOf(PIN_SCANNER_WINDOW_MS))).toBe(0);
  });

  it.each(['lost', 'truncated', 'failed', 'sparse'] as const)(
    'recovers once when a committed refund response is %s',
    async (damage) => {
      const manager = await makeScanStaff(f, { orgId, role: 'manager' });
      const personWindow = windowOf(PIN_PERSON_WINDOW_MS);
      const scannerWindow = windowOf(PIN_SCANNER_WINDOW_MS);
      await seed(personKey(manager.id), personWindow, 2);
      await seed(scannerKey(), scannerWindow, 3);
      let batches = 0;
      const db = new Proxy(f.env.DB, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (++batches === 2) {
                if (damage === 'lost') throw new Error('refund response lost');
                if (damage === 'truncated') return result.slice(1);
                if (damage === 'sparse') return Array<D1Result>(result.length);
                return result.map((item, index) =>
                  index === 0 ? ({ ...item, success: false } as unknown as D1Result) : item,
                );
              }
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const reservation = preparePinReservation(context(db), {
        orgId,
        scannerId,
        staffId: manager.id,
      });
      const results = await db.batch([staffStatement(db, orgId, manager.id), ...reservation.stmts]);
      await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), manager.pin, true);
      let committed = false;
      await expect(
        reservation.refund({
          failureStatements: [
            db.prepare('UPDATE scan_staff SET name=? WHERE id=?').bind('committed', manager.id),
          ],
          onFailureCommitted() {
            committed = true;
          },
        }),
      ).rejects.toThrow(
        damage === 'lost' ? 'refund response lost' : 'Incomplete PIN cleanup results',
      );
      expect(committed).toBe(false);
      await reservation.refund();
      expect((await getStaff(f.env.DB, orgId, manager.id))?.name).toBe('committed');
      expect(await counter(personKey(manager.id), personWindow)).toBe(2);
      expect(await counter(scannerKey(), scannerWindow)).toBe(3);
    },
  );
});
