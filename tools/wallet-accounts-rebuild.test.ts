// 0112 rebuilds wallet_provider_accounts to relax one CHECK. Everything else must come through unchanged: the
// schema (tables, indexes, triggers, views) differs only in that CHECK, and rows, children and FKs survive.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = resolve(import.meta.dirname, '../migrations');
const OLD_CHECK = `CHECK ((revision = 0 AND credential_id IS NULL AND revoked_at IS NULL)
    OR (revision > 0 AND credential_id IS NOT NULL))`;
const NEW_CHECK = 'CHECK ((revision = 0) = (credential_id IS NULL))';

const names = readdirSync(migrations)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const before0112 = names.filter((n) => n < '0112');
const wallet = readFileSync(resolve(migrations, '0112_wallet_credentials.sql'), 'utf8');
const rebuild = /-- rebuild:begin\n([\s\S]*?)-- rebuild:end/.exec(wallet)?.[1] ?? '';

type Master = { type: string; name: string; tbl_name: string; sql: string | null };
const dump = (db: DatabaseSync) =>
  (
    db
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all() as Master[]
  ).map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql}`);

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const name of before0112) db.exec(readFileSync(resolve(migrations, name), 'utf8'));
  return db;
}

/** Rows in the account table and in every child that points at it, with foreign keys enforced. */
function seed(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    `INSERT INTO orgs (id, slug, name, status, created_at, updated_at) VALUES ('o1', 'o1', 'O', 'active', 1, 1)`,
  );
  db.exec(
    `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES ('fresh', 'o1', 'live', 'google', 1, 1)`,
  );
  db.exec(
    `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES ('legacy', 'o1', 'test', 'google', 1, 1)`,
  );
  db.exec(
    `INSERT INTO wallet_provider_credentials (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('c1', 'legacy', 'o1', 'test', 'google', 1, x'00', x'00', x'00', 1)`,
  );
  db.exec(
    `INSERT INTO users (id, primary_email, status, created_at) VALUES ('u1', 'u@example.test', 'active', 1)`,
  );
  db.exec(
    `INSERT INTO wallet_provider_account_events (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, created_at) VALUES ('e1', 'legacy', 'o1', 'test', 'google', 1, 'configure', 'c1', 'u1', 5)`,
  );
  db.exec(
    `UPDATE wallet_provider_accounts SET revision = 1, credential_id = 'c1', updated_at = 5 WHERE id = 'legacy'`,
  );
}

describe('0112 rebuild of wallet_provider_accounts', () => {
  it('changes only the CHECK: every table, index, trigger and view is otherwise identical', () => {
    expect(rebuild).toContain('DROP TABLE wallet_provider_accounts');
    const db = migrated();
    const before = dump(db);
    db.exec('BEGIN');
    db.exec(rebuild);
    db.exec('COMMIT');
    const after = dump(db);
    expect(after.length).toBe(before.length);
    const changed = after.filter((row) => !before.includes(row));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('CREATE TABLE wallet_provider_accounts');
    const was = before.find((row) => row.startsWith('table|wallet_provider_accounts|'));
    expect(was).toContain(OLD_CHECK);
    expect(changed[0]).toBe(was?.replace(OLD_CHECK, NEW_CHECK));
    expect(before.filter((row) => !after.includes(row))).toEqual([was]);
  });

  it('keeps every row and child, passes the foreign key check, and the CHECK now follows revision', () => {
    const db = migrated();
    seed(db);
    const rows = () => db.prepare('SELECT * FROM wallet_provider_accounts ORDER BY id').all();
    const before = rows();
    const children = () =>
      db
        .prepare(
          `SELECT (SELECT count(*) FROM wallet_provider_credentials) AS c, (SELECT count(*) FROM wallet_provider_account_events) AS e`,
        )
        .get();
    const kids = children();
    // As D1 applies a migration: one transaction, foreign keys on.
    db.exec('BEGIN');
    db.exec(rebuild);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('COMMIT');
    expect(rows()).toEqual(before);
    expect(children()).toEqual(kids);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const insert = (
      id: string,
      revision: number,
      credential: string | null,
      revoked: number | null,
    ) =>
      db
        .prepare(
          `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, revision, credential_id, revoked_at, created_at, updated_at) VALUES (?, 'o1', 'live', 'samsung', ?, ?, ?, 1, 1)`,
        )
        .run(id, revision, credential, revoked);
    // A legacy row (revision > 0) still needs its credential_id, and revision 0 still means none.
    expect(() => insert('x1', 1, null, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('x2', 0, 'c1', null)).toThrow(/CHECK constraint failed/);
    insert('x3', 0, null, 9);
  });
});
