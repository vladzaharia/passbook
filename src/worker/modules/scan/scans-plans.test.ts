import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listConsoleEvents } from './repo-events.ts';
import { listScanRows } from './repo-feed.ts';
import { listConsoleScanners } from './repo-scanners.ts';

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
  const scanFilters: [string, Parameters<typeof listScanRows>[1], string | null][] = [
    ['an org', { ...base, orgId: 'o' }, 'scans_org'],
    ['a scanner', { ...base, scannerId: 's' }, 'scans_scanner'],
    ['staff', { ...base, staffId: 'p' }, 'scans_staff'],
    ['an event', { ...base, eventId: 'e' }, 'scans_event'],
    ['a pass', { ...base, passId: 'x' }, 'scans_pass'],
    ['a window only', { ...base, from: 1, to: 2 }, 'scans_mode_at'],
    ['an outcome and reason', { ...base, orgId: 'o', outcome: 'refused', reason: 'voided' }, null],
    ['a cursor', { ...base, orgId: 'o', cursor: 'c' }, null],
  ];
  it.each(scanFilters)('scans: %s uses an index', async (_name, filter, index) => {
    const lines = await plans((db) => listScanRows(db, filter));
    expect(fullScans(lines, 's')).toEqual([]);
    expect(fullScans(lines, 'scans')).toEqual([]);
    if (index) expect(lines.join('\n')).toContain(index);
  });

  it('scans: the export count is bounded by an index', async () => {
    const { countScanRows } = await import('./repo-feed.ts');
    const lines = await plans((db) =>
      countScanRows(db, { ...base, orgId: 'o', from: 1, to: 2 }, 100_000),
    );
    expect(fullScans(lines, 's')).toEqual([]);
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
        listConsoleEvents(db, { mode: 'live', orgId: 'o', now: 5, limit: 51, status }),
      );
      expect(fullScans(lines, 'e')).toEqual([]);
      expect(lines.join('\n')).toContain('scan_events_org');
    }
  });
});
