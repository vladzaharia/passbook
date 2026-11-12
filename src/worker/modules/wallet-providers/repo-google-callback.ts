import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';

export interface GoogleCallbackAccountScope {
  accountId: string;
  orgId: string;
  mode: 'live' | 'test';
  accountRevision: number;
  credentialKeysetCommitment: string;
}

export interface GoogleCallbackBinding extends GoogleCallbackAccountScope {
  instanceId: string;
  passId: string;
  releaseId: string;
  credentialGeneration: number;
}

export interface GoogleCallbackBindingInput {
  instanceId: string;
  passId: string;
  /** The immutable original provider projection, not the latest projection. */
  releaseId: string;
  /** The immutable generation of the instance, not the pass's current generation. */
  credentialGeneration: number;
  operationVersion: number;
}

/** The path selects one account; receipt admission does not require outbound publishing approval. */
export function findGoogleCallbackAccount(
  db: D1Database,
  accountId: string,
  credentialKeysetCommitment: string,
): Promise<GoogleCallbackAccountScope | null> {
  return first(
    db,
    `SELECT id AS accountId, org_id AS orgId, mode, revision AS accountRevision,
      ? AS credentialKeysetCommitment
    FROM wallet_provider_accounts WHERE id = ? AND provider = 'google' AND revoked_at IS NULL
      AND credential_id IS NOT NULL AND ${credentialRefKeysetSql}`,
    [credentialKeysetCommitment, accountId, credentialKeysetCommitment],
  );
}

function googleBindingProof(scope: WalletRuntimeScope, input: GoogleCallbackBindingInput) {
  const where = `i.id = ? AND i.pass_id = ? AND i.org_id = ? AND i.mode = ?
    AND i.provider = 'google' AND i.account_id = ? AND i.identity_projection_release_id = ?
    AND i.credential_generation = ? AND op.version = ? AND op.account_revision = ? AND op.kind = 'upsert'
    AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
    AND i.credential_keyset_commitment = ? AND op.credential_keyset_commitment = ?
    AND ${credentialRefKeysetSql}
    AND ${walletInstanceOperationCurrentSql('i', 'op', 'callback_clock.now_ms')}`;
  const params = [
    input.instanceId,
    input.passId,
    scope.orgId,
    scope.mode,
    scope.accountId,
    input.releaseId,
    input.credentialGeneration,
    input.operationVersion,
    scope.accountRevision,
    scope.credentialKeysetCommitment,
    scope.credentialKeysetCommitment,
    scope.credentialKeysetCommitment,
  ] as const;
  const join = `FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op
    ON op.id = i.desired_operation_id AND op.instance_id = i.id
    CROSS JOIN (SELECT ? AS now_ms) callback_clock`;
  return { where, params, join };
}

function googleBindingCurrentStatement(
  db: D1Database,
  scope: WalletRuntimeScope,
  input: GoogleCallbackBindingInput,
  hashes: { classIdHash: string; objectIdHash: string },
  now: number,
): D1PreparedStatement {
  const { where, params, join } = googleBindingProof(scope, input);
  return stmt(
    db,
    `SELECT 1 AS ok ${join}
    JOIN wallet_google_callback_bindings b ON b.instance_id = i.id AND b.account_id = i.account_id
    WHERE ${where} AND b.class_id_hash = ? AND b.object_id_hash = ?
      AND b.credential_keyset_commitment = ?`,
    [now, ...params, hashes.classIdHash, hashes.objectIdHash, scope.credentialKeysetCommitment],
  );
}

/** Registration is only possible for the exact still-current and approved instance operation. */
export async function putGoogleCallbackBinding(
  db: D1Database,
  scope: WalletRuntimeScope,
  input: GoogleCallbackBindingInput,
  hashes: { classIdHash: string; objectIdHash: string },
  now: number,
): Promise<boolean> {
  const { where, params, join } = googleBindingProof(scope, input);
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_google_callback_bindings
        (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
      SELECT i.id, i.account_id, ?, ?, ?, ? ${join} WHERE ${where}
      ON CONFLICT(instance_id) DO NOTHING`,
      [
        hashes.classIdHash,
        hashes.objectIdHash,
        now,
        scope.credentialKeysetCommitment,
        now,
        ...params,
      ],
    ),
    googleBindingCurrentStatement(db, scope, input, hashes, now),
  ]);
  return results[1]?.results.length === 1;
}

/** Final output fence after reopening the account and rechecking the keyset. */
export async function isGoogleCallbackBindingCurrent(
  db: D1Database,
  scope: WalletRuntimeScope,
  input: GoogleCallbackBindingInput,
  hashes: { classIdHash: string; objectIdHash: string },
  now: number,
): Promise<boolean> {
  return (await googleBindingCurrentStatement(db, scope, input, hashes, now).first()) !== null;
}

/** Lookup uses both hashed IDs scoped to the previously resolved account. */
export async function findGoogleCallbackBinding(
  db: D1Database,
  scope: GoogleCallbackAccountScope,
  classIdHash: string,
  objectIdHash: string,
): Promise<GoogleCallbackBinding | null> {
  const credentialKeysetCommitment = scope.credentialKeysetCommitment;
  const row = await first<
    Omit<GoogleCallbackBinding, 'credentialKeysetCommitment'> & {
      credentialKeysetCommitment: string | null;
    }
  >(
    db,
    `SELECT i.id AS instanceId, i.pass_id AS passId,
      i.identity_projection_release_id AS releaseId, i.credential_generation AS credentialGeneration,
      a.id AS accountId, a.org_id AS orgId, a.mode, a.revision AS accountRevision,
      CASE WHEN i.credential_keyset_commitment = b.credential_keyset_commitment
        THEN b.credential_keyset_commitment END AS credentialKeysetCommitment
    FROM wallet_google_callback_bindings b
    JOIN wallet_provider_instances i ON i.id = b.instance_id AND i.account_id = b.account_id
    JOIN wallet_provider_accounts a ON a.id = i.account_id AND a.org_id = i.org_id
      AND a.mode = i.mode AND a.provider = i.provider
    WHERE b.account_id = ? AND b.class_id_hash = ? AND b.object_id_hash = ?
      AND i.org_id = ? AND i.mode = ? AND i.provider = 'google'
      AND a.revision = ? AND a.revoked_at IS NULL AND a.credential_id IS NOT NULL
      AND ${credentialRefKeysetSql}`,
    [
      scope.accountId,
      classIdHash,
      objectIdHash,
      scope.orgId,
      scope.mode,
      scope.accountRevision,
      credentialKeysetCommitment,
    ],
  );
  if (!row) return null;
  if (row.credentialKeysetCommitment !== credentialKeysetCommitment)
    throw new UnavailableError(
      'Google Wallet callback service is unavailable.',
      'GOOGLE_CALLBACK_UNAVAILABLE',
    );
  return { ...row, credentialKeysetCommitment };
}

export interface GoogleCallbackReceiptInput {
  id: string;
  classIdHash: string;
  objectIdHash: string;
  nonceHash: string;
  eventType: 'save' | 'del';
  expiresAt: number;
  validUntil: number;
  now: number;
  envelope: Envelope;
}

function googleReceiptProof(binding: GoogleCallbackBinding, input: GoogleCallbackReceiptInput) {
  const join = `FROM wallet_google_callback_bindings b
    JOIN wallet_provider_instances i ON i.id = b.instance_id AND i.account_id = b.account_id
    JOIN wallet_provider_accounts a ON a.id = i.account_id AND a.org_id = i.org_id
      AND a.mode = i.mode AND a.provider = i.provider`;
  const guard = `i.id = ? AND i.pass_id = ? AND i.identity_projection_release_id = ?
      AND i.credential_generation = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'google' AND a.id = ?
      AND a.revision = ? AND a.revoked_at IS NULL AND a.credential_id IS NOT NULL
      AND b.class_id_hash = ? AND b.object_id_hash = ?
      AND i.credential_keyset_commitment = ? AND b.credential_keyset_commitment = ?
      AND ${credentialRefKeysetSql} AND ? > ?`;
  const params = [
    binding.instanceId,
    binding.passId,
    binding.releaseId,
    binding.credentialGeneration,
    binding.orgId,
    binding.mode,
    binding.accountId,
    binding.accountRevision,
    input.classIdHash,
    input.objectIdHash,
    binding.credentialKeysetCommitment,
    binding.credentialKeysetCommitment,
    binding.credentialKeysetCommitment,
    input.validUntil,
    input.now,
  ] as const;
  return { join, guard, params };
}

/** Commit the replay reservation and encrypted receipt in one D1 transaction. */
export async function putGoogleCallbackReceipt(
  db: D1Database,
  binding: GoogleCallbackBinding,
  input: GoogleCallbackReceiptInput,
): Promise<boolean> {
  const { envelope } = input;
  const { join, guard, params } = googleReceiptProof(binding, input);
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_google_callback_replays (account_id, nonce_hash, claim_id, expires_at)
      SELECT a.id, ?, ?, ? ${join} WHERE ${guard}
      ON CONFLICT(account_id, nonce_hash) DO NOTHING`,
      [input.nonceHash, input.id, input.expiresAt, ...params],
    ),
    stmt(
      db,
      `INSERT INTO wallet_google_callback_receipts
        (id, instance_id, account_id, org_id, mode, event_type, nonce_hash, expires_at,
         received_at, kek_version, iv, wrapped_dek, ciphertext)
      SELECT ?, i.id, a.id, i.org_id, i.mode, ?, ?, ?, ?, ?, ?, ?, ? ${join}
      WHERE ${guard} AND EXISTS (SELECT 1 FROM wallet_google_callback_replays replay
        WHERE replay.account_id = a.id AND replay.nonce_hash = ? AND replay.claim_id = ?)`,
      [
        input.id,
        input.eventType,
        input.nonceHash,
        input.expiresAt,
        input.now,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        ...params,
        input.nonceHash,
        input.id,
      ],
    ),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

/** Bind the acknowledgement to the committed receipt, replay reservation and current proof. */
export async function isGoogleCallbackReceiptCurrent(
  db: D1Database,
  binding: GoogleCallbackBinding,
  input: GoogleCallbackReceiptInput,
): Promise<boolean> {
  const { join, guard, params } = googleReceiptProof(binding, input);
  return (
    (await first(
      db,
      `SELECT 1 AS ok ${join}
    JOIN wallet_google_callback_receipts receipt ON receipt.id = ? AND receipt.instance_id = i.id
      AND receipt.account_id = a.id AND receipt.org_id = i.org_id AND receipt.mode = i.mode
      AND receipt.nonce_hash = ? AND receipt.event_type = ? AND receipt.expires_at = ?
    JOIN wallet_google_callback_replays replay ON replay.account_id = a.id
      AND replay.nonce_hash = receipt.nonce_hash AND replay.claim_id = receipt.id
    WHERE ${guard}`,
      [input.id, input.nonceHash, input.eventType, input.expiresAt, ...params],
    )) !== null
  );
}
