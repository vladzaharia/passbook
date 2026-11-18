import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { GUARDED_TABLES } from '../src/worker/platform/authority-tables.ts';
import { all, first, run } from '../src/worker/platform/db.ts';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from './helpers/index.ts';

const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith('_pass_imports.sql'));
const start = (kind: string, id: string, commitment: string | null = null) =>
  run(
    env.DB,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at, credential_keyset_commitment)
     VALUES (?, ?, NULL, NULL, 'queued', 1, ?)`,
    [id, kind, commitment],
  );

describe('pass imports migration', () => {
  it('creates the three tables and guards them', async () => {
    const names = (
      await all<{ name: string }>(env.DB, "SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((r) => r.name);
    for (const t of ['pass_imports', 'pass_import_rows', 'pass_import_mappings']) {
      expect(names).toContain(t);
      expect(GUARDED_TABLES[t], t).toBeDefined();
    }
  });

  it('accepts the pass_import workflow kind and still refuses others', async () => {
    await start('pass_import', 'pass-import-1');
    await expect(start('bogus', 'x')).rejects.toThrow(/CHECK constraint failed/);
  });

  it('allows one committing import per org, mode and template', async () => {
    const insert = (id: string, state: string) =>
      run(
        env.DB,
        `INSERT INTO pass_imports (id, org_id, mode, template_id, source_kind, source_name, state, created_by, created_at, expires_at)
         VALUES (?, ?, 'live', 't1', 'file', 'a.csv', ?, 'u', 1, 2)`,
        [id, 'org-imp', state],
      );
    await run(
      env.DB,
      "INSERT INTO orgs (id, slug, name, status, created_at, updated_at) VALUES ('org-imp', 'org-imp', 'O', 'active', 1, 1)",
    );
    await insert('i1', 'committing');
    await expect(insert('i2', 'committing')).rejects.toThrow(/UNIQUE/);
    await insert('i3', 'ready');
    await insert('i4', 'done');
  });

  it('keeps the id of the check run on the draft', async () => {
    await run(env.DB, "UPDATE pass_imports SET check_id = 'run-1' WHERE id = 'i3'");
    expect(
      (
        await first<{ check_id: string }>(
          env.DB,
          "SELECT check_id FROM pass_imports WHERE id = 'i3'",
        )
      )?.check_id,
    ).toBe('run-1');
    expect(
      (
        await first<{ check_id: string | null }>(
          env.DB,
          "SELECT check_id FROM pass_imports WHERE id = 'i4'",
        )
      )?.check_id,
    ).toBeNull();
  });

  it('keeps workflow runs, snapshot sets, snapshots and the key-commitment lock across the rebuild', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate();
    await makePass(f, { orgId: org.id, template: template.resolved });
    const version = await first<{ version: string }>(
      env.DB,
      'SELECT version FROM template_versions WHERE template_id = ?',
      [template.resolved.id],
    );
    await run(
      env.DB,
      "UPDATE templates SET origin = 'baked', org_id = ?, status = 'active', active_version = ? WHERE id = ?",
      [org.id, version?.version ?? '', template.resolved.id],
    );
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    await run(
      env.DB,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
         content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at)
       VALUES ('rel-keep', ?, ?, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'system', 'system', 1)`,
      [template.resolved.id, org.id, version?.version ?? '', hex(1), hex(2)],
    );
    const commitment = 'a'.repeat(64);
    await start('bulk_reissue', 'wr-keep', commitment);
    await start('broadcast', 'wr-bare');
    await run(
      env.DB,
      "INSERT INTO workflow_release_snapshot_sets (instance_id) VALUES ('wr-keep')",
    );
    for (const [mode, gen] of [
      ['live', 1],
      ['test', 2],
    ] as const) {
      await run(
        env.DB,
        `INSERT INTO workflow_release_snapshots (instance_id, org_id, mode, template_id, release_id, generation, version)
         VALUES ('wr-keep', ?, ?, ?, 'rel-keep', ?, ?)`,
        [org.id, mode, template.resolved.id, gen, version?.version ?? ''],
      );
    }
    const state = async () => ({
      runs: await all(env.DB, 'SELECT * FROM workflow_runs ORDER BY instance_id'),
      sets: await all(env.DB, 'SELECT * FROM workflow_release_snapshot_sets ORDER BY instance_id'),
      snapshots: await all(
        env.DB,
        'SELECT * FROM workflow_release_snapshots ORDER BY instance_id, mode',
      ),
    });
    const before = await state();
    expect(before.runs.length).toBeGreaterThanOrEqual(3);
    expect(before.sets).toHaveLength(1);
    expect(before.snapshots).toHaveLength(2);

    const rebuild = (migration?.queries ?? []).slice(
      (migration?.queries ?? []).findIndex((q) => q.includes('_keep_workflow_runs AS')),
    );
    expect(rebuild.length).toBeGreaterThan(5);
    for (const query of rebuild) await env.DB.prepare(query).run();

    // The rebuild is replayed on today's schema, so columns added by later migrations (0105) drop out:
    // every row survives with every column the rebuild knows.
    const after = await state();
    const cols = Object.keys(after.runs[0] ?? {});
    const known = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    expect({ ...after, runs: known(after.runs) }).toEqual({ ...before, runs: known(before.runs) });
    await expect(
      run(
        env.DB,
        "UPDATE workflow_runs SET credential_keyset_commitment = NULL WHERE instance_id = 'wr-keep'",
      ),
    ).rejects.toThrow(/immutable/);
    const left = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE name LIKE '\\_keep%' ESCAPE '\\'",
    );
    expect(left).toEqual([]);
  });
});
