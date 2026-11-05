import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listAuditRows } from '../src/worker/modules/audit/repo.ts';
import { listBundleRows } from '../src/worker/modules/bundles/repo.ts';
import { listEvents } from '../src/worker/modules/events/repo.ts';
import { listPasses } from '../src/worker/modules/passes/repo-list.ts';
import { listUsers } from '../src/worker/modules/users/repo.ts';

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
            if (p === 'bind') {
              return (...params: unknown[]) => {
                seen.push({ sql, params });
                return t.bind(...params);
              };
            }
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

/** A bare `SCAN` (no index) reads the whole table; `SCAN ... USING INDEX` ordered by LIMIT is bounded. */
const fullScans = (lines: string[], table: string) =>
  lines.filter((l) => new RegExp(`^SCAN ${table}( |$)(?!.*USING)`).test(l));

describe('list and search query plans', () => {
  it('passes: an org and mode list uses an index', async () => {
    const lines = await plans((db) => listPasses(db, { orgId: 'o', mode: 'live', limit: 50 }));
    expect(fullScans(lines, 'passes')).toEqual([]);
  });

  it('bundles: an org list uses bundles_org, a platform list bundles_mode', async () => {
    const org = await plans((db) => listBundleRows(db, { orgScope: 'o', mode: 'live', limit: 50 }));
    expect(org.join('\n')).toContain('bundles_org');
    const pinned = await plans((db) =>
      listBundleRows(db, { orgScope: null, orgId: 'o', mode: 'test', limit: 50 }),
    );
    expect(pinned.join('\n')).toContain('bundles_org');
    const all = await plans((db) =>
      listBundleRows(db, { orgScope: null, mode: 'live', limit: 50 }),
    );
    expect(fullScans(all, 'bundles')).toEqual([]);
  });

  it('events: a pass ledger page uses an index', async () => {
    const lines = await plans((db) => listEvents(db, { passId: 'p', limit: 50 }));
    expect(fullScans(lines, 'pass_events')).toEqual([]);
  });

  it('passes: every filter and the search use an index', async () => {
    for (const filter of [
      { orgId: 'o' },
      { templateId: 't' },
      { connectionId: 'c' },
      { holderEmail: 'a@b.co' },
      { q: 'ab' },
      { orgId: 'o', q: 'ab' },
    ]) {
      const lines = await plans((db) => listPasses(db, { ...filter, limit: 50 }));
      expect(fullScans(lines, 'passes'), JSON.stringify(filter)).toEqual([]);
    }
  });

  it('passes: search merges one index search per column', async () => {
    const lines = await plans((db) => listPasses(db, { q: 'ab', limit: 50 })).then((l) =>
      l.join('\n'),
    );
    for (const index of [
      'passes_title_nc',
      'passes_subtitle_nc',
      'passes_external_nc',
      'passes_holder_nc',
      'passes_serial',
    ]) {
      expect(lines).toContain(index);
    }
  });

  it('audit: actor, action prefix, target and org filters use an index', async () => {
    for (const filter of [
      { actorId: 'a' },
      { action: 'pass.' },
      { orgId: 'o' },
      { targetType: 'pass', targetId: 'p' },
    ]) {
      const lines = await plans((db) => listAuditRows(db, filter, 50));
      expect(fullScans(lines, 'audit_log'), JSON.stringify(filter)).toEqual([]);
    }
  });

  it('users: search uses the NOCASE indexes', async () => {
    const lines = await plans((db) => listUsers(db, { q: 'ad', limit: 50 }));
    expect(fullScans(lines, 'users')).toEqual([]);
    expect(fullScans(lines, 'user_emails')).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('users_email_nc');
    expect(text).toContain('users_name_nc');
    expect(text).toContain('user_emails_nc');
  });
});
