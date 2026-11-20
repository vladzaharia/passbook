import { all, first } from '../../platform/db.ts';
import type {
  WalletCredentialKeysetProof,
  WalletOfferAuthority,
  WalletOfferBinding,
  WalletOperationRef,
} from './instance-types.ts';
import { offerStatement } from './repo-instance.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';

const OFFER_CURRENT = `ref.pass_authority_generation = COALESCE((SELECT generation
    FROM wallet_provider_pass_authority authority WHERE authority.pass_id = i.pass_id), 0)
  AND ref.expires_at > ? AND op.kind = 'upsert' AND op.state IN ('pending', 'retry', 'claimed', 'succeeded')
  AND i.credential_keyset_commitment = op.credential_keyset_commitment
  AND op.credential_keyset_commitment = ?
  AND ${walletInstanceOperationCurrentSql('i', 'op', '?')}`;
const BINDING = `i.id AS instanceId, i.pass_id AS passId, i.org_id AS orgId, i.mode, i.provider,
  i.credential_generation AS credentialGeneration, op.version,
  i.identity_projection_release_id AS identityProjectionReleaseId, ref.expires_at AS expiresAt,
  op.credential_keyset_commitment AS credentialKeysetCommitment`;

export async function insertOffer(
  db: D1Database,
  input: WalletOperationRef &
    WalletCredentialKeysetProof & {
      operationId: string;
      hash: string;
      expiresAt: number;
      authority: WalletOfferAuthority;
      now: number;
    },
): Promise<boolean> {
  const row = await offerStatement(
    db,
    input.instanceId,
    input.operationId,
    { hash: input.hash, expiresAt: input.expiresAt, authority: input.authority },
    input.now,
    input.credentialKeysetCommitment,
  ).first();
  return row !== null;
}

/** The INSERT's bearer and pass-authority epoch are checked again before use and after signing. */
export function readOffer(
  db: D1Database,
  hash: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<WalletOfferBinding | null> {
  return first(
    db,
    `SELECT ${BINDING} FROM wallet_provider_offer_refs ref
    JOIN wallet_provider_instances i ON i.id = ref.instance_id
    JOIN wallet_provider_instance_operations op ON op.instance_id = i.id AND op.version = ref.operation_version
    WHERE ref.ref_hash = ? AND ${OFFER_CURRENT}`,
    [hash, now, credentialKeysetCommitment, now],
  );
}
export async function consumeOffer(
  db: D1Database,
  hash: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<WalletOfferBinding | null> {
  const changed = await first<{ instance_id: string }>(
    db,
    `WITH current_offer AS MATERIALIZED (
      SELECT ref.ref_hash FROM wallet_provider_offer_refs ref
      JOIN wallet_provider_instances i ON i.id = ref.instance_id
      JOIN wallet_provider_instance_operations op
        ON op.instance_id = i.id AND op.version = ref.operation_version
      WHERE ref.ref_hash = ? AND ref.consumed_at IS NULL AND ${OFFER_CURRENT}
    )
    UPDATE wallet_provider_offer_refs AS ref SET consumed_at = ?
    WHERE ref.ref_hash IN (SELECT ref_hash FROM current_offer) AND ref.consumed_at IS NULL
    RETURNING instance_id`,
    [hash, now, credentialKeysetCommitment, now, now],
  );
  return changed ? readOffer(db, hash, now, credentialKeysetCommitment) : null;
}
export async function deleteOffer(db: D1Database, hash: string): Promise<boolean> {
  const row = await first(
    db,
    'DELETE FROM wallet_provider_offer_refs WHERE ref_hash = ? RETURNING ref_hash',
    [hash],
  );
  return row !== null;
}

export async function purgeExpiredOffers(
  db: D1Database,
  now: number,
  limit: number,
): Promise<number> {
  const rows = await all(
    db,
    `DELETE FROM wallet_provider_offer_refs WHERE ref_hash IN
    (SELECT ref_hash FROM wallet_provider_offer_refs WHERE expires_at <= ? ORDER BY expires_at, ref_hash LIMIT ?)
    RETURNING ref_hash`,
    [now, limit],
  );
  return rows.length;
}
