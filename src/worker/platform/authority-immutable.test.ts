import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { EPOCH_TABLES } from './authority-columns.ts';
import { seedAuthority } from './authority-test-fixtures.ts';
import { all, first, run, type SqlValue } from './db.ts';

const db = env.DB;
const EPOCH_COLUMNS = new Set(EPOCH_TABLES.flatMap((t) => Object.keys(t.epochs)));
type Row = Record<string, SqlValue>;
/** A guard trigger or a unique key refused it; never a malformed statement. */
const GUARD = /UNIQUE constraint failed|immutable|retired|invalid|authority/;

const snapshot = async (table: string, key: string, id: string) =>
  first<Row>(db, `SELECT * FROM ${table} WHERE ${key} = ?`, [id]);

async function bumpEpoch(table: string, id: string, epoch: string) {
  await run(db, `UPDATE ${table} SET ${epoch} = ${epoch} + 5 WHERE id = ?`, [id]);
}

/**
 * Every way to overwrite an existing row through an INSERT: the row must be untouched and the
 * statement must fail. `overrides` change one non-key column; `via` replaces the key by another id
 * while keeping a unique value, which REPLACE would evict.
 */
async function expectNoOverwrite(
  table: string,
  key: string,
  id: string,
  overrides: Row,
  via: Row[] = [],
) {
  const before = await snapshot(table, key, id);
  expect(before, `${table} seed`).not.toBeNull();
  const columns = Object.keys(before as Row).filter((c) => !EPOCH_COLUMNS.has(c));
  const values = (extra: Row) =>
    columns.map((c) => (c in extra ? extra[c] : (before as Row)[c]) as SqlValue);
  const list = columns.join(', ');
  const marks = columns.map(() => '?').join(', ');
  const attempts: [string, SqlValue[]][] = [];
  for (const extra of [overrides, ...via]) {
    attempts.push([`INSERT OR REPLACE INTO ${table} (${list}) VALUES (${marks})`, values(extra)]);
    attempts.push([`REPLACE INTO ${table} (${list}) VALUES (${marks})`, values(extra)]);
  }
  const updates = columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`);
  attempts.push([
    `INSERT INTO ${table} (${list}) VALUES (${marks}) ON CONFLICT(${key}) DO UPDATE SET ${updates.join(', ')}`,
    values(overrides),
  ]);
  for (const [sql, params] of attempts) {
    await expect(run(db, sql, params), sql.slice(0, 40)).rejects.toThrow(GUARD);
    expect(await snapshot(table, key, id), `${table} after ${sql.slice(0, 30)}`).toEqual(before);
  }
}

describe('REPLACE and UPSERT never overwrite a guarded row', () => {
  it('Rule-2 tables: memberships, invitations, api keys, staff, events, sessions', async () => {
    const s = await seedAuthority('imm-rule2');
    await expectNoOverwrite('org_memberships', 'id', s.membershipId, { roles: '["read_only"]' });
    await expectNoOverwrite('org_invitations', 'id', s.invitationId, { roles: '["read_only"]' });
    await expectNoOverwrite('api_keys', 'id', s.key.id, { scopes: '["passes:read"]' });
    await expectNoOverwrite('scan_staff', 'id', s.staff.id, { role: 'manager' });
    await expectNoOverwrite('scan_events', 'id', s.event.id, { name: 'Other' });
    await expectNoOverwrite('scanning_sessions', 'id', s.scanningSessionId, { status: 'ended' });
  });

  it('Rule-2 rows keep their unique keys against eviction by a different id', async () => {
    const s = await seedAuthority('imm-unique');
    const key = (await snapshot('api_keys', 'id', s.key.id)) as Row;
    const stolen = { id: 'evicted-key', name: 'x' };
    await expectNoOverwrite('api_keys', 'id', s.key.id, { scopes: '["passes:read"]' }, [stolen]);
    const second = (await snapshot('api_keys', 'id', s.key.id)) as Row;
    expect(second.key_hash).toBe(key.key_hash);
    const invitation = (await snapshot('org_invitations', 'id', s.invitationId)) as Row;
    await expectNoOverwrite('org_invitations', 'id', s.invitationId, { roles: '["read_only"]' }, [
      { id: 'evicted-invite', token_hash: invitation.token_hash },
    ]);
    await expectNoOverwrite('org_memberships', 'id', s.membershipId, { roles: '["read_only"]' }, [
      { id: 'evicted-membership' },
    ]);
  });

  it('epoch tables: orgs, passes, scanners, connections, with the epoch never decreasing', async () => {
    const s = await seedAuthority('imm-epochs');
    await bumpEpoch('orgs', s.org.id, 'config_revision');
    await bumpEpoch('passes', s.pass.id, 'row_version');
    await bumpEpoch('scanners', s.scannerId, 'credential_epoch');
    await bumpEpoch('connections', s.connectionId, 'generation');
    await bumpEpoch('scan_staff', s.staff.id, 'auth_epoch');
    await bumpEpoch('scan_events', s.event.id, 'config_epoch');
    await expectNoOverwrite('orgs', 'id', s.org.id, { name: 'Other' }, [{ id: 'evicted-org' }]);
    await expectNoOverwrite('passes', 'id', s.pass.id, { display_title: 'Other' });
    await expectNoOverwrite('scanners', 'id', s.scannerId, { time_zone: 'Asia/Tokyo' });
    await expectNoOverwrite('connections', 'id', s.connectionId, { name: 'Other' });
    for (const [table, id, column] of [
      ['orgs', s.org.id, 'config_revision'],
      ['passes', s.pass.id, 'row_version'],
      ['scanners', s.scannerId, 'credential_epoch'],
    ] as const) {
      const row = await first<Record<string, number>>(
        db,
        `SELECT ${column} AS v FROM ${table} WHERE id = ?`,
        [id],
      );
      expect(row?.v, `${table}.${column}`).toBeGreaterThan(1);
    }
  });

  it('sessions, template_versions and the credential keyset rely on their existing guards', async () => {
    const s = await seedAuthority('imm-existing');
    const idHash =
      (
        await first<{ id_hash: string }>(db, 'SELECT id_hash FROM sessions WHERE user_id = ?', [
          s.user.id,
        ])
      )?.id_hash ?? '';
    await expectNoOverwrite('sessions', 'id_hash', idHash, { user_id: s.admin.id });
    const version = await first<Row>(
      db,
      'SELECT template_id, version FROM template_versions WHERE template_id = ?',
      [s.template.resolved.id],
    );
    expect(version).not.toBeNull();
    const before = await all<Row>(db, 'SELECT * FROM template_versions WHERE template_id = ?', [
      s.template.resolved.id,
    ]);
    await expect(
      run(
        db,
        "INSERT OR REPLACE INTO template_versions (template_id, version, manifest, pass_json, assets, created_at) VALUES (?, ?, '{}', '{}', '{}', 1)",
        [version?.template_id as string, version?.version as string],
      ),
    ).rejects.toThrow();
    expect(
      await all<Row>(db, 'SELECT * FROM template_versions WHERE template_id = ?', [
        s.template.resolved.id,
      ]),
    ).toEqual(before);
    const keyset = await all<Row>(db, 'SELECT * FROM credential_ref_keyset');
    if (keyset.length > 0) {
      await expect(
        run(db, 'INSERT OR REPLACE INTO credential_ref_keyset (id, commitment) VALUES (?, ?)', [
          keyset[0]?.id as number,
          'f'.repeat(64),
        ]),
      ).rejects.toThrow();
      await expect(
        run(db, 'UPDATE credential_ref_keyset SET commitment = ?', ['f'.repeat(64)]),
      ).rejects.toThrow();
      expect(await all<Row>(db, 'SELECT * FROM credential_ref_keyset')).toEqual(keyset);
    }
  });
});

describe('Rule-2 immutable inputs', () => {
  it('sessions: roles and amr cannot change; a revoke still can', async () => {
    const s = await seedAuthority('imm-sessions');
    const where = 'user_id = ?';
    await expect(
      run(db, `UPDATE sessions SET roles = '["admin","user"]' WHERE ${where}`, [s.user.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(db, `UPDATE sessions SET amr = 'breakglass' WHERE ${where}`, [s.user.id]),
    ).rejects.toThrow(/immutable/);
    await run(db, `UPDATE sessions SET revoked_at = 5, last_seen_at = 6 WHERE ${where}`, [
      s.user.id,
    ]);
    const row = await first<Row>(db, `SELECT roles, amr, revoked_at FROM sessions WHERE ${where}`, [
      s.user.id,
    ]);
    expect(row).toEqual({ roles: '["user"]', amr: 'oidc', revoked_at: 5 });
  });

  it('memberships and invitations accept only known, distinct role names', async () => {
    const s = await seedAuthority('imm-roles');
    const invite = (roles: string) =>
      run(
        db,
        "INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at) VALUES (?, ?, 'r@example.test', ?, ?, 1, 2)",
        [s.f.ids.id(), s.org.id, roles, s.f.ids.token()],
      );
    await expect(invite('["owner"]')).rejects.toThrow(/invalid role names/);
    await expect(invite('["org_admin","org_admin"]')).rejects.toThrow(/invalid role names/);
    await expect(invite('[1]')).rejects.toThrow();
    await expect(invite('["read_only","pass_operator"]')).resolves.toBeDefined();
    const freshInvite = s.f.ids.id();
    await run(
      db,
      "INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at) VALUES (?, ?, 'm@example.test', '[\"read_only\"]', ?, 1, 2)",
      [freshInvite, s.org.id, s.f.ids.token()],
    );
    const member = (roles: string) =>
      run(
        db,
        'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, 1)',
        [s.f.ids.id(), s.org.id, s.admin.id, freshInvite, roles],
      );
    await expect(member('["superuser"]')).rejects.toThrow(/invalid role names/);
  });

  it('fixed columns reject any change, on every epoch table', async () => {
    const s = await seedAuthority('imm-fixed');
    const ids: Record<string, string> = {
      orgs: s.org.id,
      passes: s.pass.id,
      scanners: s.scannerId,
      scan_staff: s.staff.id,
      scan_events: s.event.id,
      scanning_sessions: s.scanningSessionId,
      connections: s.connectionId,
    };
    for (const t of EPOCH_TABLES) {
      for (const column of t.fixed) {
        const value =
          column === 'id' ? "'moved-id'" : column === 'created_at' ? '987654' : "'someone'";
        await expect(
          run(db, `UPDATE ${t.table} SET ${column} = ${value} WHERE id = ?`, [
            ids[t.table] as string,
          ]),
          `${t.table}.${column}`,
        ).rejects.toThrow();
      }
    }
  });
});
