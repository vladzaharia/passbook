import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../src/worker/platform/db.ts';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
  persistTemplate,
} from './helpers/index.ts';

const TABLES = [
  'orgs',
  'users',
  'user_emails',
  'auth_identities',
  'sessions',
  'magic_links',
  'oidc_flows',
  'api_keys',
  'credentials',
  'signing_identities',
  'templates',
  'template_versions',
  'connections',
  'connection_runs',
  'webhook_events',
  'passes',
  'pass_versions',
  'pass_attach_blocks',
  'pass_assets',
  'devices',
  'registrations',
  'revisions',
  'outbox',
  'push_results',
  'wallet_logs',
  'audit_log',
  'settings',
  'idempotency_keys',
  'counters',
  'workflow_runs',
];

async function setup() {
  const f = fixtures(await makeEnv());
  const org = await makeOrg(f);
  const template = makeTemplate();
  const pass = await makePass(f, { orgId: org.id, template: template.resolved });
  return { f, org, template, pass };
}

describe('0001_platform migration', () => {
  it('creates every table', async () => {
    const rows = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = new Set(rows.map((r) => r.name));
    for (const table of TABLES) expect(names, table).toContain(table);
  });

  it('indexes every foreign key child column', async () => {
    const tables = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'",
    );
    const missing: string[] = [];
    for (const { name } of tables) {
      const fks = await all<{ id: number; from: string }>(
        env.DB,
        `SELECT id, "from" FROM pragma_foreign_key_list('${name}')`,
      );
      const byId = new Map<number, string[]>();
      for (const fk of fks) byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk.from]);
      const indexes = await all<{ name: string }>(
        env.DB,
        `SELECT name FROM pragma_index_list('${name}')`,
      );
      const leading: string[][] = [];
      for (const { name: index } of indexes) {
        const cols = await all<{ name: string }>(
          env.DB,
          `SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`,
        );
        leading.push(cols.map((c) => c.name));
      }
      const pk = await all<{ name: string; pk: number }>(
        env.DB,
        `SELECT name, pk FROM pragma_table_info('${name}') WHERE pk > 0 ORDER BY pk`,
      );
      leading.push(pk.map((c) => c.name));
      for (const columns of byId.values()) {
        const covered = leading.some((cols) => columns.every((c, i) => cols[i] === c));
        if (!covered) missing.push(`${name}(${columns.join(', ')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('rejects invalid enum values', async () => {
    await expect(
      run(
        env.DB,
        "INSERT INTO orgs (id, slug, name, status, created_at, updated_at) VALUES ('x', 'xx', 'X', 'bogus', 1, 1)",
      ),
    ).rejects.toThrow();
  });
});

describe('pass triggers', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    await run(env.DB, 'DELETE FROM outbox');
    await run(env.DB, 'DELETE FROM passes');
    ctx = await setup();
  });

  it('records the first version and a revision on create, without a push', async () => {
    const row = await first<{ revision: number; version: number }>(
      env.DB,
      'SELECT revision, version FROM passes WHERE id = ?',
      [ctx.pass.id],
    );
    expect(row?.revision).toBeGreaterThan(0);
    const versions = await all<{ version: number; cause: string }>(
      env.DB,
      'SELECT version, cause FROM pass_versions WHERE pass_id = ?',
      [ctx.pass.id],
    );
    expect(versions).toEqual([{ version: 1, cause: 'create' }]);
    const pushes = await all(env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
      ctx.pass.id,
    ]);
    expect(pushes).toHaveLength(0);
  });

  async function publish(version: number, cause = 'admin') {
    const key = `passes/${ctx.pass.id}/v${version}.pkpass`;
    return run(
      env.DB,
      `UPDATE passes SET version = ?, object_key = ?, modified_at = ?, pending_cause = ?, pending_actor_type = 'user',
         pending_actor_id = 'u1', pending_pass_json = '{"a":1}' WHERE id = ? AND version = ?`,
      [version, key, 1000 + version, cause, ctx.pass.id, version - 1],
    );
  }

  it('bumps the revision, records the version with its cause and queues one push', async () => {
    const before = await first<{ revision: number }>(
      env.DB,
      'SELECT revision FROM passes WHERE id = ?',
      [ctx.pass.id],
    );
    await publish(2, 'connection');
    const after = await first<{
      revision: number;
      pending_pass_json: string | null;
      pending_cause: string;
    }>(env.DB, 'SELECT revision, pending_pass_json, pending_cause FROM passes WHERE id = ?', [
      ctx.pass.id,
    ]);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(after?.pending_pass_json).toBeNull();
    expect(after?.pending_cause).toBe('admin');
    const v = await first<{ cause: string; actor_id: string; pass_json: string }>(
      env.DB,
      'SELECT cause, actor_id, pass_json FROM pass_versions WHERE pass_id = ? AND version = 2',
      [ctx.pass.id],
    );
    expect(v).toEqual({ cause: 'connection', actor_id: 'u1', pass_json: '{"a":1}' });
    const pushes = await all<{ state: string; coalesce_key: string }>(
      env.DB,
      "SELECT state, coalesce_key FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [ctx.pass.id],
    );
    expect(pushes).toEqual([{ state: 'pending', coalesce_key: `push:${ctx.pass.id}` }]);
  });

  it('coalesces a burst of publishes into one pending push', async () => {
    await publish(2);
    await publish(3);
    await publish(4);
    const pushes = await all(env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
      ctx.pass.id,
    ]);
    expect(pushes).toHaveLength(1);
    const versions = await all(env.DB, 'SELECT version FROM pass_versions WHERE pass_id = ?', [
      ctx.pass.id,
    ]);
    expect(versions).toHaveLength(4);
  });

  it('allows a new push once the pending one is claimed (coalesce_key cleared)', async () => {
    await publish(2);
    await run(
      env.DB,
      "UPDATE outbox SET coalesce_key = NULL, state = 'processing' WHERE pass_id = ?",
      [ctx.pass.id],
    );
    await publish(3);
    const pushes = await all(env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
      ctx.pass.id,
    ]);
    expect(pushes).toHaveLength(2);
  });

  it('keeps revisions monotonic after pruning', async () => {
    await publish(2);
    const high = await first<{ revision: number }>(
      env.DB,
      'SELECT max(revision) AS revision FROM revisions',
    );
    await run(env.DB, 'DELETE FROM revisions');
    await publish(3);
    const next = await first<{ revision: number }>(
      env.DB,
      'SELECT max(revision) AS revision FROM revisions',
    );
    expect(next?.revision).toBeGreaterThan(high?.revision ?? 0);
  });

  it('does not trigger when object_key is unchanged', async () => {
    await run(env.DB, "UPDATE passes SET display_title = 'x' WHERE id = ?", [ctx.pass.id]);
    const versions = await all(env.DB, 'SELECT version FROM pass_versions WHERE pass_id = ?', [
      ctx.pass.id,
    ]);
    expect(versions).toHaveLength(1);
  });
});

describe('constraints and cascades', () => {
  it('makes template versions immutable but deletable', async () => {
    const f = fixtures(await makeEnv());
    const template = makeTemplate({ id: 'tpl-immutable' });
    await persistTemplate(f, template.resolved);
    await expect(
      run(
        env.DB,
        "UPDATE template_versions SET manifest = '{}' WHERE template_id = 'tpl-immutable'",
      ),
    ).rejects.toThrow(/immutable/);
    await run(env.DB, "DELETE FROM templates WHERE id = 'tpl-immutable'");
    expect(
      await first(env.DB, "SELECT 1 FROM template_versions WHERE template_id = 'tpl-immutable'"),
    ).toBeNull();
  });

  it('blocks deleting a template version that passes reference', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate({ id: 'tpl-ref' });
    await makePass(f, { orgId: org.id, template: template.resolved });
    await expect(run(env.DB, "DELETE FROM templates WHERE id = 'tpl-ref'")).rejects.toThrow();
  });

  it('cascades pass deletion to versions, registrations, assets, blocks and outbox', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const user = await makeUser(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-cascade' }).resolved,
    });
    await run(
      env.DB,
      "INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES ('d1', 'platform', 'tok', 1)",
    );
    await run(
      env.DB,
      "INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES ('d1', 'platform', ?, 1)",
      [pass.id],
    );
    await run(
      env.DB,
      "INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, created_at) VALUES (?, 'thumbnail.png', 'k', 's', 1, 1)",
      [pass.id],
    );
    await run(
      env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [pass.id, user.id],
    );
    await run(
      env.DB,
      "INSERT INTO outbox (id, org_id, kind, pass_id, created_at) VALUES ('o1', ?, 'email', ?, 1)",
      [org.id, pass.id],
    );
    await run(env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    for (const table of [
      'pass_versions',
      'registrations',
      'pass_assets',
      'pass_attach_blocks',
      'outbox',
    ]) {
      expect(
        await first(env.DB, `SELECT 1 FROM ${table} WHERE pass_id = ?`, [pass.id]),
        table,
      ).toBeNull();
    }
    expect(await first(env.DB, "SELECT 1 FROM devices WHERE device_id = 'd1'")).not.toBeNull();
  });

  it('sets owner_user_id to NULL when the user is deleted and cascades sessions', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const user = await makeUser(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-owner' }).resolved,
    });
    await run(env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, pass.id]);
    await run(
      env.DB,
      "INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at) VALUES ('h', ?, 'oidc', 'c', 1, 1, 2, 2)",
      [user.id],
    );
    await run(env.DB, 'DELETE FROM users WHERE id = ?', [user.id]);
    expect(
      (
        await first<{ owner_user_id: string | null }>(
          env.DB,
          'SELECT owner_user_id FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.owner_user_id,
    ).toBeNull();
    expect(await first(env.DB, "SELECT 1 FROM sessions WHERE id_hash = 'h'")).toBeNull();
  });

  it('caps registrations at 20 per pass', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-cap' }).resolved,
    });
    for (let i = 0; i < 21; i++) {
      await run(
        env.DB,
        "INSERT OR IGNORE INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, 'platform', 't', 1)",
        [`dev-${i}`],
      );
    }
    for (let i = 0; i < 20; i++) {
      await run(
        env.DB,
        "INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, 'platform', ?, 1)",
        [`dev-${i}`, pass.id],
      );
    }
    await expect(
      run(
        env.DB,
        "INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES ('dev-20', 'platform', ?, 1)",
        [pass.id],
      ),
    ).rejects.toThrow(/cap/);
  });

  it('enforces one default identity and unique pass type ids', async () => {
    const f = fixtures(await makeEnv());
    await makeOrg(f);
    await makePass(f, {
      orgId: (await first<{ id: string }>(env.DB, 'SELECT id FROM orgs LIMIT 1'))?.id ?? '',
      template: makeTemplate({ id: 'tpl-ident' }).resolved,
    });
    await expect(
      run(
        env.DB,
        "INSERT INTO signing_identities (id, label, pass_type_identifier, team_identifier, source, env_prefix, is_default, created_at) VALUES ('b', 'B', 'pass.other', 'T', 'env', 'B', 1, 1)",
      ),
    ).rejects.toThrow();
    await expect(
      run(
        env.DB,
        "INSERT INTO signing_identities (id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at) VALUES ('c', 'C', 'pass.im.plrs.wallet', 'T', 'env', 'C', 1)",
      ),
    ).rejects.toThrow();
  });
});
