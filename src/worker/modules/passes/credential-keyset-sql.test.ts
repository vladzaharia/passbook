import { describe, expect, it } from 'vitest';
import {
  assetGrant,
  envA,
  envB,
  expectKeysetInitializationBlocked,
  installKeysetTestEnv,
  unavailable,
} from '../../../../test/helpers/credential-keyset.ts';
import { fixtures, makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run, stmt } from '../../platform/db.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from './credential-keyset.ts';
import {
  credentialRefKeysetInitializeStmt,
  credentialRefKeysetSql,
} from './repo-credential-keyset.ts';

const makeEnv = installKeysetTestEnv();

describe.sequential('credential keyset SQL guards', () => {
  it('checks the reference stores in the same D1 transaction as initialization', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    let intervened = false;
    const raced = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            intervened = true;
            await assetGrant(target, org.id, JSON.stringify(['d'.repeat(64)]));
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(ensureCredentialRefKeyset(raced, envA)).rejects.toMatchObject(unavailable);
    expect(intervened).toBe(true);
    expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
    expect(await first(db, 'SELECT token_hash FROM scan_asset_grant_provenance')).toEqual({
      token_hash: 'a'.repeat(64),
    });
  });

  it('composes guarded first-use initialization with a D1 read', async () => {
    const { DB: db } = await makeEnv();
    const commitment = await credentialRefKeysetCommitment(envA);
    const [blocked, absent] = await db.batch<{ matches: number }>([
      credentialRefKeysetInitializeStmt(db, commitment, { sql: '? = ?', params: [1, 0] }),
      stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
    ]);
    expect(blocked?.meta.changes).toBe(0);
    expect(absent?.results).toEqual([]);
    const [insert, read] = await db.batch<{ matches: number }>([
      credentialRefKeysetInitializeStmt(db, commitment, { sql: '? = ?', params: [1, 1] }),
      stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
    ]);
    expect(insert?.meta.changes).toBe(1);
    expect(read?.results).toEqual([{ matches: 1 }]);
    expect(() => credentialRefKeysetInitializeStmt(db, 'NOT-A-COMMITMENT')).toThrow();
  });

  it('keeps event and authorization guards shallow during first-use initialization', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    const db = f.env.DB;
    const eventId = f.ids.id();
    await run(
      db,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
      VALUES (?, ?, ?, 'live', 'scan.checked_in', ?, ?)`,
      [
        eventId,
        org.id,
        pass.id,
        JSON.stringify({ legacy: { customToken: 'opaque' } }),
        f.clock.now(),
      ],
    );

    // Remain below D1's bind limit while exercising a substantial caller-supplied predicate.
    const sql = Array.from({ length: 50 }, () => '? = 1').join(' AND ');
    const params = Array.from({ length: 50 }, () => 1);
    const commitment = await credentialRefKeysetCommitment(envA);
    const [blocked] = await db.batch([
      credentialRefKeysetInitializeStmt(db, commitment, { sql, params }),
    ]);
    expect(blocked?.meta.changes).toBe(0);
    await expectKeysetInitializationBlocked(db);

    await run(db, 'DELETE FROM pass_events WHERE id = ?', [eventId]);
    await run(
      db,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
      VALUES (?, ?, ?, 'live', 'scan.checked_in', ?, ?)`,
      [
        f.ids.id(),
        org.id,
        pass.id,
        JSON.stringify({ legacy: { customToken: null } }),
        f.clock.now(),
      ],
    );
    const [unauthorized, absent] = await db.batch<{ matches: number }>([
      credentialRefKeysetInitializeStmt(db, commitment, {
        sql,
        params: [...params.slice(0, -1), 0],
      }),
      stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
    ]);
    expect(unauthorized?.meta.changes).toBe(0);
    expect(absent?.results).toEqual([]);

    const [initialized, present] = await db.batch<{ matches: number }>([
      credentialRefKeysetInitializeStmt(db, commitment, { sql, params }),
      stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
    ]);
    expect(initialized?.meta.changes).toBe(1);
    expect(present?.results).toEqual([{ matches: 1 }]);
  });

  it('initializes after ordered reference migrations without rebinding surviving refs', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    const names = [
      '0041_scan_event_retention_provenance.sql',
      '0042_pass_credential_generation.sql',
      '0044_connection_item_claims.sql',
      '0046_scan_asset_grant_provenance.sql',
      '0050_passes_credential_guard_depth.sql',
    ];
    const applied = await all<{ name: string }>(
      db,
      'SELECT name FROM d1_migrations WHERE name IN (?, ?, ?, ?, ?) ORDER BY id',
      names,
    );
    expect(applied.map((row) => row.name)).toEqual(names);
    expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
    expect(await ensureCredentialRefKeyset(db, envA)).toBe(
      await credentialRefKeysetCommitment(envA),
    );
    await assetGrant(db, org.id, JSON.stringify(['d'.repeat(64)]));
    expect(await ensureCredentialRefKeyset(db, envA)).toBe(
      await credentialRefKeysetCommitment(envA),
    );
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_delete');
    try {
      await run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1');
      await expectKeysetInitializationBlocked(db, envB);
    } finally {
      await run(
        db,
        `CREATE TRIGGER credential_ref_keyset_no_delete BEFORE DELETE ON credential_ref_keyset
        BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
      );
    }
  });

  it('requires the captured commitment in the final SQL, even when no refs are selected', async () => {
    const { DB: db } = await makeEnv();
    await run(db, "INSERT INTO counters (key, window_start, count) VALUES ('fence', 1, 0)");
    const guardedUpdate = `UPDATE counters SET count = count + 1 WHERE key = 'fence' AND ${credentialRefKeysetSql}`;
    const expected = await credentialRefKeysetCommitment(envA);
    expect(await run(db, guardedUpdate, [expected])).toEqual({ changes: 0 });
    const captured = await ensureCredentialRefKeyset(db, envA);
    const other = await credentialRefKeysetCommitment(envB);
    expect(await run(db, guardedUpdate, [other])).toEqual({ changes: 0 });
    expect(
      await first(db, "SELECT count FROM counters WHERE key = 'fence' AND window_start = 1"),
    ).toEqual({ count: 0 });
    expect(await run(db, guardedUpdate, [captured])).toEqual({ changes: 1 });
    expect(
      await first(db, "SELECT count FROM counters WHERE key = 'fence' AND window_start = 1"),
    ).toEqual({ count: 1 });
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
    try {
      await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [other]);
      expect(await run(db, guardedUpdate, [captured])).toEqual({ changes: 0 });
      await expect(requireCredentialRefKeyset(db, envA)).rejects.toMatchObject(unavailable);
      expect(
        await first(db, "SELECT count FROM counters WHERE key = 'fence' AND window_start = 1"),
      ).toEqual({ count: 1 });
    } finally {
      await run(
        db,
        `CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
        BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
      );
    }
  });
});
