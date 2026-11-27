import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listAuditRows } from '../src/worker/modules/audit/repo.ts';
import { listBundleRows } from '../src/worker/modules/bundles/repo.ts';
import {
  latestEntitlementAudit,
  recentEntitlementOrgs,
} from '../src/worker/modules/channels/repo-entitlement-sweep.ts';
import { deleteOldWebhookEvents } from '../src/worker/modules/connections/repo-sync.ts';
import { listEvents } from '../src/worker/modules/events/repo.ts';
import { listSweepWaitingPasses } from '../src/worker/modules/holders/repo.ts';
import { portfolioSnapshot } from '../src/worker/modules/me/repo.ts';
import { activeBinding, lostBinding } from '../src/worker/modules/nfc/repo-tag-bindings.ts';
import { listTags, passTagViews, tagByRef } from '../src/worker/modules/nfc/repo-tags.ts';
import { orgUsage, plansOf } from '../src/worker/modules/orgs/repo-usage.ts';
import { versionsToPurge } from '../src/worker/modules/passes/repo.ts';
import { upsertAsset } from '../src/worker/modules/passes/repo-history-assets.ts';
import { livePassesBy } from '../src/worker/modules/passes/repo-import-lookup.ts';
import { listPasses } from '../src/worker/modules/passes/repo-list.ts';
import { expiredTestPasses } from '../src/worker/modules/sandbox/repo.ts';
import {
  countsRead,
  insideReads,
  revsRead,
  runReads,
} from '../src/worker/modules/scan/occupancy/repo-reads.ts';
import { expectedCount } from '../src/worker/modules/scan/repo-counts-query.ts';
import { eventTotalsStmt } from '../src/worker/modules/scan/repo-event-attendance.ts';
import { capacityFullPredicate } from '../src/worker/modules/scan/repo-gates.ts';
import { backfillCandidates } from '../src/worker/modules/scan/repo-lookup-backfill.ts';
import { orgZoneRows, sessionZoneIds } from '../src/worker/modules/scan/repo-zones.ts';
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
import { listFeed } from '../src/worker/modules/webhooks/repo-feed.ts';
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

describe('list and search query plans', () => {
  it('passes: an org and mode list uses an index', async () => {
    const lines = await plans((db) => listPasses(db, { orgId: 'o', mode: 'live', limit: 50 }));
    expect(fullScans(lines, 'passes')).toEqual([]);
  });

  it('passes: an input match stays on the template index', async () => {
    const lines = await plans((db) =>
      listPasses(db, {
        orgId: 'o',
        mode: 'live',
        templateId: 't',
        match: [{ input: 'gate', values: ['A'] }],
        limit: 50,
      }),
    );
    expect(fullScans(lines, 'passes')).toEqual([]);
    expect(lines.join('\n')).toMatch(/SEARCH passes USING INDEX/);
  });

  it('imports: the match lookups use the external id and holder email indexes', async () => {
    for (const column of ['external_id', 'holder_email'] as const) {
      const lines = await plans((db) => livePassesBy(db, 'o', 'live', column, ['a', 'b']));
      expect(fullScans(lines, 'passes'), column).toEqual([]);
    }
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

  it('pass imports: the expiry sweep and the committing guard use their partial indexes', async () => {
    const sweep = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pass_imports WHERE expires_at < ? AND state IN ('mapping', 'checking', 'ready', 'stale')",
    )
      .bind(1)
      .all<{ detail: string }>();
    expect(sweep.results.map((r) => r.detail).join('\n')).toContain('pass_imports_expiry');
    const running = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pass_imports WHERE org_id = ? AND mode = ? AND template_id = ? AND state = 'committing'",
    )
      .bind('o', 'live', 't')
      .all<{ detail: string }>();
    expect(running.results.map((r) => r.detail).join('\n')).toContain('pass_imports_one_running');
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

/** `verified` walks `live` and probes the ledger by primary key per witness; no ledger index scan. */
function expectLedgerByLiveWitness(text: string, label?: string) {
  const verified = text.slice(text.indexOf('MATERIALIZE verified'));
  const walk = verified.indexOf('SCAN live');
  expect(walk, label).toBeGreaterThan(-1);
  expect(verified.slice(walk), label).toContain(
    'SEARCH witness USING INDEX sqlite_autoindex_scans_1 (id=?)',
  );
  expect(verified, label).not.toContain('scans_pass_ok');
  expect(verified, label).not.toContain('AUTOMATIC');
}

describe('scan and template sweep plans', () => {
  it('event totals read the ledger only for live witnesses, by primary key', async () => {
    const lines = await plans((db) => eventTotalsStmt(db, 'o', 'live', 'e').first());
    expect(fullScans(lines, 'scans')).toEqual([]);
    expectLedgerByLiveWitness(lines.join('\n'));
  });

  it('capacity reads the ledger only for live witnesses, by primary key', async () => {
    for (const reentry of [false, true]) {
      const { sql, params } = capacityFullPredicate('o', 'live', 'e', 10, reentry, 'p');
      const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      const lines = rows.results.map((r) => r.detail);
      expect(fullScans(lines, 'scans'), String(reentry)).toEqual([]);
      expectLedgerByLiveWitness(lines.join('\n'), String(reentry));
    }
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

describe('zone query plans', () => {
  it('zones read by org, links by session, and the scans zone index serves the log filter', async () => {
    const zones = await plans((db) => orgZoneRows(db, 'o'));
    expect(zones.join('\n')).toContain('USING INDEX scan_zones_org_key');
    expect(fullScans(zones, 'scan_zones')).toEqual([]);
    const links = await plans((db) => sessionZoneIds(db, 'o', 's'));
    expect(fullScans(links, 'scanning_session_zones')).toEqual([]);
    const log = await plans(async (db) => {
      await db
        .prepare('SELECT id FROM scans WHERE zone_id = ? ORDER BY at DESC LIMIT 50')
        .bind('z')
        .all();
    });
    expect(log.join('\n')).toContain('USING INDEX scans_zone');
  });
});

describe('occupancy query plans', () => {
  it('In now reads the inside index only; the inside list and revisions use indexes', async () => {
    const counts = await plans((db) =>
      runReads(db, [countsRead('o', 'live', ['zone:a', 'zone:b'], 1)]),
    );
    expect(counts.join('\n')).toContain('USING COVERING INDEX scan_presence_inside');
    expect(counts.join('\n')).not.toMatch(/passes/);
    expect(fullScans(counts, 'x')).toEqual([]);
    const after = { since: 1, passId: 'p' };
    const list = await plans((db) =>
      runReads(db, insideReads('o', 'live', 'zone:a', 1, { after, limit: 10 })),
    );
    expect(list.join('\n')).toContain('scan_presence_list');
    expect(list.join('\n')).not.toMatch(/TEMP B-TREE|passes/);
    expect(fullScans(list, 'x')).toEqual([]);
    const revs = await plans((db) => runReads(db, [revsRead('o', 'live', ['zone:a'])]));
    expect(fullScans(revs, 'scan_place_revs')).toEqual([]);
  });
});

describe('keyset cursors seek the index', () => {
  const after = 'a';

  it.each([
    [
      'holder sweep',
      (db: D1Database) => listSweepWaitingPasses(db, { after, upper: 'z' }, 10),
      'passes_waiting_holder (id>? AND id<?)',
    ],
    [
      'lookup backfill',
      (db: D1Database) => backfillCandidates(db, after, 10),
      'sqlite_autoindex_passes_1 (id>?)',
    ],
    [
      'dirty wallet instances',
      (db: D1Database) => listDirtyInstances(db, 1, 10, after),
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

describe('tag lookups', () => {
  it('a tag by ref uses the unique (org, mode, ref) key and its bindings use their indexes', async () => {
    const byRef = (await plans((db) => tagByRef(db, 'o', 'live', 'r'))).join('\n');
    expect(byRef).toMatch(/sqlite_autoindex_nfc_tags_\d \(org_id=\? AND mode=\? AND tag_ref=\?\)/);
    expect((await plans((db) => activeBinding(db, 't'))).join('\n')).toMatch(
      /tag_bindings_(active|tag_last)/,
    );
    expect((await plans((db) => lostBinding(db, 't'))).join('\n')).toContain(
      'tag_bindings_tag_last',
    );
  });

  it('the list and a pass`s tags use indexes, not a scan of the tag table', async () => {
    const list = await plans((db) => listTags(db, { orgId: 'o', mode: 'live', limit: 50 }));
    expect(fullScans(list, 'nfc_tags')).toEqual([]);
    expect(list.join('\n')).toContain('nfc_tags_list');
    const pass = await plans((db) =>
      passTagViews(db, { id: 'p', orgId: 'o', mode: 'live', ownerUserId: 'u' }),
    );
    expect(fullScans(pass, 'tag_bindings')).toEqual([]);
    expect(fullScans(pass, 'nfc_tags')).toEqual([]);
    expect(pass.join('\n')).toMatch(/tag_bindings_pass/);
    expect(pass.join('\n')).toMatch(/tag_bindings_user/);
  });
});

describe('outbound webhook query plans', () => {
  const fence = { orgId: 'o', mode: 'live' as const };

  it.each([
    ['feed', { after: 5, limit: 50 }, 'USING INDEX event_feed_org (org_id=? AND mode=? AND seq>?)'],
    [
      'feed by type',
      { after: 5, types: ['pass.scanned', 'pass.issued'], limit: 50 },
      'USING INDEX event_feed_org (org_id=? AND mode=? AND seq>?)',
    ],
    ['feed by pass', { after: 5, passId: 'p', limit: 50 }, 'event_feed'],
  ])('%s: an index search, no full scan of the journal', async (_name, query, index) => {
    const lines = await plans((db) => listFeed(db, fence, query));
    expect(fullScans(lines, 'event_feed')).toEqual([]);
    expect(lines.join('\n')).toContain(index);
  });

  it('the journal trigger: both of its inserts search indexes, and the fan-out reads at most 10 endpoints', async () => {
    const trigger = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'pass_events_feed'",
    ).first<{ sql: string }>();
    const body = trigger?.sql.slice(
      trigger.sql.indexOf('BEGIN') + 5,
      trigger.sql.lastIndexOf('END'),
    );
    expect(body).toBeTruthy();
    const literals: Record<string, string> = {
      id: "'ev'",
      org_id: "'o'",
      pass_id: "'p'",
      mode: "'live'",
      kind: "'pass.issued'",
      device: 'NULL',
      actor_type: 'NULL',
      data: "'{}'",
      at: '1',
    };
    const inserts = (body ?? '')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.replace(/NEW\.(\w+)/g, (_m, column: string) => literals[column] ?? 'NULL'));
    expect(inserts).toHaveLength(2);
    const lines: string[] = [];
    for (const insert of inserts) {
      const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${insert}`).all<{ detail: string }>();
      lines.push(...rows.results.map((r) => r.detail));
    }
    const text = lines.join('\n');
    expect(text).toContain('webhook_endpoints_org (org_id=? AND mode=? AND status=?)');
    expect(text).toContain('sqlite_autoindex_event_feed_1 (event_id=?)');
    for (const table of [
      'webhook_endpoints',
      'event_feed',
      'passes',
      'registrations',
      'settings',
      'pass_simulated_devices',
    ])
      expect(fullScans(lines, table), table).toEqual([]);
  });

  it('the fan-out select reads the new feed row by its unique event id', async () => {
    const rows = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT e.id, f.seq FROM event_feed f
       JOIN webhook_endpoints e ON e.org_id = f.org_id AND e.mode = f.mode
       WHERE f.event_id = ? AND e.status IN ('active', 'paused')`,
    )
      .bind('x')
      .all<{ detail: string }>();
    const text = rows.results.map((r) => r.detail).join('\n');
    expect(text).toContain('sqlite_autoindex_event_feed_1 (event_id=?)');
    expect(text).toContain('webhook_endpoints_org');
  });

  it('the due scan and the lane loop use the partial indexes', async () => {
    const plan = async (sql: string, ...params: (string | number)[]) =>
      (
        await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...params)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join('\n');
    expect(
      await plan(
        "SELECT endpoint_id FROM webhook_deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 100",
        1,
      ),
    ).toContain('webhook_deliveries_due_all');
    expect(
      await plan(
        "SELECT event_seq FROM webhook_deliveries WHERE state = 'pending' AND next_at <= ? AND endpoint_id = ? ORDER BY next_at, event_seq LIMIT 20",
        1,
        'e',
      ),
    ).toContain('webhook_deliveries_due');
  });
});

describe('entitlement journal sweep query plans', () => {
  it('reads the newest org audit row from audit_target, not the whole org log', async () => {
    const lines = await plans((db) => latestEntitlementAudit(db, 'o'));
    expect(lines.join('\n')).toContain('audit_target');
    expect(lines.join('\n')).not.toContain('USING INDEX audit_org');
  });

  it('finds the orgs changed in the window from the updated_at index', async () => {
    const lines = await plans((db) => recentEntitlementOrgs(db, 1, 2, 200));
    const plan = lines.join('\n');
    expect(plan).toContain('org_entitlements_updated');
    // Every table is reached through an index: nothing scans runs, passes, overrides or presets per org.
    expect(plan).toContain('passes_scan_population');
    expect(plan).toContain('channel_apply_runs_cover');
    for (const table of [
      'org_entitlements',
      'passes',
      'channel_apply_runs',
      'org_entitlement_overrides',
    ])
      expect(fullScans(lines, table), `${table}\n${plan}`).toEqual([]);
  });
});

describe('org usage query plans', () => {
  it('counts each limit through an index: no subquery scans a table', async () => {
    const lines = await plans((db) => orgUsage(db, 'o', 1));
    const plan = lines.join('\n');
    // The plan names tables by their alias in the statement; each of the eight counts is an index search.
    for (const alias of ['p', 't', 'sc', 'm', 'i', 'k', 'we', 'cn'])
      expect(plan, alias).toMatch(new RegExp(`SEARCH ${alias} USING (COVERING )?INDEX`));
    expect(
      lines.filter((l) => /^SCAN /.test(l) && !/USING/.test(l)),
      plan,
    ).toEqual([]);
  });

  it('reads an org list plans by the org key', async () => {
    const lines = await plans((db) => plansOf(db, ['a', 'b']));
    expect(fullScans(lines, 'org_entitlements')).toEqual([]);
  });
});
