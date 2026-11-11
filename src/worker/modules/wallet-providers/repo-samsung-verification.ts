import { batch, first, run, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import type { ProjectionCandidate } from './repo-projection-store.ts';

const MAX_EVIDENCE_AGE_MS = 300_000;
type Authority = Extract<TenantPassWrite, { kind: 'session' }>;

/** SQL aliases, clock, and keyset expressions must be trusted, static application SQL. */
export function samsungProjectionEvidencePredicateSql(
  candidateAlias: string,
  nowSql: string,
  credentialKeysetCommitmentSql: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidateAlias)) throw new Error('Invalid candidate alias.');
  const c = candidateAlias;
  if (!credentialKeysetCommitmentSql)
    throw new Error('A credential keyset commitment is required.');
  return `EXISTS (WITH samsung_evidence_clock(now_ms) AS (VALUES (${nowSql}))
    SELECT 1 FROM wallet_provider_projection_evidence ev CROSS JOIN samsung_evidence_clock
    WHERE (${c}.provider = 'samsung' AND ev.candidate_id = ${c}.id
      AND ev.org_id = ${c}.org_id AND ev.mode = ${c}.mode
      AND ev.account_id = ${c}.provider_account_id AND ev.account_revision = ${c}.provider_account_revision)
      AND (ev.provider_identity_hash = ${c}.provider_identity_hash AND ev.candidate_hash = ${c}.candidate_hash
        AND ev.credential_keyset_commitment = ${c}.credential_keyset_commitment
        AND ${c}.credential_keyset_commitment = (SELECT commitment FROM credential_ref_keyset WHERE id = 1))
      AND (EXISTS (SELECT 1 FROM template_approvals approval WHERE approval.candidate_id = ${c}.id
        AND approval.candidate_hash = ${c}.candidate_hash
        AND approval.reviewer_id != ${c}.author_id
        AND (${c}.version_author_id IS NULL OR approval.reviewer_id != ${c}.version_author_id)
        AND approval.credential_keyset_commitment = ${c}.credential_keyset_commitment))
      AND (json_valid(${c}.projection_json)
        AND ev.card_type = json_extract(${c}.projection_json, '$.cardType')
        AND ev.card_sub_type = json_extract(${c}.projection_json, '$.cardSubType')
        AND ev.country_code = json_extract(${c}.projection_json, '$.countryCode'))
      AND (ev.status = 'verified' AND ev.testing_mode_off = 'Y'
        AND ev.verified_at <= samsung_evidence_clock.now_ms AND ev.expires_at > samsung_evidence_clock.now_ms
        AND ev.expires_at > ev.verified_at AND ev.expires_at <= ev.verified_at + ${MAX_EVIDENCE_AGE_MS})
      AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history eh
        WHERE (eh.id = ev.probe_id AND eh.candidate_id = ev.candidate_id
          AND eh.org_id = ev.org_id AND eh.mode = ev.mode AND eh.account_id = ev.account_id)
          AND (eh.account_revision = ev.account_revision AND eh.provider_identity_hash = ev.provider_identity_hash
            AND eh.credential_keyset_commitment = ev.credential_keyset_commitment)
          AND (eh.candidate_hash = ev.candidate_hash AND eh.card_type = ev.card_type
            AND eh.card_sub_type = ev.card_sub_type AND eh.country_code = ev.country_code)
          AND (eh.testing_mode_off = ev.testing_mode_off AND eh.verified_at = ev.verified_at
            AND eh.expires_at = ev.expires_at))
      AND ${credentialRefKeysetSql.replace('?', `(${credentialKeysetCommitmentSql})`)})`;
}

/** The reviewed candidate, credential revision, and tenant grant must still be current in each write. */
const currentCandidate = `c.provider = 'samsung' AND c.id = ? AND c.org_id = ? AND c.mode = ?
  AND c.candidate_hash = ? AND c.provider_account_id = ? AND c.provider_account_revision = ?
  AND c.provider_identity_hash = ? AND json_valid(c.projection_json)
  AND json_extract(c.projection_json, '$.cardType') = ?
  AND json_extract(c.projection_json, '$.cardSubType') = ?
  AND json_extract(c.projection_json, '$.countryCode') = ?
  AND c.credential_keyset_commitment = ?
  AND EXISTS (SELECT 1 FROM template_approvals approval WHERE approval.candidate_id = c.id
    AND approval.credential_keyset_commitment = c.credential_keyset_commitment
    AND approval.candidate_hash = c.candidate_hash AND approval.reviewer_id != c.author_id
    AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id))`;

/** The evidence row must still name a candidate with independent review under the same keyset. */
const currentEvidenceCandidate = `EXISTS (SELECT 1 FROM template_candidates c
  JOIN template_approvals approval ON approval.candidate_id = c.id AND approval.candidate_hash = c.candidate_hash
    AND approval.credential_keyset_commitment = c.credential_keyset_commitment
    AND approval.reviewer_id != c.author_id
    AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id)
  WHERE c.id = ev.candidate_id AND c.candidate_hash = ev.candidate_hash
    AND c.credential_keyset_commitment = ev.credential_keyset_commitment)`;

function candidateParams(c: ProjectionCandidate, proof: WalletCredentialKeysetProof) {
  if (c.projection.provider !== 'samsung') throw new Error('Samsung candidate required.');
  return [
    c.id,
    c.orgId,
    c.mode,
    c.candidateHash,
    c.accountId,
    c.accountRevision,
    c.providerIdentityHash,
    c.projection.cardType,
    c.projection.cardSubType,
    c.projection.countryCode,
    proof.credentialKeysetCommitment,
  ];
}

function authorityGuard(authority: Authority | null, now: number) {
  return authority
    ? {
        sql: tenantPassAuthoritySql(authority, 'c'),
        params: tenantPassAuthorityParams(authority, now),
      }
    : { sql: '1 = 1', params: [] };
}

/** A point-in-time lookup only; effects must repeat the predicate atomically. */
export async function hasSamsungProjectionEvidence(
  ctx: ServiceContext,
  c: ProjectionCandidate,
  proof: WalletCredentialKeysetProof,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    ctx.env.DB,
    `SELECT 1 AS ok FROM template_candidates c
    JOIN orgs owner ON owner.id = c.org_id AND owner.status = 'active'
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = 'samsung'
      AND account.revision = c.provider_account_revision AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE ${currentCandidate} AND ${samsungProjectionEvidencePredicateSql('c', '?', '?')}`,
    [...candidateParams(c, proof), ctx.clock.now(), proof.credentialKeysetCommitment],
  );
  return row !== null;
}

/** Invalidate prior evidence before contacting Samsung; a newer attempt wins over an older one. */
export async function beginSamsungProjectionProbe(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
  probeId: string,
  proof: WalletCredentialKeysetProof,
): Promise<boolean> {
  const now = ctx.clock.now();
  const db = ctx.env.DB;
  const guard = authorityGuard(authority, now);
  const result = await run(
    db,
    `INSERT INTO wallet_provider_projection_evidence
    (candidate_id, org_id, mode, account_id, account_revision, provider_identity_hash, candidate_hash,
     card_type, card_sub_type, country_code, status, testing_mode_off, probe_id, verified_at, expires_at,
     credential_keyset_commitment)
    SELECT c.id, c.org_id, c.mode, c.provider_account_id, c.provider_account_revision,
      c.provider_identity_hash, c.candidate_hash, json_extract(c.projection_json, '$.cardType'),
      json_extract(c.projection_json, '$.cardSubType'), json_extract(c.projection_json, '$.countryCode'),
      'pending', NULL, ?, NULL, NULL, c.credential_keyset_commitment
    FROM template_candidates c JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = 'samsung'
      AND account.revision = c.provider_account_revision AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    JOIN orgs owner ON owner.id = c.org_id AND owner.status = 'active'
    WHERE ${currentCandidate} AND ${guard.sql} AND ${credentialRefKeysetSql}
    ON CONFLICT(candidate_id) DO UPDATE SET org_id = excluded.org_id, mode = excluded.mode,
      account_id = excluded.account_id, account_revision = excluded.account_revision,
      provider_identity_hash = excluded.provider_identity_hash, candidate_hash = excluded.candidate_hash,
      card_type = excluded.card_type, card_sub_type = excluded.card_sub_type, country_code = excluded.country_code,
      status = 'pending', testing_mode_off = NULL, probe_id = excluded.probe_id, verified_at = NULL, expires_at = NULL
    WHERE wallet_provider_projection_evidence.credential_keyset_commitment = excluded.credential_keyset_commitment`,
    [probeId, ...candidateParams(c, proof), ...guard.params, proof.credentialKeysetCommitment],
  );
  return result.changes === 1;
}

/** Mark an unsuccessful attempt without allowing it to overwrite a newer probe. */
export async function failSamsungProjectionProbe(
  ctx: ServiceContext,
  candidateId: string,
  probeId: string,
  proof: WalletCredentialKeysetProof,
): Promise<void> {
  await run(
    ctx.env.DB,
    `UPDATE wallet_provider_projection_evidence AS ev SET status = 'unverified'
    WHERE ev.candidate_id = ? AND ev.probe_id = ? AND ev.status = 'pending' AND ev.credential_keyset_commitment = ?
      AND ${currentEvidenceCandidate} AND ${credentialRefKeysetSql}`,
    [candidateId, probeId, proof.credentialKeysetCommitment, proof.credentialKeysetCommitment],
  );
}

/** A positive result and its immutable historical evidence are committed in one D1 transaction. */
export async function completeSamsungProjectionProbe(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
  probeId: string,
  verifiedAt: number,
  expiresAt: number,
  proof: WalletCredentialKeysetProof,
): Promise<boolean> {
  const now = ctx.clock.now();
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(verifiedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    verifiedAt > now ||
    now >= expiresAt ||
    expiresAt > verifiedAt + MAX_EVIDENCE_AGE_MS
  )
    return false;
  const db = ctx.env.DB;
  const guard = authorityGuard(authority, now);
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_provider_projection_evidence_history
      (id, candidate_id, org_id, mode, account_id, account_revision, provider_identity_hash, candidate_hash,
       card_type, card_sub_type, country_code, testing_mode_off, verified_at, expires_at, credential_keyset_commitment)
      SELECT ev.probe_id, ev.candidate_id, ev.org_id, ev.mode, ev.account_id, ev.account_revision,
        ev.provider_identity_hash, ev.candidate_hash, ev.card_type, ev.card_sub_type, ev.country_code, 'Y', ?, ?,
        ev.credential_keyset_commitment
      FROM wallet_provider_projection_evidence ev
      JOIN template_candidates c ON c.id = ev.candidate_id AND c.org_id = ev.org_id AND c.mode = ev.mode
        AND c.provider_account_id = ev.account_id AND c.provider_account_revision = ev.account_revision
        AND c.provider_identity_hash = ev.provider_identity_hash AND c.candidate_hash = ev.candidate_hash
        AND c.credential_keyset_commitment = ev.credential_keyset_commitment
        AND json_extract(c.projection_json, '$.cardType') = ev.card_type
        AND json_extract(c.projection_json, '$.cardSubType') = ev.card_sub_type
        AND json_extract(c.projection_json, '$.countryCode') = ev.country_code
      JOIN wallet_provider_accounts account ON account.id = ev.account_id AND account.org_id = ev.org_id
        AND account.mode = ev.mode AND account.provider = 'samsung' AND account.revision = ev.account_revision
        AND account.credential_id IS NOT NULL AND account.revoked_at IS NULL
      JOIN orgs owner ON owner.id = ev.org_id AND owner.status = 'active'
      WHERE ev.status = 'pending' AND ev.probe_id = ? AND ${currentCandidate}
        AND ${guard.sql} AND ${credentialRefKeysetSql}`,
      [
        verifiedAt,
        expiresAt,
        probeId,
        ...candidateParams(c, proof),
        ...guard.params,
        proof.credentialKeysetCommitment,
      ],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_projection_evidence AS ev SET status = 'verified', testing_mode_off = 'Y',
      verified_at = ?, expires_at = ? WHERE ev.candidate_id = ? AND ev.probe_id = ? AND ev.status = 'pending'
      AND ev.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND ${currentEvidenceCandidate}
      AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history eh
        WHERE eh.id = ev.probe_id AND eh.candidate_id = ev.candidate_id
          AND eh.org_id = ev.org_id AND eh.mode = ev.mode AND eh.account_id = ev.account_id
          AND eh.account_revision = ev.account_revision AND eh.provider_identity_hash = ev.provider_identity_hash
          AND eh.credential_keyset_commitment = ev.credential_keyset_commitment
          AND eh.candidate_hash = ev.candidate_hash AND eh.card_type = ev.card_type
          AND eh.card_sub_type = ev.card_sub_type AND eh.country_code = ev.country_code
          AND eh.testing_mode_off = 'Y' AND eh.verified_at = ? AND eh.expires_at = ?)`,
      [
        verifiedAt,
        expiresAt,
        c.id,
        probeId,
        proof.credentialKeysetCommitment,
        proof.credentialKeysetCommitment,
        verifiedAt,
        expiresAt,
      ],
    ),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}
