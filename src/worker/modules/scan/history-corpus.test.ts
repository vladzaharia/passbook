import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureConsoleFeed, consoleReadAuthority } from './feed-console-page.ts';
import { listConsoleEvents } from './repo-events.ts';
import { countScanRows, getScanRow, listScanRows, type ScanLogFilter } from './repo-feed.ts';
import { apiKeyReadAuthority, READ_SQL_BYTE_BUDGET, scanRead } from './repo-read-authority.ts';
import { readStaffActivity, staffTimeZones } from './repo-staff-activity.ts';
import { grantScanMembership, setupScanKit } from './test-kit.ts';

/*
 * Every history read at its widest shape: each filter at once, a continuation, the widest fence.
 * `scanRead` refuses a statement over 90 binds or 64 KiB, so a run that compiles proves each fits.
 * The sizes asserted here leave room for the filters a later change adds.
 */

const WIDE: ScanLogFilter = {
  mode: 'live',
  scannerId: 'scanner-1',
  staffId: 'staff-1',
  eventId: 'event-1',
  outcome: 'refused',
  reason: 'voided',
  from: 1,
  to: 2,
  limit: 1000,
  internalCursor: { at: 5, id: 'scan-9' },
};

/** Run `work` and report the byte size of every statement it prepared. */
async function sizes(db: D1Database, work: (counted: D1Database) => Promise<unknown>) {
  const seen: number[] = [];
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          seen.push(new TextEncoder().encode(sql).length);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await work(counted);
  return seen;
}

describe('history reads at their widest shape', () => {
  async function console() {
    const kit = await setupScanKit();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('The console session must resolve.');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const actor = await captureConsoleFeed(kit.ctx, session, authority);
    return { kit, auth: consoleReadAuthority(kit.ctx, actor), org: kit.org.id };
  }

  it('the console list, detail and export count fit and compile', async () => {
    const { kit, auth, org } = await console();
    const filter = { ...WIDE, orgId: org };
    const all = await sizes(kit.env.DB, async (db) => {
      expect((await listScanRows(db, auth, filter, kit.clock.now())).authorized).toBe(true);
      expect((await getScanRow(db, auth, 'scan-9', kit.clock.now())).authorized).toBe(true);
      expect((await countScanRows(db, auth, filter, 100_000)).authorized).toBe(true);
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
  });

  it('a platform key naming no org narrows by index and fits', async () => {
    const { kit } = await console();
    const auth = apiKeyReadAuthority({ keyId: 'key-1', orgId: null }, undefined, kit.clock.now());
    const all = await sizes(kit.env.DB, async (db) => {
      await listScanRows(db, auth, WIDE, kit.clock.now());
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
  });

  it('the staff roster with every filter and many zones fits and compiles', async () => {
    const { kit, auth } = await console();
    const zones = Intl.supportedValuesOf('timeZone').slice(0, 40);
    const all = await sizes(kit.env.DB, async (db) => {
      expect(await staffTimeZones(db, auth)).toEqual([]);
      const rows = await readStaffActivity(
        db,
        auth,
        zones,
        kit.clock.now(),
        {
          q: 'ana',
          limit: 200,
          staffId: 'staff-1',
          cursor: { disabled: false, name: 'ana', id: 'staff-0' },
        },
        'UTC',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ auth_ok: 1, snapshot_ok: 1, m_id: null });
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
  });

  it('the event list with a status, a search and a cursor fits', async () => {
    const { kit, auth } = await console();
    const all = await sizes(kit.env.DB, async (db) => {
      const result = await listConsoleEvents(db, auth, {
        status: 'live',
        q: 'gala',
        now: kit.clock.now(),
        cursor: 'event-1',
        limit: 51,
      });
      expect(result.authorized).toBe(true);
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
  });
  it('a read may be 64 KiB of UTF-8, counted in bytes, and no more', async () => {
    const { kit, auth } = await console();
    const padded = (comment: string) =>
      `SELECT 1 AS ok FROM ${auth.anchor} WHERE ${auth.present} /*${comment}*/`;
    // Over the 32 KiB a grant write may be, under the read budget.
    expect(
      (await scanRead(kit.env.DB, auth, padded('x'.repeat(40_000))).all()).results,
    ).toHaveLength(1);
    // 33,000 characters but 66,000 bytes: refused although it is short in characters.
    expect(() => scanRead(kit.env.DB, auth, padded('é'.repeat(33_000)))).toThrow(
      /SQL_SIZE_BUDGET|bytes/,
    );
    expect(() => scanRead(kit.env.DB, auth, padded('x'.repeat(READ_SQL_BYTE_BUDGET)))).toThrow(
      /SQL_SIZE_BUDGET|bytes/,
    );
  });
});
