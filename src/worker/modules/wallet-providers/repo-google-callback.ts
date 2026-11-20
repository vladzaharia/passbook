import type { Envelope } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { REVISION_EXPR } from './repo-accounts.ts';
import { walletHolderEventStmt } from './repo-holder-events.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';

export interface GoogleCallbackAccountScope {
  accountId: string;
  orgId: string;
  mode: 'live' | 'test';
  accountRevision: number;
}

export interface GoogleCallbackBinding extends GoogleCallbackAccountScope {
  instanceId: string;
  passId: string;
  releaseId: string;
  credentialGeneration: number;
  channelEpoch: number;
}

export interface GoogleCallbackBindingInput {
  instanceId: string;
  passId: string;
  /** The immutable original provider projection, not the latest projection. */
  releaseId: string;
  /** The immutable generation of the instance, not the pass's current generation. */
  credentialGeneration: number;
  channelEpoch: number;
  operationVersion: number;
}

/** The path selects one account; receipt admission does not require outbound publishing approval. */
export function findGoogleCallbackAccount(
  db: D1Database,
  accountId: string,
): Promise<GoogleCallbackAccountScope | null> {
  return first(
    db,
    `SELECT id AS accountId, org_id AS orgId, mode,
      CASE WHEN credential_id IS NULL THEN enrolment_revision ELSE revision END AS accountRevision
    FROM wallet_provider_accounts WHERE id = ? AND provider = 'google' AND revoked_at IS NULL
      AND (credential_id IS NOT NULL OR hmac_ciphertext IS NOT NULL)`,
    [accountId],
  );
}

function googleBindingProof(scope: WalletRuntimeScope, input: GoogleCallbackBindingInput) {
  const where = `i.id = ? AND i.pass_id = ? AND i.org_id = ? AND i.mode = ?
    AND i.provider = 'google' AND i.account_id = ? AND i.identity_projection_release_id = ?
    AND i.credential_generation = ? AND i.channel_epoch = ? AND op.version = ? AND op.account_revision = ? AND op.kind = 'upsert'
    AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
    AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND op.credential_keyset_commitment = ${pinnedKeysetSql}
    AND ${walletInstanceOperationCurrentSql('i', 'op', 'callback_clock.now_ms')}`;
  const params = [
    input.instanceId,
    input.passId,
    scope.orgId,
    scope.mode,
    scope.accountId,
    input.releaseId,
    input.credentialGeneration,
    input.channelEpoch,
    input.operationVersion,
    scope.accountRevision,
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
      AND b.credential_keyset_commitment = ${pinnedKeysetSql}`,
    [now, ...params, hashes.classIdHash, hashes.objectIdHash],
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
      SELECT i.id, i.account_id, ?, ?, ?, ${pinnedKeysetSql} ${join} WHERE ${where}
      ON CONFLICT(instance_id) DO NOTHING`,
      [hashes.classIdHash, hashes.objectIdHash, now, now, ...params],
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
  const row = await first<GoogleCallbackBinding & { keysetOk: number }>(
    db,
    `SELECT i.id AS instanceId, i.pass_id AS passId,
      i.identity_projection_release_id AS releaseId, i.credential_generation AS credentialGeneration,
      i.channel_epoch AS channelEpoch, a.id AS accountId, a.org_id AS orgId, a.mode, ${REVISION_EXPR} AS accountRevision,
      (i.credential_keyset_commitment = b.credential_keyset_commitment
        AND b.credential_keyset_commitment = ${pinnedKeysetSql}) AS keysetOk
    FROM wallet_google_callback_bindings b
    JOIN wallet_provider_instances i ON i.id = b.instance_id AND i.account_id = b.account_id
    JOIN wallet_provider_accounts a ON a.id = i.account_id AND a.org_id = i.org_id
      AND a.mode = i.mode AND a.provider = i.provider
    WHERE b.account_id = ? AND b.class_id_hash = ? AND b.object_id_hash = ?
      AND i.org_id = ? AND i.mode = ? AND i.provider = 'google'
      AND ${REVISION_EXPR} = ? AND a.revoked_at IS NULL AND (a.credential_id IS NOT NULL OR a.hmac_ciphertext IS NOT NULL)`,
    [scope.accountId, classIdHash, objectIdHash, scope.orgId, scope.mode, scope.accountRevision],
  );
  if (!row) return null;
  if (!row.keysetOk)
    throw new UnavailableError(
      'Google Wallet callback service is unavailable.',
      'GOOGLE_CALLBACK_UNAVAILABLE',
    );
  const { keysetOk: _keysetOk, ...binding } = row;
  return binding;
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
      AND i.credential_generation = ? AND i.channel_epoch = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'google' AND a.id = ?
      AND ${REVISION_EXPR} = ? AND a.revoked_at IS NULL AND (a.credential_id IS NOT NULL OR a.hmac_ciphertext IS NOT NULL)
      AND b.class_id_hash = ? AND b.object_id_hash = ?
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND b.credential_keyset_commitment = ${pinnedKeysetSql}
      AND ? > ?`;
  const params = [
    binding.instanceId,
    binding.passId,
    binding.releaseId,
    binding.credentialGeneration,
    binding.channelEpoch,
    binding.orgId,
    binding.mode,
    binding.accountId,
    binding.accountRevision,
    input.classIdHash,
    input.objectIdHash,
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
  const column = input.eventType === 'save' ? 'saved_at' : 'holder_removed_at';
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_google_callback_replays (account_id, nonce_hash, claim_id, expires_at)
      SELECT a.id, ?, ?, ? ${join} WHERE ${guard}
      ON CONFLICT(account_id, nonce_hash) DO NOTHING
      RETURNING nonce_hash`,
      [input.nonceHash, input.id, input.expiresAt, ...params],
    ),
    stmt(
      db,
      `INSERT INTO wallet_google_callback_receipts
        (id, instance_id, account_id, org_id, mode, event_type, nonce_hash, expires_at,
         received_at, kek_version, iv, wrapped_dek, ciphertext)
      SELECT ?, i.id, a.id, i.org_id, i.mode, ?, ?, ?, ?, ?, ?, ?, ? ${join}
      WHERE ${guard} AND EXISTS (SELECT 1 FROM wallet_google_callback_replays replay
        WHERE replay.account_id = a.id AND replay.nonce_hash = ? AND replay.claim_id = ?)
      RETURNING id`,
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
    walletHolderEventStmt(db, {
      orgId: binding.orgId,
      passId: binding.passId,
      mode: binding.mode,
      receiptTable: 'wallet_google_callback_receipts',
      receiptId: input.id,
      provider: 'google',
      event: input.eventType === 'save' ? 'saved' : 'removed',
      at: input.now,
    }),
    // The provider's report, applied only with the receipt it came from. Nothing here revokes.
    stmt(
      db,
      `UPDATE wallet_provider_instances SET ${column} = MAX(COALESCE(${column}, 0), ?)
      WHERE id = ? AND EXISTS (SELECT 1 FROM wallet_google_callback_receipts WHERE id = ?)`,
      [input.now, binding.instanceId, input.id],
    ),
  ]);
  return results[0]?.results.length === 1 && results[1]?.results.length === 1;
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
