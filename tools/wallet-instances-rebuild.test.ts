// 0114 rebuilds wallet_provider_instances to widen UNIQUE (pass_id, provider, credential_generation) with
// channel_epoch. D1 cannot rename the table aside (it rewrites the children), and dropping it cascades, so the
// block copies the whole closure (the table, its 8 children and their 3 children), drops it leaf first and
// restores it. Everything else must come through identical: the schema differs only in the four listed objects
// plus what the rest of the migration adds; every row and every foreign key survives.
import { describe, expect, it } from 'vitest';
import {
  CLOSURE,
  dump,
  migratedBefore,
  migrationFile,
  read,
  seedInstances,
  seedParents,
  withoutTriggers,
} from './wallet-instances-fixtures.ts';

const file = read(migrationFile('0114'));
const rebuild = /-- rebuild:begin\n([\s\S]*?)-- rebuild:end/.exec(file)?.[1] ?? '';
const rest = file.slice(file.indexOf('-- rebuild:end') + '-- rebuild:end'.length);

const CHANGED = [
  'index|wallet_provider_instances_one_active|',
  'table|wallet_provider_instances|',
  'trigger|wallet_provider_generation_insert_guard|',
  'trigger|wallet_provider_instances_identity_immutable|',
];
const ADDED = [
  'index|channel_apply_marks_pass|',
  'index|channel_apply_runs_due|',
  'index|channel_apply_runs_pending|',
  'index|channel_apply_runs_running|',
  'index|channel_apply_runs_template|',
  'index|sqlite_autoindex_channel_apply_runs_1|',
  'table|channel_apply_marks|',
  'table|channel_apply_runs|',
  'trigger|channel_apply_marks_once|',
  'trigger|channel_apply_marks_tenant|',
  'trigger|channel_apply_runs_insert|',
  'trigger|channel_apply_runs_key|',
  'trigger|channel_apply_runs_state|',
  'trigger|channel_apply_runs_tenant|',
  'trigger|pass_channels_provider_dirty_insert|',
  'trigger|pass_channels_provider_dirty_update|',
  'trigger|wallet_provider_instances_channel_off|',
  'trigger|wallet_provider_instances_successor|',
];
const key = (row: string) => row.split('|').slice(0, 2).join('|');
const starts = (rows: string[], prefix: string) => rows.filter((r) => r.startsWith(prefix));

describe('0114 rebuild of wallet_provider_instances', () => {
  it('has the rebuild block', () => {
    expect(rebuild).toContain('DROP TABLE wallet_provider_instances;');
    for (const table of CLOSURE) {
      expect(rebuild).toContain(`CREATE TABLE _keep_${table} AS`);
      expect(rebuild).toContain(`DROP TABLE _keep_${table};`);
    }
  });

  it('changes only the table, its one-active index and two triggers; every other object is identical', () => {
    const db = migratedBefore('0114');
    const before = dump(db);
    db.exec('BEGIN');
    db.exec(rebuild);
    db.exec('COMMIT');
    const after = dump(db);
    expect(after.length).toBe(before.length);
    const gone = before.filter((row) => !after.includes(row));
    const added = after.filter((row) => !before.includes(row));
    expect(gone.map(key).sort()).toEqual(CHANGED.map((c) => c.slice(0, -1)));
    expect(added.map(key).sort()).toEqual(CHANGED.map((c) => c.slice(0, -1)));

    const was = (name: string) => gone.find((row) => key(row) === name) as string;
    const now = (name: string) => added.find((row) => key(row) === name) as string;
    const t = 'table|wallet_provider_instances';
    expect(now(t)).toBe(
      was(t)
        .replace(
          'credential_generation >= 1),\n',
          `credential_generation >= 1),
  channel_epoch INTEGER NOT NULL DEFAULT 1 CHECK (typeof(channel_epoch) = 'integer' AND channel_epoch BETWEEN 1 AND 16),
  retirement_cause TEXT CHECK (retirement_cause IS NULL OR retirement_cause = 'channel_off'),
`,
        )
        .replace(
          'UNIQUE (pass_id, provider, credential_generation),\n',
          `UNIQUE (pass_id, provider, credential_generation, channel_epoch),
  CHECK (retirement_cause IS NULL OR retirement_requested_at IS NOT NULL),
`,
        ),
    );
    expect(now('index|wallet_provider_instances_one_active')).toBe(
      was('index|wallet_provider_instances_one_active').replace(
        "WHERE lifecycle NOT IN ('blocked', 'retired')",
        "WHERE lifecycle NOT IN ('blocked', 'retired')\n  AND NOT (lifecycle = 'revoked' AND retirement_cause IS NOT NULL)",
      ),
    );
    expect(now('trigger|wallet_provider_instances_identity_immutable')).toBe(
      was('trigger|wallet_provider_instances_identity_immutable').replace(
        'provider, credential_generation ON',
        'provider, credential_generation, channel_epoch ON',
      ),
    );
    const guard = 'trigger|wallet_provider_generation_insert_guard';
    expect(now(guard)).toBe(
      was(guard)
        .replace(
          "WHEN NEW.lifecycle != 'blocked'",
          "WHEN NEW.channel_epoch = 1 AND (NEW.lifecycle != 'blocked'",
        )
        .replace('\nBEGIN SELECT RAISE', '\n)\nBEGIN SELECT RAISE'),
    );
  });

  it('adds only the new tables, indexes and triggers after the block', () => {
    const db = migratedBefore('0114');
    const before = dump(db);
    db.exec('BEGIN');
    db.exec(file);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('COMMIT');
    const after = dump(db);
    const rebuilt = migratedBefore('0114');
    rebuilt.exec(rebuild);
    const mid = dump(rebuilt);
    expect(rest.length).toBeGreaterThan(0);
    expect(before.length + ADDED.length).toBe(after.length);
    const added = after.filter((row) => !mid.includes(row));
    expect(added.map(key).sort()).toEqual(ADDED.map((c) => c.slice(0, -1)));
    expect(mid.filter((row) => !after.includes(row))).toEqual([]);
    expect(starts(after, 'table|channel_apply_runs|')).toHaveLength(1);
  });

  it('keeps every row of the instances and the 11 tables below them, and passes the foreign key check', () => {
    const db = migratedBefore('0114');
    withoutTriggers(db, () => {
      seedParents(db);
      seedInstances(db);
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const rows = (t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    const before = Object.fromEntries(CLOSURE.map((t) => [t, rows(t)]));
    for (const t of CLOSURE) expect(before[t]?.length, t).toBeGreaterThan(0);
    // As D1 applies a migration: one transaction, foreign keys on.
    db.exec('BEGIN');
    db.exec(rebuild);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('COMMIT');
    for (const t of CLOSURE) {
      const expected =
        t === 'wallet_provider_instances'
          ? before[t]?.map((r) => ({ ...r, channel_epoch: 1, retirement_cause: null }))
          : before[t];
      const got = t === 'wallet_provider_instances' ? rows(t).map((r) => ({ ...r })) : rows(t);
      expect(got.length, t).toBe(expected?.length);
      for (const [i, row] of got.entries())
        expect({ ...row }, `${t}[${i}]`).toEqual(expect.objectContaining({ ...expected?.[i] }));
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps the fences: guards still fire on the rebuilt children, and the cascade still reaches them', () => {
    const db = migratedBefore('0114');
    withoutTriggers(db, () => {
      seedParents(db);
      seedInstances(db);
    });
    db.exec(file);
    // 0043 delete guards on the children are back (a dropped guard would let this through).
    expect(() =>
      db.exec("DELETE FROM wallet_provider_instance_operations WHERE id = 'op-ig-o1'"),
    ).toThrow(/immutable|history|settled|retirement/);
    expect(() => db.exec("DELETE FROM wallet_provider_instances WHERE id = 'ig-o1'")).toThrow(
      /retirement/,
    );
    // The epoch is part of the identity.
    expect(() =>
      db.exec("UPDATE wallet_provider_instances SET channel_epoch = 2 WHERE id = 'ig-o1'"),
    ).toThrow(/identity is immutable/);
    // One row per (pass, provider, generation, epoch).
    // Triggers off, so only the key can refuse it.
    expect(() =>
      withoutTriggers(db, () =>
        db.exec(
          "INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at) VALUES ('dup', 'p1', 'o1', 'live', 'google', 1, 'blocked', 0, 1, 1)",
        ),
      ),
    ).toThrow(/UNIQUE/);
  });
});
