import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tenantFilter } from '../../platform/authority-read.ts';
import { listConsoleEvents } from './repo-events.ts';
import { countScanRows, getScanRow, listScanRows, type ScanLogFilter } from './repo-feed.ts';
import type { ScanReadAuthority } from './repo-read-authority.ts';
import { listConsoleScanners } from './repo-scanners.ts';
import { readStaffActivity } from './repo-staff-activity.ts';

/** A fence whose actor is a fixed org and mode: only the plan of the read itself is under test. */
const fixedAuth: ScanReadAuthority = {
  ctes: `actor AS MATERIALIZED (SELECT 'o' AS org_id, 'live' AS mode, 1 AS actor_ok, 1 AS org_ok),
    actor_ok AS MATERIALIZED (SELECT org_id, mode FROM actor)`,
  params: [],
  ok: 'EXISTS (SELECT 1 FROM actor_ok)',
  tenant: (alias, table) => tenantFilter(alias, table, 'org_mode'),
};

/** A platform key naming no org: the mode only, as `apiKeyReadAuthority` gives it. */
const platformAuth: ScanReadAuthority = {
  ...fixedAuth,
  ctes: `actor AS MATERIALIZED (SELECT NULL AS org_id, 'live' AS mode, 1 AS actor_ok, 1 AS org_ok),
    actor_ok AS MATERIALIZED (SELECT org_id, mode FROM actor)`,
  tenant: (alias) => `${alias}.mode = (SELECT mode FROM actor_ok)`,
};

/** Runs a repo function against a DB that records its statements, then explains each one. */
async function plans(run: (db: D1Database) => Promise<unknown>): Promise<string[]> {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop, target).bind?.(target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(t, p) {
            if (p === 'bind')
              return (...params: unknown[]) => {
                seen.push({ sql, params });
                return t.bind(...params);
              };
            const value = Reflect.get(t, p, t);
            return typeof value === 'function' ? value.bind(t) : value;
          },
        });
      };
    },
  });
  await run(db);
  expect(seen.length).toBeGreaterThan(0);
  const out: string[] = [];
  for (const { sql, params } of seen) {
    const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    out.push(...rows.results.map((r) => r.detail));
  }
  return out;
}

/** A bare `SCAN <table>` reads the whole table; `SCAN ... USING INDEX` ordered by LIMIT is bounded. */
const fullScans = (lines: string[], table: string) =>
  lines.filter((l) => new RegExp(`^SCAN ${table}( |$)(?!.*USING)`).test(l));

const base = { mode: 'live', limit: 51 } as const;

describe('console list query plans (SC)', () => {
  const scanFilters: [string, ScanLogFilter, ScanReadAuthority, string | null][] = [
    ['an org', { ...base, orgId: 'o' }, fixedAuth, 'scans_org'],
    ['an org and a scanner', { ...base, orgId: 'o', scannerId: 's' }, fixedAuth, null],
    ['a scanner', { ...base, scannerId: 's' }, platformAuth, 'scans_scanner'],
    ['staff', { ...base, staffId: 'p' }, platformAuth, 'scans_staff'],
    ['an event', { ...base, eventId: 'e' }, platformAuth, 'scans_event'],
    ['a pass', { ...base, passId: 'x' }, platformAuth, 'scans_pass'],
    ['a window only', { ...base, from: 1, to: 2 }, platformAuth, 'scans_mode_at'],
    [
      'an outcome and reason',
      { ...base, orgId: 'o', outcome: 'refused', reason: 'voided' },
      fixedAuth,
      null,
    ],
    ['a position', { ...base, orgId: 'o', internalCursor: { at: 5, id: 'c' } }, fixedAuth, null],
  ];
  it.each(scanFilters)('scans: %s uses an index', async (_name, filter, auth, index) => {
    const lines = await plans((db) => listScanRows(db, auth, filter, 5));
    expect(fullScans(lines, 's')).toEqual([]);
    expect(fullScans(lines, 'scans')).toEqual([]);
    // The joins of the page are probes by key, never scans of a large table.
    for (const table of ['p', 'l', 'recorded', 'cw', 'sc', 'st', 'e'])
      expect(fullScans(lines, table), `SCAN ${table}`).toEqual([]);
    if (index) expect(lines.join('\n')).toContain(index);
  });

  it('scans: the detail of one scan is a primary key probe', async () => {
    const lines = await plans((db) => getScanRow(db, fixedAuth, 'x', 5));
    expect(fullScans(lines, 's')).toEqual([]);
    expect(fullScans(lines, 'scans')).toEqual([]);
  });

  it('scans: the export count is bounded by an index', async () => {
    const lines = await plans((db) =>
      countScanRows(db, fixedAuth, { ...base, orgId: 'o', from: 1, to: 2 }, 100_000),
    );
    expect(fullScans(lines, 's')).toEqual([]);
  });

  it('staff: the latest scan and day count of each person are index probes, never a scan of scans', async () => {
    for (const page of [{ limit: 50 }, { limit: 50, q: 'ana' }, { limit: 1, staffId: 'p' }]) {
      const lines = await plans((db) => readStaffActivity(db, fixedAuth, ['UTC'], 5, page));
      expect(fullScans(lines, 's')).toEqual([]);
      expect(fullScans(lines, 'scans')).toEqual([]);
      expect(lines.join('\n')).toContain('scans_staff');
    }
  });

  it('scanners: an org list, with each filter, uses an index', async () => {
    for (const extra of [
      {},
      { status: 'paired' as const },
      { eventId: 'e' },
      { q: 'door' },
      { cursor: 'c' },
    ]) {
      const lines = await plans((db) =>
        listConsoleScanners(db, { mode: 'live', orgId: 'o', limit: 51, ...extra }),
      );
      expect(fullScans(lines, 's')).toEqual([]);
      expect(lines.join('\n')).toMatch(/scanners_org|scanners_event/);
    }
  });

  it('events: an org list, with each status, uses scan_events_org', async () => {
    for (const status of [undefined, 'upcoming', 'live', 'ended', 'archived'] as const) {
      const lines = await plans((db) =>
        listConsoleEvents(db, fixedAuth, {
          now: 5,
          limit: 51,
          status,
        }),
      );
      expect(fullScans(lines, 'e')).toEqual([]);
      expect(lines.join('\n')).toContain('scan_events_org');
    }
  });
});
