import { expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { BACKFILL_DONE, backfillScanLookups } from './jobs.ts';
import { makeLegacyScanPass, setupScanKit } from './test-kit.ts';

async function keysetTrigger(db: D1Database, name: string): Promise<string> {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    [name],
  );
  if (!trigger?.sql) throw new Error(`Missing keyset trigger: ${name}`);
  return trigger.sql;
}

async function _withMutableKeyset(db: D1Database, commitment: string, work: () => Promise<void>) {
  const trigger = await keysetTrigger(db, 'credential_ref_keyset_no_update');
  await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
  try {
    await work();
  } finally {
    try {
      await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [commitment]);
    } finally {
      await run(db, trigger);
    }
  }
}

it('fails closed on a mismatched credential keyset without marking backfill complete', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Keyset mismatch backfill', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const wrongEnv = { ...kit.env, KEK_V1: btoa('z'.repeat(32)) };
  await expect(backfillScanLookups({ ...jobCtxOf(kit), env: wrongEnv })).rejects.toMatchObject({
    code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
  });
  expect(
    await first(kit.env.DB, 'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id=?', [
      pass.id,
    ]),
  ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
  expect(
    await first(kit.env.DB, "SELECT value FROM settings WHERE scope='system' AND key=?", [
      BACKFILL_DONE,
    ]),
  ).toBeNull();

  await backfillScanLookups(jobCtxOf(kit));
  const row = await first<{ scan_code: string | null }>(
    kit.env.DB,
    'SELECT scan_code FROM passes WHERE id=?',
    [pass.id],
  );
  expect(row?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
});

it('refuses a missing keyset when retained credential references already exist', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Missing backfill keyset', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const commitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const transferId = kit.fx.ids.id();
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: transferId,
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  const ref = await credentialTombstoneRef(
    kit.env,
    kit.org.id,
    'live',
    await sha256Hex(pass.serial),
  );
  await run(
    kit.env.DB,
    `INSERT INTO pass_credential_tombstones
    (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
    SELECT pass_id, org_id, mode, source_generation, 'serial', ?, ?
    FROM pass_credential_transfers WHERE id=?`,
    [ref, kit.clock.now(), transferId],
  );
  const noDelete = await keysetTrigger(kit.env.DB, 'credential_ref_keyset_no_delete');
  const insertGuard = await keysetTrigger(kit.env.DB, 'credential_ref_keyset_insert_guard');
  await run(kit.env.DB, 'DROP TRIGGER credential_ref_keyset_no_delete');
  try {
    await run(kit.env.DB, 'DELETE FROM credential_ref_keyset WHERE id=1');
    await expect(backfillScanLookups(jobCtxOf(kit))).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(
      await first(kit.env.DB, "SELECT value FROM settings WHERE scope='system' AND key=?", [
        BACKFILL_DONE,
      ]),
    ).toBeNull();
    expect(await first(kit.env.DB, 'SELECT scan_code FROM passes WHERE id=?', [pass.id])).toEqual({
      scan_code: null,
    });
  } finally {
    try {
      await run(kit.env.DB, 'DROP TRIGGER credential_ref_keyset_insert_guard');
      try {
        await run(
          kit.env.DB,
          'INSERT OR IGNORE INTO credential_ref_keyset (id, commitment) VALUES (1, ?)',
          [commitment],
        );
      } finally {
        await run(kit.env.DB, insertGuard);
      }
    } finally {
      await run(kit.env.DB, noDelete);
    }
  }
});

// The keyset is an immutable singleton checked once per run (ensureCredentialRefKeyset), not bound
// into each backfill statement; the per-statement keyset races of the old fence no longer exist.

it.each(['completion marker', 'candidate read'] as const)(
  'keeps the key captured before the %s',
  async (point) => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Backfill key snapshot', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const template = await kit.registry.resolve(templateId);
    const source = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const target = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const expected = await getHolderPass(kit.env.DB, source.id, null);
    if (!expected) throw new Error('Missing transfer source');
    await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      source.id,
      { holderEmail: 'next-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    const retiredRef = await credentialTombstoneRef(
      kit.env,
      kit.org.id,
      'live',
      await sha256Hex('x'),
    );
    expect(
      await first(
        kit.env.DB,
        `SELECT credential_hash FROM pass_credential_tombstones
    WHERE pass_id=? AND credential_hash=?`,
        [source.id, retiredRef],
      ),
    ).not.toBeNull();

    const real = kit.env.DB;
    let fired = false;
    let mutableEnv: typeof kit.env;
    const db = new Proxy(real, {
      get(targetDb, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = targetDb.prepare(sql);
            if (
              point === 'completion marker'
                ? !sql.includes('SELECT value FROM settings')
                : !sql.includes('SELECT q.id, q.org_id')
            )
              return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    return new Proxy(bound, {
                      get(inner, method) {
                        if (point === 'completion marker' && method === 'first')
                          return async () => {
                            const result = await inner.first();
                            fired = true;
                            mutableEnv.KEK_V1 = btoa('z'.repeat(32));
                            return result;
                          };
                        if (point === 'candidate read' && method === 'all')
                          return async () => {
                            const result = await inner.all();
                            fired = true;
                            mutableEnv.KEK_V1 = btoa('z'.repeat(32));
                            return result;
                          };
                        const value = Reflect.get(inner, method, inner);
                        return typeof value === 'function' ? value.bind(inner) : value;
                      },
                    });
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        const value = Reflect.get(targetDb, prop, targetDb);
        return typeof value === 'function' ? value.bind(targetDb) : value;
      },
    });
    mutableEnv = { ...kit.env, DB: db };
    await backfillScanLookups({ ...jobCtxOf(kit), env: mutableEnv });
    expect(fired).toBe(true);
    expect(
      await first(real, 'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id=?', [
        target.id,
      ]),
    ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
  },
);
