// Production cutover rehearsal: a 0024 database with every template shape, migrated forward, bootstrapped
// and baked-synced, then checked for effective releases and lost data.
import { beforeAll, describe, expect, it } from 'vitest';
import operations from '../../docs/operations.md?raw';
import { effectiveReleaseIdSql } from '../../src/worker/modules/templates/repo-release-heads.ts';
import { dataFingerprint, type Legacy, MOVED_AWAY_PASS, OWNER, SHAPES } from './legacy-seed.ts';
import { runBootstrap } from './run-bootstrap.ts';
import { type Cutover, effective, NOW, runCutover, TABLES } from './setup.ts';

let c: Cutover;
let legacy: Legacy;
beforeAll(async () => {
  c = await runCutover(30);
  legacy = c.legacy;
});

describe('cutover: effective releases', () => {
  for (const shape of SHAPES.filter((s) => s !== 'uploaded-archived')) {
    it(`${shape}: every live pass has an effective release after the baked sync`, async () => {
      const passes = legacy.passes.filter((p) => p.shape === shape);
      for (const p of passes) {
        const row = await effective(legacy.db, p.id);
        expect(row?.id, `${shape} ${p.id} (before sync: ${c.beforeSync[p.id]})`).toBeTruthy();
      }
    });
  }

  it.each([
    ['baked-assigned-empty', 'baked:acme-spare', 'org-a'],
    ['uploaded-empty', 'up-empty', 'org-b'],
  ])(
    '%s: a template with no passes still has an effective release in its org',
    async (_shape, templateId, orgId) => {
      const row = await legacy.db
        .prepare(
          `SELECT (${effectiveReleaseIdSql({ templateIdSql: '?1', orgIdSql: '?2', modeSql: "'live'", providerSql: "'apple'" })}) AS id`,
        )
        .bind(templateId, orgId)
        .first<{ id: string | null }>();
      expect(row?.id).toBeTruthy();
    },
  );

  it('baked-patched: the bootstrap adds no release; the baked sync gives the PATCH org a system release', async () => {
    const id = legacy.templateIds['baked-patched'];
    expect(c.bootstrapPlan.filter((line) => line.includes(id))).toEqual([]);
    const releases = await legacy.db
      .prepare(
        'SELECT org_id, mode, source FROM template_releases WHERE template_id = ? ORDER BY mode',
      )
      .bind(id)
      .all();
    expect(releases.results).toEqual([
      { org_id: 'org-b', mode: 'live', source: 'system' },
      { org_id: 'org-b', mode: 'test', source: 'system' },
    ]);
    const row = await legacy.db
      .prepare('SELECT org_id FROM templates WHERE id = ?')
      .bind(id)
      .first();
    expect(row).toEqual({ org_id: 'org-b' });
  });

  it('has no effective release for baked passes until the baked sync runs; uploaded ones have it from the bootstrap', () => {
    for (const p of legacy.passes) {
      const baked = p.shape.startsWith('baked');
      expect(c.beforeSync[p.id] === null, `${p.id}`).toBe(baked || p.shape === 'uploaded-archived');
    }
  });

  it('uploaded-moved: a release in its org only; the org it left (deleted passes only) gets none', async () => {
    expect(c.bootstrapPlan.filter((line) => line.includes('up-moved'))).toEqual([
      'template up-moved (org-a) live: legacy release at version v2',
    ]);
    const releases = await legacy.db
      .prepare("SELECT org_id, mode, source FROM template_releases WHERE template_id = 'up-moved'")
      .all();
    expect(releases.results).toEqual([{ org_id: 'org-a', mode: 'live', source: 'legacy' }]);
    expect((await effective(legacy.db, MOVED_AWAY_PASS))?.id ?? null).toBeNull();
  });

  it('a rerun of the bootstrap plans nothing', async () => {
    expect((await runBootstrap(legacy.db, OWNER, NOW + 1)).plan).toEqual([]);
  });

  it('writes no raw download or bundle token into the bootstrap SQL', () => {
    for (const token of [
      ...legacy.passes.map((p) => p.downloadToken),
      'dl-moved-away',
      'bundle-token-1',
    ])
      expect(c.bootstrapSql).not.toContain(token);
  });

  it('uploaded-archived: has no effective release (archived templates are ineligible); publish uses legacy maintenance', async () => {
    for (const p of legacy.passes.filter((p) => p.shape === 'uploaded-archived'))
      expect((await effective(legacy.db, p.id))?.id ?? null).toBeNull();
    const releases = await legacy.db
      .prepare("SELECT count(*) AS n FROM template_releases WHERE template_id = 'up-archived'")
      .first<{ n: number }>();
    expect(releases?.n).toBe(0);
  });
});

describe('cutover: nothing lost', () => {
  it('binds the queued push to its pass and keeps the sent mail', async () => {
    const rows = await legacy.db
      .prepare(
        "SELECT id, state, payload, coalesce_key FROM outbox WHERE id LIKE 'push-%' OR id LIKE 'sent-%' ORDER BY id",
      )
      .all<{ id: string; state: string; payload: string; coalesce_key: string | null }>();
    expect(rows.results).toHaveLength(16);
    for (const r of rows.results) {
      if (r.id.startsWith('push-')) {
        expect(r.state).toBe('pending');
        expect(JSON.parse(r.payload)).toMatchObject({ reason: 'publish', identityId: 'platform' });
        expect(r.coalesce_key).toMatch(/^push:/);
      } else expect(r.state).toBe('sent');
    }
  });

  it('keeps every 0024 row and pass credential', async () => {
    const after = await dataFingerprint(legacy.db, TABLES);
    for (const t of TABLES)
      expect(after.counts[t], t).toBeGreaterThanOrEqual(c.before.counts[t] ?? 0);
    expect(after.creds).toEqual(c.before.creds);
  });
});

/** The SQL blocks the runbook tells the owner to run, executed against the cutover database. */
const runbook = new Map(
  [...operations.matchAll(/```sql ((?:verify|backfill|release)-[\w-]+)\n([\s\S]*?)```/g)].map(
    (m) => [m[1] as string, (m[2] as string).replace(/^ {3}/gm, '').trim()],
  ),
);
const rows = async (name: string) =>
  (await legacy.db.prepare(runbook.get(name) ?? `missing ${name}`).all<Record<string, unknown>>())
    .results;

describe('cutover: runbook queries', () => {
  it('has every query the runbook names', () => {
    expect([...runbook.keys()].sort()).toEqual([
      'backfill-proven-primaries',
      'release-disabled-claimant',
      'verify-admin-emails',
      'verify-archived',
      'verify-broadcasts-due',
      'verify-counts',
      'verify-email-unbound',
      'verify-heads',
      'verify-memberships',
      'verify-moved',
      'verify-orphan-removed',
      'verify-outbox',
      'verify-snapshot-size',
      'verify-stale-after',
      'verify-stale-before',
      'verify-unproven-primaries',
    ]);
  });

  it('pre-checks: no pending bundle mail; archived, stale and moved templates are listed', async () => {
    expect(await rows('verify-outbox')).toEqual([
      { kind: 'email', state: 'pending', n: 9 },
      { kind: 'push', state: 'pending', n: 8 },
    ]);
    expect(await rows('verify-archived')).toEqual([
      { id: 'up-archived', origin: 'uploaded', org_id: 'org-a', passes: 4 },
    ]);
    // The moved template's deleted org-b pass is stale too, and not counted.
    expect(await rows('verify-stale-before')).toEqual([
      { template_id: 'up-active', org_id: 'org-a', passes: 1 },
      { template_id: 'up-archived', org_id: 'org-a', passes: 1 },
      { template_id: 'up-moved', org_id: 'org-a', passes: 1 },
    ]);
    expect(await rows('verify-moved')).toEqual([
      { id: 'up-moved', template_org: 'org-a', org_id: 'org-b', passes: 1, live: 0 },
    ]);
    expect(await rows('verify-orphan-removed')).toEqual([]);
    expect(await rows('verify-broadcasts-due')).toEqual([]);
    const size = (await rows('verify-snapshot-size'))[0]?.est_bytes as number;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(1_500_000);
  });

  it('pre-check 9: lists provider accounts with an unproven primary; the backfill proves exactly the listed ids it may', async () => {
    const db = legacy.db;
    const run = (sql: string) => db.prepare(sql).run();
    const script = async (sql: string) => {
      await db.batch(
        sql
          .split(/;\s*\n/)
          .filter((part) => part.trim())
          .map((part) => db.prepare(part)),
      );
    };
    const ids = (name: string, list: string[]) =>
      (runbook.get(name) ?? '').replaceAll(
        /'REPLACE-WITH-USER-ID'(, 'REPLACE-WITH-ANOTHER-USER-ID')?/g,
        list.map((id) => `'${id}'`).join(', '),
      );
    await run(
      `INSERT INTO users (id, name, primary_email, status, created_at, last_roles) VALUES
        ('u-ph', 'Placeholder', 'u-ph@unverified.invalid', 'active', 1, '["user"]'),
        ('u-dis', 'Disabled', 'dis@example.com', 'disabled', 1, '["user"]')`,
    );
    await run(
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
       VALUES ('pocketid', 'sub-h', 'u-holder', 'holder@example.com', 1, '[]', 1),
              ('pocketid', 'sub-a', 'u-admin2', 'admin2@example.com', 0, '[]', 1),
              ('pocketid', 'sub-p', 'u-ph', 'u-ph@example.com', 1, '[]', 1),
              ('pocketid', 'sub-d', 'u-dis', 'dis@example.com', 1, '[]', 1)`,
    );
    // Someone else already has u-admin2's address verified.
    await run(
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('admin2@example.com', 'u-owner', 'magic_link', 1)",
    );
    try {
      const listed = async () => (await rows('verify-unproven-primaries')).map((r) => r.id);
      expect(await listed()).toEqual(['u-admin2', 'u-dis', 'u-holder', 'u-ph']);
      expect((await rows('verify-unproven-primaries')).find((r) => r.id === 'u-holder')).toEqual({
        id: 'u-holder',
        status: 'active',
        primary_email: 'holder@example.com',
        idp_verified: 1,
        passes: 8,
      });
      const backfill = ids('backfill-proven-primaries', ['u-holder', 'u-admin2', 'u-ph']);
      expect(backfill).toContain("'u-holder', 'u-admin2', 'u-ph'");
      await run(backfill);
      const proven = await db
        .prepare(
          "SELECT email, user_id, verified_via FROM user_emails WHERE verified_via = 'admin' AND user_id IN ('u-holder', 'u-admin2', 'u-ph')",
        )
        .all();
      // Guards: no placeholder address, none already verified for another account.
      expect(proven.results).toEqual([
        { email: 'holder@example.com', user_id: 'u-holder', verified_via: 'admin' },
      ]);
      expect(await listed()).toEqual(['u-admin2', 'u-dis', 'u-ph']);
      expect(await rows('verify-admin-emails')).toContainEqual(
        expect.objectContaining({ email: 'holder@example.com', user_id: 'u-holder' }),
      );
      await run(backfill);

      const release = ids('release-disabled-claimant', ['u-dis', 'u-holder', 'u-admin2']);
      await script(release);
      await script(release);
      const users = await db
        .prepare(
          "SELECT id, primary_email FROM users WHERE id IN ('u-dis', 'u-holder', 'u-admin2') ORDER BY id",
        )
        .all();
      expect(users.results).toEqual([
        { id: 'u-admin2', primary_email: 'admin2@example.com' },
        { id: 'u-dis', primary_email: 'u-dis@unverified.invalid' },
        { id: 'u-holder', primary_email: 'holder@example.com' },
      ]);
      const audits = await db
        .prepare("SELECT target_id FROM audit_log WHERE action = 'auth.primary_email_unproven'")
        .all();
      expect(audits.results).toEqual([{ target_id: 'u-dis' }]);
    } finally {
      await run("DELETE FROM audit_log WHERE action = 'auth.primary_email_unproven'");
      await run(
        "DELETE FROM user_emails WHERE user_id IN ('u-holder', 'u-admin2', 'u-ph') OR email = 'admin2@example.com'",
      );
      await run(
        "DELETE FROM auth_identities WHERE subject IN ('sub-h', 'sub-a', 'sub-p', 'sub-d')",
      );
      await run("DELETE FROM users WHERE id IN ('u-ph', 'u-dis')");
    }
  });

  it('after the cutover: only the archived template lacks a head (a deleted org is ignored); mail and memberships are bound', async () => {
    expect(await rows('verify-heads')).toEqual([
      { id: 'up-archived', origin: 'uploaded', status: 'archived', org_id: 'org-a', passes: 4 },
    ]);
    expect(await rows('verify-memberships')).toEqual([]);
    expect(await rows('verify-email-unbound')).toEqual([{ n: 0 }]);
    expect(await rows('verify-stale-after')).toEqual([
      { template_id: 'up-active', org_id: 'org-a', passes: 1 },
      { template_id: 'up-moved', org_id: 'org-a', passes: 1 },
    ]);
  });

  it('counts never drop', async () => {
    const after = JSON.parse((await rows('verify-counts'))[0]?.counts as string) as Record<
      string,
      number
    >;
    for (const [table, n] of Object.entries(c.before.counts))
      if (table in after) expect(after[table] as number, table).toBeGreaterThanOrEqual(n);
    expect(after.download_tokens).toBe(after.passes);
    expect(after.auth_tokens).toBe(after.passes);
  });
});
