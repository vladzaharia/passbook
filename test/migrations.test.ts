/// <reference types="vite/client" />

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import migration from '../migrations/0067_templates_shared.sql?raw';
import { all, first, run } from '../src/worker/platform/db.ts';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanner,
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
    ).rejects.toThrow(/CHECK constraint failed: status IN \('active', 'suspended', 'deleted'\)/);
  });
});

describe('0067_templates_shared migration', () => {
  const insert = (id: string, orgId: string | null, origin: string) =>
    run(
      env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [id, orgId, id, id, origin],
    );

  it('starts new templates staged, rejects other values, and backfills only platform uploads', async () => {
    const { org } = await setup();
    await insert('shared-global-upload', null, 'uploaded');
    await insert('shared-global-baked', null, 'baked');
    await insert('shared-org-upload', org.id, 'uploaded');
    const state = async () =>
      Object.fromEntries(
        (
          await all<{ id: string; shared: number }>(
            env.DB,
            "SELECT id, shared FROM templates WHERE id LIKE 'shared-%'",
          )
        ).map((r) => [r.id, r.shared]),
      );
    expect(await state()).toEqual({
      'shared-global-upload': 0,
      'shared-global-baked': 0,
      'shared-org-upload': 0,
    });
    await expect(
      run(env.DB, "UPDATE templates SET shared = 2 WHERE id = 'shared-org-upload'"),
    ).rejects.toThrow(/CHECK constraint failed/);
    // The migration's own backfill statement, as production runs it over rows that already exist.
    const backfill = migration.split('\n').find((line) => line.startsWith('UPDATE templates'));
    if (!backfill) throw new Error('The backfill statement is missing.');
    await run(env.DB, backfill);
    expect(await state()).toEqual({
      'shared-global-upload': 1,
      'shared-global-baked': 0,
      'shared-org-upload': 0,
    });
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

  it('rejects unreserved identity, organization and mode changes', async () => {
    const otherOrg = await makeOrg(ctx.f);
    await run(
      env.DB,
      `INSERT INTO signing_identities
         (id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
       VALUES ('generation-other', 'Other', 'pass.generation.other', 'T', 'env', 'GENERATION_OTHER', 1)`,
    );
    for (const [column, value] of [
      ['identity_id', 'generation-other'],
      ['org_id', otherOrg.id],
      ['mode', 'test'],
    ]) {
      await expect(
        run(env.DB, `UPDATE passes SET ${column} = ? WHERE id = ?`, [value, ctx.pass.id]),
      ).rejects.toThrow(/credential transfer required/);
    }
    const row = await first<{ identity_id: string; org_id: string; mode: string }>(
      env.DB,
      'SELECT identity_id, org_id, mode FROM passes WHERE id = ?',
      [ctx.pass.id],
    );
    expect(row).toEqual({ identity_id: 'platform', org_id: ctx.org.id, mode: 'live' });
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
    // The key binds the push to the pass's credential, lifecycle, template and release state (0045).
    const expected = await first<{ key: string }>(
      env.DB,
      `SELECT 'push:' || json_array(id, identity_id, credential_generation, lifecycle_generation,
         template_id, template_version, release_id) AS key FROM passes WHERE id = ?`,
      [ctx.pass.id],
    );
    expect(pushes).toEqual([{ state: 'pending', coalesce_key: expected?.key }]);
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
    await expect(run(env.DB, "DELETE FROM templates WHERE id = 'tpl-ref'")).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
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

  it('rejects user deletion when it would clear a pass owner without a transfer', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const user = await makeUser(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-owner' }).resolved,
      ownerUserId: user.id,
    });
    await run(
      env.DB,
      "INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at) VALUES ('h', ?, 'oidc', 'c', 1, 1, 2, 2)",
      [user.id],
    );
    await expect(run(env.DB, 'DELETE FROM users WHERE id = ?', [user.id])).rejects.toThrow(
      /credential transfer required/,
    );
    expect(
      (
        await first<{ owner_user_id: string | null }>(
          env.DB,
          'SELECT owner_user_id FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.owner_user_id,
    ).toBe(user.id);
    expect(await first(env.DB, "SELECT 1 FROM sessions WHERE id_hash = 'h'")).not.toBeNull();
  });

  it('cascades sessions when deleting a user without an owned pass', async () => {
    const f = fixtures(await makeEnv());
    const user = await makeUser(f);
    await run(
      env.DB,
      "INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at) VALUES ('h-cascade', ?, 'oidc', 'c', 1, 1, 2, 2)",
      [user.id],
    );
    await run(env.DB, 'DELETE FROM users WHERE id = ?', [user.id]);
    expect(await first(env.DB, "SELECT 1 FROM sessions WHERE id_hash = 'h-cascade'")).toBeNull();
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
    ).rejects.toThrow(/UNIQUE constraint failed: signing_identities\.is_default/);
    await expect(
      run(
        env.DB,
        "INSERT INTO signing_identities (id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at) VALUES ('c', 'C', 'pass.im.plrs.wallet', 'T', 'env', 'C', 1)",
      ),
    ).rejects.toThrow(/UNIQUE constraint failed: signing_identities\.pass_type_identifier/);
  });
});

describe('0014_scan migration', () => {
  let seq = 0;
  const insertEvent = (orgId: string, over: Record<string, string | number | null> = {}) => {
    const row = {
      id: `ev-${++seq}`,
      org_id: orgId,
      mode: 'live',
      name: 'Gala',
      match_input: null,
      match_values: null,
      opens_at: 10,
      closes_at: 20,
      time_zone: 'UTC',
      note: null,
      created_at: 1,
      updated_at: 1,
      ...over,
    };
    const keys = Object.keys(row);
    return run(
      env.DB,
      `INSERT INTO scan_events (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  };

  const insertScanner = (orgId: string, over: Record<string, string | number | null> = {}) => {
    const row = {
      id: `sc-${++seq}`,
      org_id: orgId,
      mode: 'live',
      kind: 'device',
      name: 'Door',
      settings: '{}',
      time_zone: 'UTC',
      created_at: 1,
      updated_at: 1,
      ...over,
    };
    const keys = Object.keys(row);
    return run(
      env.DB,
      `INSERT INTO scanners (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  };

  it('creates the scan tables and passes.lookup_hash', async () => {
    const rows = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = new Set(rows.map((r) => r.name));
    for (const table of [
      'scan_events',
      'scan_event_templates',
      'scan_staff',
      'scanners',
      'scanner_templates',
      'scans',
      'scan_gates',
      'vas_keys',
    ]) {
      expect(names, table).toContain(table);
    }
    const columns = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM pragma_table_info('passes')",
    );
    expect(columns.map((c) => c.name)).toContain('lookup_hash');
  });

  it('accepts the scanner audit actor and keeps every audit index', async () => {
    await run(
      env.DB,
      "INSERT INTO audit_log (at, actor_type, actor_id, action) VALUES (1, 'scanner', 'sc-1', 'scanner.paired')",
    );
    const indexes = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM pragma_index_list('audit_log')",
    );
    const names = new Set(indexes.map((i) => i.name));
    for (const index of ['audit_org', 'audit_target', 'audit_at', 'audit_actor', 'audit_action']) {
      expect(names, index).toContain(index);
    }
    await expect(
      run(
        env.DB,
        "INSERT INTO audit_log (at, actor_type, action) VALUES (1, 'robot', 'scanner.paired')",
      ),
    ).rejects.toThrow(
      /CHECK constraint failed: actor_type IN \('user', 'api_key', 'system', 'connection/,
    );
  });

  it('keeps scan_gates WITHOUT ROWID with the pass, action, scope key', async () => {
    const sql = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE name = 'scan_gates'",
    );
    expect(sql?.sql).toMatch(/WITHOUT ROWID/);
    const pk = await all<{ name: string; pk: number }>(
      env.DB,
      "SELECT name, pk FROM pragma_table_info('scan_gates') WHERE pk > 0 ORDER BY pk",
    );
    expect(pk.map((c) => c.name)).toEqual(['pass_id', 'action_id', 'scope']);
  });

  it('indexes scans_pass_ok as a partial index on ok outcomes', async () => {
    const row = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE name = 'scans_pass_ok'",
    );
    expect(row?.sql).toMatch(/WHERE outcome = 'ok'/);
  });

  it('rejects a bad mode, a backwards window, a match half and a long note', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await expect(insertEvent(org.id, { mode: 'staging' })).rejects.toThrow(
      /CHECK constraint failed: mode IN \('live', 'test'\)/,
    );
    await expect(insertEvent(org.id, { closes_at: 10 })).rejects.toThrow(
      /CHECK constraint failed: closes_at > opens_at/,
    );
    await expect(insertEvent(org.id, { closes_at: 5 })).rejects.toThrow(
      /CHECK constraint failed: closes_at > opens_at/,
    );
    await expect(insertEvent(org.id, { match_input: 'tier' })).rejects.toThrow(
      /CHECK constraint failed: \(match_input IS NULL\) = \(match_values IS NULL\)/,
    );
    await expect(insertEvent(org.id, { match_values: '["gold"]' })).rejects.toThrow(
      /CHECK constraint failed: \(match_input IS NULL\) = \(match_values IS NULL\)/,
    );
    await expect(insertEvent(org.id, { note: 'x'.repeat(141) })).rejects.toThrow(
      /CHECK constraint failed: note IS NULL OR length\(note\) <= 140/,
    );
    await insertEvent(org.id, { note: 'x'.repeat(140) });
    await expect(insertScanner(org.id, { mode: 'staging' })).rejects.toThrow(
      /CHECK constraint failed: mode IN \('live', 'test'\)/,
    );
  });

  it('keeps a csrf secret to browser devices and the token columns paired', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await expect(
      insertScanner(org.id, { kind: 'terminal', csrf_secret: 'secret' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertScanner(org.id, { token_hash: 'h' })).rejects.toThrow(
      /CHECK constraint failed: \(token_hash IS NULL\) = \(token_prefix IS NULL\)/,
    );
    await insertScanner(org.id, { token_prefix: 'abcd1234', token_hash: 'h', csrf_secret: 's' });
  });

  it('splits devices, terminals and displays by device role', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await expect(insertScanner(org.id, { name: 'N1', kind: 'display' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertScanner(org.id, { name: 'N2', kind: 'display', device_role: 'scan' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertScanner(org.id, {
      name: 'N3',
      kind: 'display',
      device_role: 'customer',
      csrf_secret: 's',
    });
    await insertScanner(org.id, { name: 'N4', kind: 'display', device_role: 'monitor' });
    await expect(
      insertScanner(org.id, { name: 'N5', kind: 'terminal', device_role: 'customer' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertScanner(org.id, { name: 'N6', kind: 'terminal', csrf_secret: 's' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertScanner(org.id, { name: 'N7', id: 'sc-role', kind: 'device' });
    const row = await first<{ device_role: string }>(
      env.DB,
      "SELECT device_role FROM scanners WHERE id = 'sc-role'",
    );
    expect(row?.device_role).toBe('scan');
  });

  it('accepts system auto scans and rejects unknown actors and methods', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    let n = 0;
    const insertScan = (over: Record<string, string | number | null>) => {
      const row = {
        id: `scan-${++n}`,
        org_id: org.id,
        mode: 'live',
        actor_type: 'scanner',
        actor_id: 'a',
        actor_key: 'k',
        idempotency_key: `i-${n}`,
        request_hash: 'h',
        method: 'camera',
        at: 1,
        ...over,
      };
      const keys = Object.keys(row);
      return run(
        env.DB,
        `INSERT INTO scans (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        Object.values(row),
      );
    };
    await insertScan({ actor_type: 'system', actor_key: 'sys:occupancy', method: 'auto' });
    await insertScan({ actor_type: 'user' });
    await expect(insertScan({ actor_type: 'robot' })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertScan({ method: 'robot' })).rejects.toThrow(/CHECK constraint failed/);
  });

  it('keeps audit rows and the id sequence through the rebuild', async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0014'));
    const queries = migration?.queries ?? [];
    const from = queries.findIndex((q) => /CREATE TABLE audit_log_next/.test(q));
    expect(from).toBeGreaterThan(-1);
    for (const at of [1, 2, 3])
      await run(
        env.DB,
        "INSERT INTO audit_log (at, actor_type, action) VALUES (?, 'system', 'x.test')",
        [at],
      );
    const before = await all<{ id: number }>(env.DB, 'SELECT id FROM audit_log ORDER BY id');
    // Later migrations hang triggers on audit_log; SQLite refuses the replayed drop and rename
    // while they exist, so lift them for the replay and restore them exactly.
    const triggers = await all<{ name: string; sql: string }>(
      env.DB,
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%audit_log%'",
    );
    for (const t of triggers) await env.DB.prepare(`DROP TRIGGER ${t.name}`).run();
    for (const q of queries.slice(from)) await env.DB.prepare(q).run();
    for (const t of triggers) await env.DB.prepare(t.sql).run();
    const after = await all<{ id: number }>(env.DB, 'SELECT id FROM audit_log ORDER BY id');
    expect(after).toEqual(before);
    await run(
      env.DB,
      "INSERT INTO audit_log (at, actor_type, action) VALUES (4, 'system', 'x.test')",
    );
    const last = await first<{ id: number }>(env.DB, 'SELECT MAX(id) AS id FROM audit_log');
    expect(last?.id).toBe((before.at(-1)?.id ?? 0) + 1);
  });

  it("clears a scanner's event when the event is deleted", async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await insertEvent(org.id, { id: 'ev-del' });
    await insertScanner(org.id, { id: 'sc-del', event_id: 'ev-del' });
    await run(env.DB, "DELETE FROM scan_events WHERE id = 'ev-del'");
    const scanner = await first<{ event_id: string | null }>(
      env.DB,
      "SELECT event_id FROM scanners WHERE id = 'sc-del'",
    );
    expect(scanner?.event_id).toBeNull();
  });
});

describe('0055 attach without a transfer', () => {
  async function waiting() {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const user = await makeUser(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: `tpl-attach-${f.ids.id()}` }).resolved,
      holderEmail: user.primaryEmail,
    });
    const attach = (userId = user.id) =>
      run(env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [userId, pass.id]);
    const owner = async () =>
      (
        await first<{ owner_user_id: string | null }>(
          env.DB,
          'SELECT owner_user_id FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.owner_user_id;
    return { f, org, user, pass, attach, owner };
  }
  const REFUSED = /credential transfer required/;

  it('links the active user whose verified address is the holder email', async () => {
    const { user, attach, owner } = await waiting();
    await attach();
    expect(await owner()).toBe(user.id);
  });

  it('refuses an inactive user', async () => {
    const { user, attach, owner } = await waiting();
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    await expect(attach()).rejects.toThrow(REFUSED);
    expect(await owner()).toBeNull();
  });

  it('refuses a user without a verified address equal to the holder email', async () => {
    const { f, org, attach, owner } = await waiting();
    const other = await makeUser(f);
    await expect(attach(other.id)).rejects.toThrow(REFUSED);
    await expect(attach('no-such-user')).rejects.toThrow(REFUSED);
    expect(await owner()).toBeNull();
    // The holder's address on file but never verified.
    const unverified = await makeUser(f, { verified: false });
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: `tpl-attach-${f.ids.id()}` }).resolved,
      holderEmail: unverified.primaryEmail,
    });
    await expect(
      run(env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [unverified.id, pass.id]),
    ).rejects.toThrow(REFUSED);
    // No holder email at all.
    const bare = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: `tpl-attach-${f.ids.id()}` }).resolved,
    });
    await expect(
      run(env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [other.id, bare.id]),
    ).rejects.toThrow(REFUSED);
  });

  it('refuses a user blocked from the pass', async () => {
    const { user, pass, attach, owner } = await waiting();
    await run(
      env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [pass.id, user.id],
    );
    await expect(attach()).rejects.toThrow(REFUSED);
    expect(await owner()).toBeNull();
  });

  it('refuses a deleted or quarantined pass', async () => {
    for (const set of ['deleted_at = 1', 'test_data_quarantined = 1']) {
      const { pass, attach, owner } = await waiting();
      await run(env.DB, `UPDATE passes SET ${set} WHERE id = ?`, [pass.id]);
      await expect(attach(), set).rejects.toThrow(REFUSED);
      expect(await owner(), set).toBeNull();
    }
  });
});

describe('0052 scanning_devices REPLACE guard', () => {
  it('refuses a REPLACE over the admin device key instead of dropping the other row', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const admin = await makeUser(f);
    const [a, b] = [
      await makeScanner(f, { orgId: org.id }),
      await makeScanner(f, { orgId: org.id }),
    ];
    const session = f.ids.id();
    await run(
      env.DB,
      `INSERT INTO scanning_sessions (id, org_id, mode, name, settings, time_zone, created_at, updated_at)
       VALUES (?, ?, 'live', 'Door', '{}', 'UTC', 1, 1)`,
      [session, org.id],
    );
    const insert = (verb: string, scannerId: string) =>
      run(
        env.DB,
        `${verb} INTO scanning_devices (scanner_id, session_id, org_id, mode, admin_user_id, device_key)
         VALUES (?, ?, ?, 'live', ?, 'phone-1')`,
        [scannerId, session, org.id, admin.id],
      );
    await insert('INSERT', a.id);
    for (const verb of ['INSERT', 'INSERT OR REPLACE'])
      await expect(insert(verb, b.id), verb).rejects.toThrow(
        'UNIQUE constraint failed: scanning_devices.session_id, scanning_devices.admin_user_id, scanning_devices.device_key',
      );
    const rows = await all<{ scanner_id: string }>(
      env.DB,
      'SELECT scanner_id FROM scanning_devices WHERE session_id = ?',
      [session],
    );
    expect(rows).toEqual([{ scanner_id: a.id }]);
    // Without an admin device key the index does not apply.
    await run(
      env.DB,
      `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode) VALUES (?, ?, ?, 'live')`,
      [b.id, session, org.id],
    );
  });
});

describe('0073_scan_zones migration', () => {
  const zone = (id: string, orgId: string, extra: Record<string, unknown> = {}) => {
    const row = { id, org_id: orgId, key: id, name: id, created_at: 1, updated_at: 1, ...extra };
    const keys = Object.keys(row);
    return run(
      env.DB,
      `INSERT INTO scan_zones (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(row) as (string | number | null)[],
    );
  };

  it('checks keys, child time zones and occupancy limits', async () => {
    const org = await makeOrg(fixtures(await makeEnv()));
    await zone('pool', org.id, { time_zone: 'UTC' });
    await zone('lane-1', org.id, { parent_id: 'pool' });
    for (const key of ['Pool', 'a b', '*', '-x', '', 'a'.repeat(41)])
      await expect(zone(`k-${key.length}`, org.id, { key }), key).rejects.toThrow(/CHECK/);
    await expect(zone('child-tz', org.id, { parent_id: 'pool', time_zone: 'UTC' })).rejects.toThrow(
      /CHECK/,
    );
    const bad = [
      { capacity: 5 },
      { occupancy: 'track', capacity: 0 },
      { occupancy: 'track', max_stay_minutes: 5 },
      { occupancy: 'track', clear_at: '24:00' },
      { occupancy: 'track', clear_at: '7:00' },
      { occupancy: 'full' },
    ];
    for (const [i, extra] of bad.entries())
      await expect(zone(`occ-${i}`, org.id, extra), JSON.stringify(extra)).rejects.toThrow(/CHECK/);
    await zone('gym', org.id, {
      occupancy: 'enforce',
      capacity: 40,
      max_stay_minutes: 120,
      clear_at: '03:00',
    });
  });

  it('keeps one active name and one key per org', async () => {
    const f = fixtures(await makeEnv());
    const [a, b] = [await makeOrg(f), await makeOrg(f)];
    await zone('one', a.id, { name: 'Pool' });
    await expect(zone('two', a.id, { name: 'POOL' })).rejects.toThrow(/UNIQUE/);
    await expect(zone('one-b', a.id, { key: 'one', name: 'Other' })).rejects.toThrow(/UNIQUE/);
    await zone('one-b', b.id, { key: 'one', name: 'Pool' });
    await run(env.DB, "UPDATE scan_zones SET archived_at = 5 WHERE id = 'one'");
    await zone('two', a.id, { name: 'Pool' });
  });

  it('cascades from the org and the parent, and indexes every foreign key', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await zone('top', org.id, { time_zone: 'UTC' });
    await zone('sub', org.id, { parent_id: 'top' });
    await run(env.DB, "DELETE FROM scan_zones WHERE id = 'top'");
    expect(await first(env.DB, "SELECT 1 AS x FROM scan_zones WHERE id = 'sub'")).toBeNull();
    await zone('left', org.id);
    await run(env.DB, 'DELETE FROM orgs WHERE id = ?', [org.id]);
    expect(await first(env.DB, "SELECT 1 AS x FROM scan_zones WHERE id = 'left'")).toBeNull();
    for (const table of ['scan_zones', 'scanning_session_zones']) {
      const fks = await all<{ from: string }>(
        env.DB,
        `SELECT "from" FROM pragma_foreign_key_list('${table}')`,
      );
      const indexed = new Set<string>();
      for (const index of await all<{ name: string }>(
        env.DB,
        `SELECT name FROM pragma_index_list('${table}')`,
      ))
        for (const col of await all<{ name: string; seqno: number }>(
          env.DB,
          `SELECT name, seqno FROM pragma_index_info('${index.name}')`,
        ))
          if (col.seqno === 0) indexed.add(col.name);
      // A WITHOUT ROWID primary key is its own index.
      if (table === 'scanning_session_zones') indexed.add('session_id');
      for (const fk of fks) expect(indexed.has(fk.from), `${table}.${fk.from}`).toBe(true);
    }
  });

  it('links a session to a zone, bumps the session epoch on every link change and cascades', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await zone('door', org.id);
    await run(
      env.DB,
      `INSERT INTO scanning_sessions (id, org_id, mode, name, settings, time_zone, created_at, updated_at)
       VALUES ('sess', ?, 'live', 'Door', '{}', 'UTC', 1, 1)`,
      [org.id],
    );
    const epoch = async () =>
      (
        await first<{ e: number }>(
          env.DB,
          "SELECT config_epoch AS e FROM scanning_sessions WHERE id = 'sess'",
        )
      )?.e ?? 0;
    const e0 = await epoch();
    await run(
      env.DB,
      "INSERT INTO scanning_session_zones (session_id, zone_id, sort) VALUES ('sess', 'door', 0)",
    );
    const e1 = await epoch();
    expect(e1).toBeGreaterThan(e0);
    await run(env.DB, "UPDATE scanning_session_zones SET sort = 1 WHERE session_id = 'sess'");
    const e2 = await epoch();
    expect(e2).toBeGreaterThan(e1);
    await run(env.DB, "DELETE FROM scanning_session_zones WHERE session_id = 'sess'");
    expect(await epoch()).toBeGreaterThan(e2);
    await run(
      env.DB,
      "INSERT INTO scanning_session_zones (session_id, zone_id) VALUES ('sess', 'door')",
    );
    await run(env.DB, "DELETE FROM scan_zones WHERE id = 'door'");
    expect(
      await first(env.DB, "SELECT 1 AS x FROM scanning_session_zones WHERE session_id = 'sess'"),
    ).toBeNull();
    await expect(
      run(
        env.DB,
        "INSERT INTO scanning_session_zones (session_id, zone_id) VALUES ('sess', 'gone')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('adds nullable zone, visit and plan columns to scans', async () => {
    const cols = await all<{ name: string; notnull: number }>(
      env.DB,
      "SELECT name, \"notnull\" FROM pragma_table_info('scans') WHERE name IN ('zone_id', 'visit', 'access_plan')",
    );
    expect(cols.map((c) => c.name).sort()).toEqual(['access_plan', 'visit', 'zone_id']);
    expect(cols.every((c) => c.notnull === 0)).toBe(true);
    const index = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE name = 'scans_zone'",
    );
    expect(index?.sql).toContain('WHERE zone_id IS NOT NULL');
  });
});

describe('0074_scan_occupancy migration', () => {
  const scan = (orgId: string, id: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id,
      org_id: orgId,
      mode: 'live',
      actor_type: 'scanner',
      actor_id: 'a',
      actor_key: 'k',
      idempotency_key: id,
      request_hash: 'h',
      method: 'camera',
      at: 1,
      ...extra,
    };
    const keys = Object.keys(row);
    return run(
      env.DB,
      `INSERT INTO scans (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(row) as (string | number | null)[],
    );
  };

  it('checks tap-out causes and override notes', async () => {
    const org = await makeOrg(fixtures(await makeEnv()));
    for (const [i, extra] of [{ out_cause: 'lost' }, { override_note: 'bribe' }].entries())
      await expect(scan(org.id, `bad-${i}`, extra), JSON.stringify(extra)).rejects.toThrow(/CHECK/);
    await scan(org.id, 'cause', { out_cause: 'stay', override_note: 'forgot_out' });
  });

  it('keeps one live override per scan; a lost, failed or undone one frees it', async () => {
    const org = await makeOrg(fixtures(await makeEnv()));
    await scan(org.id, 'held', { state: 'done', outcome: 'heads_up' });
    await scan(org.id, 'lost', { override_of: 'held', state: 'done', outcome: 'heads_up' });
    await scan(org.id, 'failed', { override_of: 'held', state: 'failed' });
    await scan(org.id, 'undone', {
      override_of: 'held',
      state: 'done',
      outcome: 'ok',
      undone_at: 5,
    });
    await scan(org.id, 'pending', { override_of: 'held' });
    await expect(
      scan(org.id, 'second', { override_of: 'held', state: 'done', outcome: 'ok' }),
    ).rejects.toThrow(/UNIQUE/);
    await run(env.DB, "UPDATE scans SET state = 'failed' WHERE id = 'pending'");
    await scan(org.id, 'winner', { override_of: 'held', state: 'done', outcome: 'ok' });
  });

  it('fills mode for writers that name none and orders each pass write by commit', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate({ id: f.ids.id(), orgId: org.id });
    const pass = await makePass(f, { orgId: org.id, template: template.resolved, mode: 'test' });
    const write = (scope: string, scan: string) =>
      run(
        env.DB,
        `INSERT INTO scan_presence (pass_id, org_id, scope, state, first_at, last_entry_at, last_scan_id)
         VALUES (?, ?, ?, 'in', 1, 1, ?)
         ON CONFLICT (pass_id, scope) DO UPDATE SET prev_scan_id = last_scan_id, last_scan_id = excluded.last_scan_id`,
        [pass.id, org.id, scope, scan],
      );
    const rows = () =>
      all<{ scope: string; mode: string; seq: number; prev_seq: number | null }>(
        env.DB,
        'SELECT scope, mode, seq, prev_seq FROM scan_presence WHERE pass_id = ? ORDER BY scope',
        [pass.id],
      );
    await write('zone:a', 's1');
    await write('zone:b', 's2');
    await write('zone:a', 's3');
    expect(await rows()).toEqual([
      { scope: 'zone:a', mode: 'test', seq: 3, prev_seq: 1 },
      { scope: 'zone:b', mode: 'test', seq: 2, prev_seq: null },
    ]);
    // A restore (no prev_scan_id) keeps the sequence the undo writes.
    await run(
      env.DB,
      "UPDATE scan_presence SET last_scan_id = 's1', prev_scan_id = NULL, seq = 1, prev_seq = NULL WHERE scope = 'zone:a' AND pass_id = ?",
      [pass.id],
    );
    expect((await rows())[0]).toMatchObject({ seq: 1, prev_seq: null });
    expect(
      await first(env.DB, "SELECT 1 AS x FROM sqlite_master WHERE name = 'scan_presence_org'"),
    ).toBeNull();
    // The pass decides the mode: a writer that names another one is refused, the same one is kept.
    const named = (scope: string, mode: string) =>
      run(
        env.DB,
        `INSERT INTO scan_presence (pass_id, org_id, scope, state, first_at, last_entry_at, last_scan_id, mode)
         VALUES (?, ?, ?, 'in', 1, 1, 's9', ?)`,
        [pass.id, org.id, scope, mode],
      );
    await expect(named('zone:c', 'live')).rejects.toThrow(/mode differs from its pass/);
    await named('zone:d', 'test');
    expect((await rows()).find((r) => r.scope === 'zone:d')?.mode).toBe('test');
  });

  it('adds due_at with a partial index and per-place revisions that cascade with the org', async () => {
    const index = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE name = 'scan_presence_due'",
    );
    expect(index?.sql).toMatch(/WHERE due_at IS NOT NULL/);
    const org = await makeOrg(fixtures(await makeEnv()));
    const rev = (r: number, mode = 'live') =>
      run(env.DB, 'INSERT INTO scan_place_revs (org_id, mode, place, rev) VALUES (?, ?, ?, ?)', [
        org.id,
        mode,
        `zone:${r}-${mode}`,
        r,
      ]);
    await expect(rev(0)).rejects.toThrow(/CHECK/);
    await expect(rev(1, 'demo')).rejects.toThrow(/CHECK/);
    await rev(1);
    await run(env.DB, 'DELETE FROM orgs WHERE id = ?', [org.id]);
    expect(
      await first(env.DB, 'SELECT 1 AS x FROM scan_place_revs WHERE org_id = ?', [org.id]),
    ).toBeNull();
  });
});
