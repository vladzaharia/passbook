// The cutover on production-shaped data the base seed lacks (production-seed.ts): each shape must survive
// migrate, bootstrap, baked sync and the backfills.
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveSession } from '../../src/worker/modules/auth/sessions.ts';
import { sealCapabilityTokens } from '../../src/worker/modules/passes/token-seal.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import { createJobContext } from '../../src/worker/platform/service-context.ts';
import { LEGACY_ASSET_KEY, LEGACY_COOKIE, LEGACY_PHOTO_KEY } from './production-seed.ts';
import { type Cutover, NOW, runCutover } from './setup.ts';

let c: Cutover;
let db: D1Database;
beforeAll(async () => {
  c = await runCutover(27, { production: true });
  db = c.legacy.db;
});

const rows = async <T>(sql: string, ...params: (string | number)[]) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
const one = async <T>(sql: string, ...params: (string | number)[]) =>
  (await rows<T>(sql, ...params))[0];

describe('production shapes: passes', () => {
  it('quarantines test passes and excludes their scans; live passes stay unquarantined', async () => {
    expect(
      await rows(
        "SELECT id, test_data_quarantined AS q FROM passes WHERE id LIKE 'prod-%' ORDER BY id",
      ),
    ).toEqual(
      expect.arrayContaining([
        { id: 'prod-test-1', q: 1 },
        { id: 'prod-test-2', q: 1 },
        { id: 'prod-live-1', q: 0 },
        { id: 'prod-removed', q: 0 },
      ]),
    );
    expect(await rows('SELECT scan_id FROM scan_quarantine_exclusions')).toEqual([
      { scan_id: 'scan-test-1' },
    ]);
    // The sandbox capture and the test scanner are kept.
    expect(await one('SELECT recipient FROM captured_emails WHERE id = ?', 'cap-1')).toEqual({
      recipient: 'tester@example.com',
    });
    expect(await one("SELECT mode FROM scanners WHERE id = 'sc-test'")).toEqual({ mode: 'test' });
  });

  it('marks removed and half-removed passes as published at their generation, and keeps their state', async () => {
    const removed = await rows<Record<string, unknown>>(
      `SELECT id, status, removed_at, removal_prior_status, lifecycle_generation AS gen, removal_published_generation AS pub
       FROM passes WHERE id IN ('prod-removed', 'prod-half-removed') ORDER BY id`,
    );
    expect(removed).toEqual([
      {
        id: 'prod-half-removed',
        status: 'active',
        removed_at: expect.any(Number),
        removal_prior_status: 'active',
        gen: 0,
        pub: 0,
      },
      {
        id: 'prod-removed',
        status: 'voided',
        removed_at: expect.any(Number),
        removal_prior_status: 'active',
        gen: 0,
        pub: 0,
      },
    ]);
    const live = await one<{ pub: number | null }>(
      "SELECT removal_published_generation AS pub FROM passes WHERE id = 'prod-live-1'",
    );
    expect(live?.pub).toBeNull();
  });

  it('keeps the version history and moves no row_version when the seal scrubs it', async () => {
    const before = await rows<{ version: number }>(
      "SELECT version FROM pass_versions WHERE pass_id = 'prod-history' ORDER BY version",
    );
    expect(before.map((r) => r.version)).toEqual([1, 2, 3]);
    const versions = () =>
      rows("SELECT id, row_version FROM passes WHERE id LIKE 'prod-%' ORDER BY id");
    const rv = await versions();
    const ctx = createJobContext(c.env, 'cron', { clock: new ManualClock(NOW + 10_000) });
    for (let run = 0; run < 4; run++) await sealCapabilityTokens(ctx);
    expect(
      await rows(
        "SELECT version FROM pass_versions WHERE pass_id = 'prod-history' ORDER BY version",
      ),
    ).toEqual(before);
    expect(
      await one(
        "SELECT count(*) AS n FROM pass_versions WHERE pass_id LIKE 'prod-%' AND pass_json LIKE '%authenticationToken%'",
      ),
    ).toEqual({ n: 0 });
    expect(await versions()).toEqual(rv);
  });

  it('keeps a suspended org suspended and gives the owner a membership in it', async () => {
    expect(await one("SELECT status FROM orgs WHERE id = 'org-susp'")).toEqual({
      status: 'suspended',
    });
    expect(
      await one(
        "SELECT roles FROM org_memberships WHERE org_id = 'org-susp' AND user_id = 'u-owner' AND revoked_at IS NULL",
      ),
    ).toEqual({ roles: '["org_admin"]' });
    expect(await one("SELECT status, org_id FROM passes WHERE id = 'prod-susp-1'")).toEqual({
      status: 'active',
      org_id: 'org-susp',
    });
  });

  it('keeps the org-owned signing identity, its credential and the pass signed by it', async () => {
    expect(
      await one(
        "SELECT i.org_id, i.source, i.credential_id, c.fingerprint FROM signing_identities i JOIN credentials c ON c.id = i.credential_id WHERE i.id = 'ident-own'",
      ),
    ).toEqual({ org_id: 'org-a', source: 'db', credential_id: 'cred-own', fingerprint: 'fp-own' });
    expect(await one("SELECT identity_id FROM passes WHERE id = 'prod-own-1'")).toEqual({
      identity_id: 'ident-own',
    });
  });
});

describe('production shapes: other tables', () => {
  it('keeps the connection, its items, inbox and runs', async () => {
    expect(
      await one(
        "SELECT connector_type, generation, health, cursor FROM connections WHERE id = 'conn-1'",
      ),
    ).toEqual({
      connector_type: 'http-json',
      generation: 4,
      health: 'healthy',
      cursor: 'cursor-1',
    });
    expect(
      await rows("SELECT id, external_ref FROM passes WHERE connection_id = 'conn-1' ORDER BY id"),
    ).toEqual([
      { id: 'prod-item-1', external_ref: 'member-1' },
      { id: 'prod-item-2', external_ref: 'member-2' },
    ]);
    expect(
      await one("SELECT count(*) AS n FROM connection_inbox WHERE connection_id = 'conn-1'"),
    ).toEqual({ n: 1 });
    expect(
      await one("SELECT outcome, passes_changed FROM connection_runs WHERE id = 'run-1'"),
    ).toEqual({
      outcome: 'changed',
      passes_changed: 2,
    });
  });

  it('keeps broadcasts as they were, the due scheduled one included (nothing runs before the promote)', async () => {
    expect(await rows('SELECT id, state FROM broadcasts ORDER BY id')).toEqual([
      { id: 'bc-draft', state: 'draft' },
      { id: 'bc-due', state: 'scheduled' },
      { id: 'bc-sent', state: 'sent' },
    ]);
    expect(
      await rows(
        "SELECT pass_id, outcome, silent FROM broadcast_items WHERE broadcast_id = 'bc-sent' ORDER BY pass_id",
      ),
    ).toEqual([
      { pass_id: 'prod-live-1', outcome: 'updated', silent: 0 },
      { pass_id: 'prod-live-2', outcome: 'failed', silent: 1 },
    ]);
  });

  it('keeps scanning sessions and devices, and starts their config epochs', async () => {
    expect(
      await one("SELECT name, status, settings FROM scanning_sessions WHERE id = 'ss-1'"),
    ).toEqual({
      name: 'Front door',
      status: 'active',
      settings: '{"flow":"auto"}',
    });
    expect(
      await one(
        "SELECT session_id, surface, overrides, device_key FROM scanning_devices WHERE scanner_id = 'sc-uploaded-active'",
      ),
    ).toEqual({
      session_id: 'ss-1',
      surface: 'auto',
      overrides: '{"sound":false}',
      device_key: 'dk-1',
    });
    const epoch = await one<{ e: number }>(
      "SELECT config_epoch AS e FROM scanning_sessions WHERE id = 'ss-1'",
    );
    expect(epoch?.e).toBeGreaterThanOrEqual(1);
  });

  it('keeps pass assets, the member photo and their R2 objects', async () => {
    expect(await one("SELECT r2_key, size FROM pass_assets WHERE pass_id = 'prod-live-1'")).toEqual(
      {
        r2_key: LEGACY_ASSET_KEY,
        size: 3,
      },
    );
    expect(
      await one(
        "SELECT r2_key, include_in_pass AS inc FROM member_photos WHERE pass_id = 'prod-live-1'",
      ),
    ).toEqual({
      r2_key: LEGACY_PHOTO_KEY,
      inc: 1,
    });
    for (const key of [LEGACY_ASSET_KEY, LEGACY_PHOTO_KEY])
      expect(await c.env.BUCKET.head(key), key).not.toBeNull();
  });

  it('binds an enqueued push and leaves a processing one; both emails stay as queued', async () => {
    const queue = await rows<{
      id: string;
      state: string;
      payload: string;
      coalesce_key: string | null;
    }>("SELECT id, state, payload, coalesce_key FROM outbox WHERE id LIKE 'q-%' ORDER BY id");
    const by = new Map(queue.map((r) => [r.id, r]));
    const enq = by.get('q-push-enq');
    expect(enq?.state).toBe('enqueued');
    expect(JSON.parse(enq?.payload ?? '{}')).toMatchObject({
      reason: 'publish',
      identityId: 'platform',
    });
    expect(enq?.coalesce_key).toMatch(/^push:/);
    // A row a consumer holds is not rebound: the old Worker's lease finishes it (verify-outbox lists it before step 2).
    const proc = by.get('q-push-proc');
    expect(proc).toMatchObject({ state: 'processing', payload: '{}', coalesce_key: null });
    for (const id of ['q-mail-enq', 'q-mail-proc'])
      expect(by.get(id)?.state, id).toBe(id.endsWith('enq') ? 'enqueued' : 'processing');
  });
});

describe('production shapes: ledger and sessions', () => {
  it('has no legacy scan event that blocks the credential keyset', async () => {
    expect(
      await one(
        "SELECT count(*) AS n FROM pass_events WHERE kind LIKE 'scan.%' AND id LIKE 'ev-prod-%'",
      ),
    ).toEqual({ n: 5 });
    expect(await one('SELECT count(*) AS n FROM credential_ref_keyset_blocking_events')).toEqual({
      n: 0,
    });
  });

  it('the blocking view does see a credential-shaped key', async () => {
    const blocking = () => one('SELECT count(*) AS n FROM credential_ref_keyset_blocking_events');
    await db
      .prepare(
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
         VALUES ('ev-control', 'org-a', 'prod-live-1', 'live', 'scan.checked_in', '{"scanCode":"x"}', ${NOW})`,
      )
      .run();
    expect(await blocking()).toEqual({ n: 1 });
    await db.prepare("DELETE FROM pass_events WHERE id = 'ev-control'").run();
    expect(await blocking()).toEqual({ n: 0 });
  });

  it('reads a session the old Worker issued, with its roles and csrf secret, and slides it', async () => {
    const session = await resolveSession(c.env, new ManualClock(NOW), LEGACY_COOKIE);
    expect(session).toMatchObject({
      kind: 'session',
      userId: 'u-admin2',
      roles: ['admin', 'user'],
      amr: 'magic_link',
      csrfSecret: 'legacy-csrf',
    });
    expect(await resolveSession(c.env, new ManualClock(NOW), 'not-the-cookie')).toBeNull();
  });
});
