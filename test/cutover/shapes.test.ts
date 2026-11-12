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
}, 120_000);

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
    expect(rows.results).toHaveLength(12);
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
  [...operations.matchAll(/```sql (verify-[\w-]+)\n([\s\S]*?)```/g)].map((m) => [
    m[1] as string,
    (m[2] as string).replace(/^ {3}/gm, '').trim(),
  ]),
);
const rows = async (name: string) =>
  (await legacy.db.prepare(runbook.get(name) ?? `missing ${name}`).all<Record<string, unknown>>())
    .results;

describe('cutover: runbook queries', () => {
  it('has every query the runbook names', () => {
    expect([...runbook.keys()].sort()).toEqual([
      'verify-archived',
      'verify-counts',
      'verify-email-unbound',
      'verify-heads',
      'verify-memberships',
      'verify-moved',
      'verify-outbox',
      'verify-stale-after',
      'verify-stale-before',
    ]);
  });

  it('pre-checks: no pending bundle mail; archived, stale and moved templates are listed', async () => {
    expect(await rows('verify-outbox')).toEqual([
      { kind: 'email', state: 'pending', n: 7 },
      { kind: 'push', state: 'pending', n: 6 },
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
