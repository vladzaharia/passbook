import { applyD1Migrations } from 'cloudflare:test';
import { env as bindings } from 'cloudflare:workers';
import { beforeEach, expect } from 'vitest';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../../src/worker/modules/passes/credential-keyset.ts';
import { first, run } from '../../src/worker/platform/db.ts';
import { makeEnv as makeBaseEnv } from './env.ts';

export const keyA = btoa('a'.repeat(32));
export const keyB = btoa('b'.repeat(32));
export const envA = { KEK_V1: keyA };
export const envB = { KEK_V1: keyB };
export const unavailable = { status: 503, code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' };

// The Workers Vitest plugin isolates storage by file, not by test. Each case gets its own
// fully migrated D1 binding so immutable keysets and retained refs cannot leak between cases.
export function installKeysetTestEnv() {
  let nextDatabase = 0;
  let currentDatabase: D1Database;
  beforeEach(async () => {
    const name = `KEYSET_TEST_DB_${nextDatabase++}`;
    const db = (bindings as unknown as Record<string, D1Database | undefined>)[name];
    if (!db) throw new Error(`No isolated D1 binding for ${name}`);
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
    currentDatabase = db;
  }, 30_000);
  return () => makeBaseEnv({ DB: currentDatabase });
}

let nextLazyDatabase = 0;
/** A migrated D1 for one case in a file that cannot afford a database per test (32 are bound). */
export async function isolatedKeysetDatabase(): Promise<D1Database> {
  const name = `KEYSET_TEST_DB_${nextLazyDatabase++}`;
  const db = (bindings as unknown as Record<string, D1Database | undefined>)[name];
  if (!db) throw new Error(`No isolated D1 binding for ${name}`);
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  return db;
}

export async function assetGrant(db: D1Database, orgId: string, refs: string) {
  await run(
    db,
    `INSERT INTO scan_asset_grant_provenance
    (token_hash, org_id, mode, expires_at, credential_refs) VALUES (?, ?, 'live', ?, ?)`,
    ['a'.repeat(64), orgId, 5_000_000, refs],
  );
}

export async function tombstoneWithoutKeyset(db: D1Database) {
  const trigger = await first<{ sql: string }>(
    db,
    `SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'pass_credential_tombstones_insert_guard'`,
  );
  if (!trigger) throw new Error('Missing tombstone insert trigger');
  // Model a retained pre-sentinel reference without creating a new provider generation.
  await run(db, 'DROP TRIGGER pass_credential_tombstones_insert_guard');
  try {
    await run(
      db,
      `INSERT INTO pass_credential_tombstones
      (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
      VALUES ('legacy-pass', 'legacy-org', 'live', 1, 'scan_code', ?, 1)`,
      ['b'.repeat(64)],
    );
  } finally {
    await run(db, trigger.sql);
  }
}

export async function retainedClaimWithoutKeyset(db: D1Database) {
  await run(
    db,
    `INSERT INTO connection_webhook_retention
    (id, connection_id, org_id, event_id, generation, source, connection_mode, reference_mode,
     ref_hash, state, release_snapshot, snapshot_known, item_count, chunk_count, kek_version,
     iv, wrapped_dek, ciphertext, received_at, updated_at)
    VALUES ('r', 'c', 'o', 'e', 1, 'ingress', 'webhook', 'embedded-required',
      'h', 'pending', '{}', 1, 1, 1, 1, x'00', x'00', x'00', 1, 1)`,
  );
  await run(
    db,
    `INSERT INTO connection_webhook_items
    (retention_id, ordinal, state, release_snapshot, prior_unknown, claim_snapshot)
    VALUES ('r', 0, 'pending', '{}', 0, ?)`,
    [JSON.stringify({ refHash: 'c'.repeat(64) })],
  );
}

export async function expectKeysetInitializationBlocked(db: D1Database, env = envA) {
  await expect(ensureCredentialRefKeyset(db, env)).rejects.toMatchObject(unavailable);
  await expect(
    run(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
      await credentialRefKeysetCommitment(env),
    ]),
  ).rejects.toThrow('credential reference keyset cannot be initialized');
  expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
}
