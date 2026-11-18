import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listAuditRows } from '../src/worker/modules/audit/repo.ts';
import { listBundleRows } from '../src/worker/modules/bundles/repo.ts';
import { deleteOldWebhookEvents } from '../src/worker/modules/connections/repo-sync.ts';
import { listEvents } from '../src/worker/modules/events/repo.ts';
import { listSweepWaitingPasses } from '../src/worker/modules/holders/repo.ts';
import { portfolioSnapshot } from '../src/worker/modules/me/repo.ts';
import { versionsToPurge } from '../src/worker/modules/passes/repo.ts';
import { upsertAsset } from '../src/worker/modules/passes/repo-history-assets.ts';
import { listPasses } from '../src/worker/modules/passes/repo-list.ts';
import { plainBundles, plainPasses } from '../src/worker/modules/passes/repo-token-seal.ts';
import { expiredTestPasses } from '../src/worker/modules/sandbox/repo.ts';
import { expectedCount } from '../src/worker/modules/scan/repo-counts-query.ts';
import { eventTotalsStmt } from '../src/worker/modules/scan/repo-event-attendance.ts';
import { backfillCandidates } from '../src/worker/modules/scan/repo-lookup-backfill.ts';
import {
  olderLivePasses,
  quietUnqueuedTemplates,
} from '../src/worker/modules/templates/repo-stale.ts';
import { listUsers } from '../src/worker/modules/users/repo.ts';
import { listDirtyInstances } from '../src/worker/modules/wallet-providers/repo-instance.ts';
import {
  beginSamsungSyncTarget,
  finishSamsungSyncTarget,
} from '../src/worker/modules/wallet-providers/repo-sync-targets.ts';
import { createDetachedContext } from '../src/worker/platform/service-context.ts';

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

describe('token seal work lists', () => {
  it.each([
    [
      'download tokens',
      (db: D1Database) => plainPasses(db, 'download_token', null, 50),
      'passes_token_plain',
    ],
    [
      'device tokens',
      (db: D1Database) => plainPasses(db, 'auth_token', 'a', 50),
      'passes_auth_plain',
    ],
    ['bundle tokens', (db: D1Database) => plainBundles(db, null, 50), 'bundles_token_plain'],
  ])('%s: the partial index serves the work list', async (_name, run, index) => {
    const lines = await plans(run);
    expect(
      lines.some((l) => l.includes(`USING INDEX ${index}`)),
      lines.join('\n'),
    ).toBe(true);
  });
});

describe('list and search query plans', () => {
  it('passes: an org and mode list uses an index', async () => {
    const lines = await plans((db) => listPasses(db, { orgId: 'o', mode: 'live', limit: 50 }));
    expect(fullScans(lines, 'passes')).toEqual([]);
  });

  it('bundles: organization lists use bundles_org in each mode', async () => {
    for (const mode of ['live', 'test'] as const) {
      const org = await plans((db) => listBundleRows(db, { orgId: 'o', mode, limit: 50 }));
      expect(org.join('\n')).toContain('bundles_org');
    }
  });

  it('events: a pass ledger page uses an index', async () => {
    const lines = await plans((db) =>
      listEvents(db, { passId: 'p', limit: 50, fence: { orgId: 'org', mode: null } }),
    );
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

  it('scans: the ok-only history reads use the partial index', async () => {
    const rows = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT at FROM scans WHERE pass_id = ? AND action_kind = 'check_in' AND outcome = 'ok' ORDER BY at DESC LIMIT 5",
    )
      .bind('p')
      .all<{ detail: string }>();
    const lines = rows.results.map((r) => r.detail);
    expect(fullScans(lines, 'scans')).toEqual([]);
    expect(lines.join('\n')).toContain('scans_pass_ok');
  });

  it('passes: the holder sweep, the quiet-template sweep and the expected count use partial indexes', async () => {
    const sweep = await plans((db) => listSweepWaitingPasses(db, { after: null, upper: 'z' }, 10));
    expect(sweep.join('\n')).toContain('passes_waiting_holder');
    const quiet = await plans((db) => quietUnqueuedTemplates(db, 1, 10));
    expect(quiet.join('\n')).toContain('passes_active_scope');
    expect(quiet.join('\n')).not.toContain('USE TEMP B-TREE FOR DISTINCT');
    const count = await plans((db) =>
      expectedCount(
        db,
        { orgId: 'o', mode: 'live', matchInput: null, matchValues: null },
        ['t'],
        1,
      ),
    );
    expect(count.join('\n')).toContain(
      'passes_scan_population (org_id=? AND mode=? AND template_id=?)',
    );
  });
});

describe('scan and template sweep plans', () => {
  it('event totals read the ledger only for live witnesses, by primary key', async () => {
    const lines = await plans((db) => eventTotalsStmt(db, 'o', 'live', 'e').first());
    expect(fullScans(lines, 'scans')).toEqual([]);
    const text = lines.join('\n');
    expect(text.indexOf('MATERIALIZE live')).toBeLessThan(text.indexOf('MATERIALIZE common'));
    const common = text.slice(
      text.indexOf('MATERIALIZE common'),
      text.indexOf('MATERIALIZE candidate'),
    );
    expect(common).toContain('SEARCH witness USING INDEX sqlite_autoindex_scans_1 (id=?)');
    expect(common).toContain('LIST SUBQUERY');
  });

  it('olderLivePasses: scope and join use passes_active_scope, never a passes scan', async () => {
    for (const orgId of [undefined, 'o']) {
      const lines = await plans((db) => olderLivePasses(db, 't', 'live', orgId));
      expect(fullScans(lines, 'passes'), String(orgId)).toEqual([]);
      const text = lines.join('\n');
      expect(text).toMatch(/SEARCH passes USING INDEX passes_active_scope \(template_id=\?/);
      expect(text).toContain(
        'SEARCH p USING INDEX passes_active_scope (template_id=? AND org_id=? AND mode=?)',
      );
    }
  });
});

describe('sweep and retention plans', () => {
  it('me: reissue notices start from the user index, not the waiting-holder passes', async () => {
    const text = (await plans((db) => portfolioSnapshot(db, 'u', []))).join('\n');
    expect(text).toContain('pass_holder_reissue_required_user (user_id=?)');
    expect(text).not.toContain('passes_waiting_holder');
  });

  it('pass versions: the purge probes by offset and a slot upsert reads one key', async () => {
    const purge = await plans((db) => versionsToPurge(db, 5, 10));
    expect(purge.join('\n')).toContain('CO-ROUTINE');
    const asset = {
      name: 'icon.png',
      r2Key: 'k',
      sha1: 's',
      size: 1,
      width: null,
      height: null,
      crc32: null,
      createdAt: 1,
    };
    const lines = await plans((db) =>
      // The insert has no pass to attach to; the read before it is what the plan covers.
      upsertAsset(db, 'p', asset).catch(() => null),
    );
    expect(lines.join('\n')).toContain('sqlite_autoindex_pass_assets_1 (pass_id=? AND name=?)');
  });

  it('samsung sync targets: begin and finish search by the claim operation', async () => {
    const claim = {
      instanceId: 'i',
      orgId: 'o',
      mode: 'live',
      provider: 'samsung',
      version: 1,
      claimHandle: 'h'.repeat(40),
      now: 1,
      credentialKeysetCommitment: 'a'.repeat(64),
    } as never;
    const ctx = (db: D1Database) =>
      createDetachedContext({ ...env, DB: db } as never, { clock: { now: () => 5 } as never });
    const begin = await plans((db) => beginSamsungSyncTarget(ctx(db), claim, 'US'));
    const finish = await plans((db) =>
      finishSamsungSyncTarget(ctx(db), claim, 'US', { kind: 'success' }),
    );
    for (const lines of [begin, finish]) {
      const text = lines.join('\n');
      expect(text).toContain(
        'SEARCH t USING INDEX sqlite_autoindex_wallet_provider_sync_targets_1 (operation_id=? AND country_code=?)',
      );
      expect(text).not.toContain('wallet_provider_sync_targets_due');
    }
  });

  it('connection retention: the failed-payload sweep reads by state and age', async () => {
    const ctx = (db: D1Database) =>
      createDetachedContext({ ...env, DB: db } as never, { clock: { now: () => 5 } as never });
    const lines = await plans((db) => deleteOldWebhookEvents(ctx(db) as never, 1, 1));
    expect(lines.join('\n')).toContain(
      'connection_webhook_retention_expiry (state=? AND updated_at<?)',
    );
    expect(fullScans(lines, 'connection_webhook_retention')).toEqual([]);
  });
});

describe('keyset cursors seek the index', () => {
  const after = 'a';
  const commitment = 'a'.repeat(64);

  it.each([
    [
      'holder sweep',
      (db: D1Database) => listSweepWaitingPasses(db, { after, upper: 'z' }, 10),
      'passes_waiting_holder (id>? AND id<?)',
    ],
    [
      'plain download tokens',
      (db: D1Database) => plainPasses(db, 'download_token', after, 10),
      'passes_token_plain (id>?)',
    ],
    [
      'plain bundle tokens',
      (db: D1Database) => plainBundles(db, after, 10),
      'bundles_token_plain (id>?)',
    ],
    [
      'lookup backfill',
      (db: D1Database) => backfillCandidates(db, after, 10),
      'sqlite_autoindex_passes_1 (id>?)',
    ],
    [
      'dirty wallet instances',
      (db: D1Database) => listDirtyInstances(db, 1, 10, after, commitment),
      'sqlite_autoindex_wallet_provider_instances_1 (id>?)',
    ],
    [
      'bundle list',
      (db: D1Database) =>
        listBundleRows(db, { orgId: 'o', mode: 'live', cursor: after, limit: 10 }),
      'bundles_org (org_id=? AND mode=? AND id<?)',
    ],
    [
      'expired test passes',
      (db: D1Database) => expiredTestPasses(db, 5, 10, { after: { createdAt: 3, id: after } }),
      'passes_test_age (created_at>? AND created_at<?)',
    ],
  ])('%s: the cursor is a range on the index', async (_name, run, range) => {
    const text = (await plans(run)).join('\n');
    expect(text).toContain(range);
  });
});
