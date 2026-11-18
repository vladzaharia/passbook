/// <reference types="vite/client" />

import { env as testEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { all, first, run } from '../../platform/db.ts';
import { type BlueprintKit, blueprintKit } from './blueprint-test-fixtures.ts';

const STORE = 'baked:starter-store-card';
const HENRYS = 'baked:henrys-blue';

let kit: BlueprintKit;

interface ForkRow {
  template_id: string;
  org_id: string;
  upstream_id: string;
  tracking: string;
}
interface BaseRow {
  version: string;
  upstream_id: string;
  upstream_version: string;
  upstream_content_hash: string | null;
  via: string;
  parent_version: string | null;
  inferred: number;
}

const forkOf = (id: string) =>
  first<ForkRow>(kit.env.DB, 'SELECT * FROM template_forks WHERE template_id = ?', [id]);
const basesOf = (id: string) =>
  all<BaseRow>(
    kit.env.DB,
    'SELECT * FROM template_version_bases WHERE template_id = ? ORDER BY created_at, version',
    [id],
  );
const activeOf = async (id: string) =>
  ((await (await kit.call(`/${id}`)).json()) as { activeVersion: string }).activeVersion;
const draftOf = async (id: string, version?: string) => {
  const v =
    version ?? (await activeOf(id).catch(() => undefined)) ?? (await basesOf(id))[0]?.version;
  const body = (await (await kit.call(`/${id}/versions/${v}`)).json()) as {
    passJson: Record<string, unknown>;
    manifest: Record<string, unknown>;
    assets: { name: string; sha1: string }[];
  };
  return {
    passJson: body.passJson,
    manifest: body.manifest,
    assets: body.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
  };
};
const make = async (path: string, body: Record<string, unknown>) => {
  const res = await kit.post(path, { orgId: kit.org.id, ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string; versions: { version: string }[] }).id;
};

const forget = async (...ids: string[]) => {
  for (const id of ids) {
    await withoutTrigger(kit.env.DB, 'template_version_bases_no_delete', () =>
      run(kit.env.DB, 'DELETE FROM template_version_bases WHERE template_id = ?', [id]),
    );
    await run(kit.env.DB, 'DELETE FROM template_forks WHERE template_id = ?', [id]);
  }
};

beforeAll(async () => {
  kit = await blueprintKit();
});

describe('fork through Use blueprint', () => {
  it('records the fork and the blueprint version an exact copy starts from', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Fork Exact' });
    expect(await forkOf(id)).toMatchObject({
      org_id: kit.org.id,
      upstream_id: STORE,
      tracking: 'on',
    });
    const active = await activeOf(STORE);
    const bases = await basesOf(id);
    expect(bases).toEqual([
      expect.objectContaining({
        upstream_id: STORE,
        upstream_version: active,
        via: 'fork',
        parent_version: null,
        inferred: 0,
      }),
    ]);
    const hash = await first<{ content_hash: string }>(
      kit.env.DB,
      'SELECT content_hash FROM template_version_hashes WHERE template_id = ? AND version = ?',
      [STORE, active],
    );
    expect(bases[0]?.upstream_content_hash ?? null).toBe(hash?.content_hash ?? null);
  });

  it('records the base of a designer draft: the current version, or the one the draft opened', async () => {
    const active = await activeOf(STORE);
    const draft = await draftOf(STORE);
    const first = await make(`/${STORE}/use`, { name: 'Fork Draft', version: draft });
    expect((await basesOf(first)).map((b) => [b.upstream_version, b.via])).toEqual([
      [active, 'fork'],
    ]);
    const second = await make(`/${STORE}/use`, {
      name: 'Fork Draft Based',
      version: draft,
      baseVersion: active,
    });
    expect((await basesOf(second))[0]?.upstream_version).toBe(active);
  });

  it('refuses a base version the blueprint never had, and creates nothing', async () => {
    const draft = await draftOf(STORE);
    const res = await kit.post(`/${STORE}/use`, {
      orgId: kit.org.id,
      name: 'Fork Unknown Base',
      version: draft,
      baseVersion: 'nope',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
    expect(
      await first(kit.env.DB, "SELECT 1 FROM templates WHERE name = 'Fork Unknown Base'"),
    ).toBeNull();
  });
});

describe('fork through Duplicate', () => {
  it('tracks a copy of a built-in with the version it copied', async () => {
    const id = await make(`/${HENRYS}/clone`, { orgId: kit.henrys.id, name: 'Henry Fork' });
    expect(await forkOf(id)).toMatchObject({ upstream_id: HENRYS, org_id: kit.henrys.id });
    const bases = await basesOf(id);
    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatchObject({
      upstream_id: HENRYS,
      upstream_version: await activeOf(HENRYS),
      via: 'fork',
    });
  });

  it('tracks a copy of an uploaded template as lineage only', async () => {
    const source = await make(`/${STORE}/use`, { name: 'Fork Source' });
    const sourceVersion = (await basesOf(source))[0]?.version;
    const copy = await make(`/${source}/clone`, { name: 'Fork Of Fork' });
    expect(await forkOf(copy)).toMatchObject({ upstream_id: source });
    const bases = await basesOf(copy);
    expect(bases.map((b) => [b.upstream_id, b.upstream_version])).toEqual([
      [source, sourceVersion],
    ]);
  });

  it('keeps the audit and the blueprint column of each entry point', async () => {
    const id = await make(`/${STORE}/clone`, { name: 'Fork By Duplicate' });
    const audit = await first<{ action: string; detail: string }>(
      kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'template.%'",
      [id],
    );
    expect(audit?.action).toBe('template.use_blueprint');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ sourceId: STORE });
    expect(
      (
        await first<{ source_blueprint: string }>(
          kit.env.DB,
          'SELECT source_blueprint FROM templates WHERE id = ?',
          [id],
        )
      )?.source_blueprint,
    ).toBe(STORE);
  });

  it('refuses a base version that is not the copied one', async () => {
    const res = await kit.post(`/${STORE}/use`, {
      orgId: kit.org.id,
      name: 'Fork Wrong Base',
      baseVersion: 'nope',
    });
    expect(res.status).toBe(409);
  });
});

describe('edits keep their base', () => {
  const save = async (id: string, body: Record<string, unknown>) => {
    kit.clock.advance(1000);
    const res = await kit.post(`/${id}/versions`, body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { version: string; behindTip?: boolean };
  };

  it('copies the parent base to the new version, and flags a save from an older one', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Fork Edits' });
    const v1 = (await basesOf(id))[0] as BaseRow;
    const draft = await draftOf(id, v1.version);
    const edit = (text: string) => ({
      ...draft,
      passJson: { ...draft.passJson, description: text },
    });
    const v2 = await save(id, { ...edit('Second'), parentVersion: v1.version });
    expect(v2.behindTip).toBeUndefined();
    const v3 = await save(id, { ...edit('Third'), parentVersion: v1.version });
    expect(v3.behindTip).toBe(true);
    const v4 = await save(id, edit('Fourth'));
    expect(v4.behindTip).toBeUndefined();
    const bases = await basesOf(id);
    expect(bases.map((b) => [b.version, b.via, b.parent_version, b.upstream_version])).toEqual([
      [v1.version, 'fork', null, v1.upstream_version],
      [v2.version, 'edit', v1.version, v1.upstream_version],
      [v3.version, 'edit', v1.version, v1.upstream_version],
      // Without a parent the tip's base is copied: the tip was v3, saved last.
      [v4.version, 'edit', v3.version, v1.upstream_version],
    ]);
  });

  it('does not duplicate a base when the same content is saved again', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Fork Resave' });
    const v1 = (await basesOf(id))[0] as BaseRow;
    const draft = await draftOf(id, v1.version);
    const edit = { ...draft, passJson: { ...draft.passJson, description: 'Again' } };
    const first = await save(id, { ...edit, parentVersion: v1.version });
    const again = await save(id, { ...edit, parentVersion: v1.version });
    expect(again.version).toBe(first.version);
    expect(await basesOf(id)).toHaveLength(2);
  });

  it('refuses a parent version the template never had', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Fork Bad Parent' });
    const draft = await draftOf(id);
    const res = await kit.post(`/${id}/versions`, { ...draft, parentVersion: 'nope' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
  });

  it('writes no base for a template that is not a fork', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Fork Plain' });
    const draft = await draftOf(id);
    await forget(id);
    const saved = await save(id, {
      ...draft,
      passJson: { ...draft.passJson, description: 'Plain' },
    });
    expect(saved.behindTip).toBeUndefined();
    expect(await basesOf(id)).toEqual([]);
  });
});

describe('lineage triggers', () => {
  let id: string;
  let version: string;
  let upstreamVersion: string;
  beforeAll(async () => {
    id = await make(`/${STORE}/use`, { name: 'Fork Triggers' });
    const base = (await basesOf(id))[0] as BaseRow;
    version = base.version;
    upstreamVersion = base.upstream_version;
  });
  const refuses = (sql: string, params: (string | number | null)[], message: RegExp) =>
    expect(run(kit.env.DB, sql, params)).rejects.toThrow(message);

  it('never changes a fork row’s template, org or upstream, but tracking moves', async () => {
    await refuses(
      'UPDATE template_forks SET upstream_id = ? WHERE template_id = ?',
      [HENRYS, id],
      /lineage is immutable/,
    );
    await refuses(
      'UPDATE template_forks SET org_id = ? WHERE template_id = ?',
      [kit.other.id, id],
      /lineage is immutable/,
    );
    await run(kit.env.DB, "UPDATE template_forks SET tracking = 'paused' WHERE template_id = ?", [
      id,
    ]);
    expect((await forkOf(id))?.tracking).toBe('paused');
    await refuses(
      "UPDATE template_forks SET tracking = 'sometimes' WHERE template_id = ?",
      [id],
      /CHECK/,
    );
  });

  it('refuses a fork of a baked template, in another org, or of itself', async () => {
    const insert = `INSERT INTO template_forks (template_id, org_id, upstream_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1)`;
    await refuses(insert, [HENRYS, kit.henrys.id, STORE], /invalid template fork/);
    const lone = await make(`/${STORE}/use`, { name: 'Fork Lone' });
    await withoutTrigger(kit.env.DB, 'template_version_bases_no_delete', () =>
      run(kit.env.DB, 'DELETE FROM template_version_bases WHERE template_id = ?', [lone]),
    );
    await run(kit.env.DB, 'DELETE FROM template_forks WHERE template_id = ?', [lone]);
    await refuses(insert, [lone, kit.other.id, STORE], /invalid template fork/);
    await refuses(insert, [lone, kit.org.id, lone], /CHECK/);
  });

  it('writes a base once: no update, no delete, and only for the fork’s upstream', async () => {
    await refuses(
      'UPDATE template_version_bases SET via = ? WHERE template_id = ?',
      ['merge', id],
      /immutable/,
    );
    await refuses('DELETE FROM template_version_bases WHERE template_id = ?', [id], /immutable/);
    const insert = `INSERT INTO template_version_bases
      (template_id, version, upstream_id, upstream_version, via, created_at)
      VALUES (?, ?, ?, ?, 'merge', 1)`;
    const other = await first<{ version: string }>(
      kit.env.DB,
      'SELECT version FROM template_versions WHERE template_id = ? LIMIT 1',
      [HENRYS],
    );
    await refuses(
      insert,
      [id, version, HENRYS, other?.version ?? ''],
      /invalid template version base/,
    );
    await refuses(
      "INSERT INTO template_version_bases (template_id, version, upstream_id, upstream_version, via, created_at) VALUES (?, ?, ?, ?, 'sideways', 1)",
      [id, version, STORE, upstreamVersion],
      /CHECK/,
    );
  });

  it('accepts a newer base on the same version, and an estimated one', async () => {
    const lone = await make(`/${STORE}/use`, { name: 'Fork Estimate' });
    const base = (await basesOf(lone))[0] as BaseRow;
    const newer = { version: 'newer-upstream' };
    await run(
      kit.env.DB,
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, created_at)
       VALUES (?, ?, '{}', '{}', 2)`,
      [STORE, newer.version],
    );
    await run(
      kit.env.DB,
      `INSERT INTO template_version_bases
       (template_id, version, upstream_id, upstream_version, via, parent_version, inferred, created_at)
       VALUES (?, ?, ?, ?, 'noop', NULL, 1, ?)`,
      [lone, base.version, STORE, newer.version, kit.clock.now() + 1],
    );
    expect((await basesOf(lone)).map((b) => [b.via, b.inferred])).toEqual([
      ['fork', 0],
      ['noop', 1],
    ]);
  });

  it('keeps an update offer’s identity, and settles terminal statuses', async () => {
    const insert = (status: string, upstream: string) =>
      run(
        kit.env.DB,
        `INSERT INTO template_fork_updates
         (id, template_id, org_id, upstream_id, upstream_version, ours_version, status, engine_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        [`${status}-${upstream}`, id, kit.org.id, STORE, upstream, version, status],
      );
    await insert('pending', 'u1');
    await insert('clean', 'u2');
    await insert('conflicted', 'u3');
    await refuses(
      "UPDATE template_fork_updates SET ours_version = 'x' WHERE id = 'pending-u1'",
      [],
      /identity is immutable/,
    );
    await run(
      kit.env.DB,
      "UPDATE template_fork_updates SET status = 'clean' WHERE id = 'pending-u1'",
    );
    // A clean offer can only be dismissed.
    await refuses(
      "UPDATE template_fork_updates SET status = 'pending' WHERE id = 'pending-u1'",
      [],
      /settled/,
    );
    await run(
      kit.env.DB,
      "UPDATE template_fork_updates SET status = 'dismissed' WHERE id = 'pending-u1'",
    );
    await refuses(
      "UPDATE template_fork_updates SET status = 'clean' WHERE id = 'pending-u1'",
      [],
      /settled/,
    );
    await refuses(
      "UPDATE template_fork_updates SET status = 'noop' WHERE id = 'clean-u2'",
      [],
      /settled/,
    );
    await refuses(
      `INSERT INTO template_fork_updates
       (id, template_id, org_id, upstream_id, upstream_version, ours_version, status, engine_revision, created_at, updated_at)
       VALUES ('dup', ?, ?, ?, 'u2', ?, 'pending', 1, 1, 1)`,
      [id, kit.org.id, STORE, version],
      /UNIQUE/,
    );
  });
});

describe('0086 backfill', () => {
  const backfill = async () => {
    const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0086'));
    for (const query of migration?.queries ?? []) await run(kit.env.DB, query);
  };
  it('restores forks from source_blueprint without a base, for the job to estimate', async () => {
    const id = await make(`/${STORE}/use`, { name: 'Backfill Blueprint' });
    await forget(id);
    expect(await forkOf(id)).toBeNull();
    await backfill();
    expect(await forkOf(id)).toMatchObject({
      upstream_id: STORE,
      org_id: kit.org.id,
      tracking: 'on',
    });
    expect(await basesOf(id)).toEqual([]);
  });

  it('restores forks of Duplicate from the audit, with the exact source version', async () => {
    const id = await make(`/${HENRYS}/clone`, { orgId: kit.henrys.id, name: 'Backfill Henry' });
    const [recorded] = await basesOf(id);
    await forget(id);
    await backfill();
    expect(await forkOf(id)).toMatchObject({ upstream_id: HENRYS, org_id: kit.henrys.id });
    expect(await basesOf(id)).toEqual([
      expect.objectContaining({
        version: recorded?.version,
        upstream_id: HENRYS,
        upstream_version: recorded?.upstream_version,
        via: 'backfill',
        inferred: 0,
      }),
    ]);
  });

  it('keeps the fork but writes no base when the recorded version is gone', async () => {
    const id = await make(`/${HENRYS}/clone`, { orgId: kit.henrys.id, name: 'Backfill Gone' });
    await forget(id);
    await run(
      kit.env.DB,
      `UPDATE audit_log SET detail = json_set(detail, '$.sourceVersion', 'gone')
       WHERE action = 'template.clone' AND target_id = ?`,
      [id],
    );
    await backfill();
    expect(await forkOf(id)).toMatchObject({ upstream_id: HENRYS });
    expect(await basesOf(id)).toEqual([]);
  });

  it('skips duplicates of uploaded templates and is safe to run twice', async () => {
    const source = await make(`/${STORE}/use`, { name: 'Backfill Source' });
    const copy = await make(`/${source}/clone`, { name: 'Backfill Copy' });
    await forget(copy);
    await backfill();
    expect(await forkOf(copy)).toBeNull();
    const before = await all(kit.env.DB, 'SELECT * FROM template_forks ORDER BY template_id');
    await backfill();
    expect(await all(kit.env.DB, 'SELECT * FROM template_forks ORDER BY template_id')).toEqual(
      before,
    );
  });
});
