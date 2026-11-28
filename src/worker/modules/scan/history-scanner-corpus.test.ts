import { describe, expect, it } from 'vitest';
import { kit, registerCountsFixture, scenario } from './repo-counts-cache-fixtures.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import {
  READ_SQL_BYTE_BUDGET,
  SESSION_READ,
  scanReadAuthority,
  withSessionRow,
} from './repo-read-authority.ts';
import {
  HISTORY_READ,
  ownScansWhere,
  readSummary,
  SUMMARY_CONTRIBUTORS,
} from './repo-scan-history.ts';
import { scanningSessionRow, scanningSessionStats } from './repo-scanning-sessions.ts';
import { activitySelector } from './repo-session-activity.ts';
import { scanSessionCountAuthority } from './scanning-workspace.ts';

/*
 * The scanner's own history, session and activity reads at their widest shape: a staffed device on
 * an event inside a session, twenty templates, every window. `scanRead` refuses a statement over 90
 * binds or 64 KiB, so a run that compiles proves each fits.
 */

registerCountsFixture();

async function sizes(work: (counted: D1Database) => Promise<unknown>) {
  const seen: number[] = [];
  const counted = new Proxy(kit.env.DB, {
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

async function widest() {
  const s = await scenario({ staff: true, session: true });
  const ids = [s.templateId, s.otherTemplateId];
  for (let i = ids.length; i < 20; i++) ids.push(`template-${i}`);
  s.actor.templateIds = ids;
  if (!s.sessionId) throw new Error('Missing session fixture');
  const row = await scanningSessionRow(kit.env.DB, kit.org.id, s.sessionId);
  if (!row) throw new Error('Missing session row');
  return { s, ids, row };
}

describe('scanner history reads at their widest shape', () => {
  it('recent and summary fit and compile', async () => {
    const { s } = await widest();
    const now = kit.clock.now();
    const auth = scanReadAuthority(s.actor, { now, read: HISTORY_READ });
    const own = ownScansWhere(s.actor);
    const all = await sizes(async (db) => {
      const recent = await readHistoryPage(
        db,
        auth,
        { where: own.sql, params: own.params, limit: 100 },
        now,
      );
      expect(recent).toEqual({ authorized: true, rows: [] });
      const summary = await readSummary(
        db,
        auth,
        s.actor,
        { from: now - 86_400_000, to: now },
        now,
      );
      expect(summary.authorized).toBe(true);
      expect(summary.totals).toMatchObject({ total: 0, ok: 0, first_at: null });
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
    expect(SUMMARY_CONTRIBUTORS).toBe(500);
  });

  it('session activity over twenty templates under the session row fits and compiles', async () => {
    const { s, ids, row } = await widest();
    const now = kit.clock.now();
    const selector = activitySelector({ ...row, accepts: JSON.stringify({ templateIds: ids }) });
    if (!selector) throw new Error('Missing activity selector');
    const auth = withSessionRow(scanSessionCountAuthority(s.actor).at(now), row);
    expect(auth.params.length).toBeLessThanOrEqual(60);
    const all = await sizes(async (db) => {
      const page = await readHistoryPage(
        db,
        auth,
        { ...selector, tenant: auth.tenantOnce('+s', 'scans') },
        now,
      );
      expect(page).toEqual({ authorized: true, rows: [] });
    });
    expect(Math.max(...all)).toBeLessThan(READ_SQL_BYTE_BUDGET * 0.9);
  });

  it('the session counts under the session row compile and answer', async () => {
    const { s, row } = await widest();
    const now = kit.clock.now();
    expect(
      await scanningSessionStats(
        kit.env.DB,
        row,
        now - 86_400_000,
        now - 120_000,
        scanSessionCountAuthority(s.actor),
        now,
      ),
    ).toEqual({ devices: 1, online: 1, today: 0 });
    // The relaxations of the session reads are exactly the three the fence knows.
    expect(Object.keys(SESSION_READ).sort()).toEqual([
      'invalidScope',
      'pausedSession',
      'stafflessMonitor',
    ]);
  });
});
