import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import type { ProjectionCandidate } from './repo-projection-store.ts';

const MAX_EVIDENCE_AGE_MS = 300_000;
type Authority = Extract<TenantPassWrite, { kind: 'session' }>;

/** SQL aliases, clock, and keyset expressions must be trusted, static application SQL. */
export function samsungProjectionEvidencePredicateSql(
  candidateAlias: string,
  nowSql: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidateAlias)) throw new Error('Invalid candidate alias.');
  const c = candidateAlias;
  return `EXISTS (WITH samsung_evidence_clock(now_ms) AS (VALUES (${nowSql}))
    SELECT 1 FROM wallet_provider_projection_evidence ev CROSS JOIN samsung_evidence_clock
    WHERE (${c}.provider = 'samsung' AND ev.candidate_id = ${c}.id
      AND ev.org_id = ${c}.org_id AND ev.mode = ${c}.mode
      AND ev.account_id = ${c}.provider_account_id AND ev.account_revision = ${c}.provider_account_revision)
      AND (ev.provider_identity_hash = ${c}.provider_identity_hash AND ev.candidate_hash = ${c}.candidate_hash
        AND ev.credential_keyset_commitment = ${c}.credential_keyset_commitment)
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
            AND eh.expires_at = ev.expires_at)))`;
}

/**
 * The reviewed candidate must still be current in each write. `org` and `mode` render as `?` binds for the
 * point-in-time read and as grant markers inside a write part (which cannot name a tenant column otherwise).
 */
const currentCandidate = (tenant: {
  org: string;
  mode: string;
}) => `c.provider = 'samsung' AND c.id = ?
  AND c.org_id = ${tenant.org} AND c.mode = ${tenant.mode}
  AND c.candidate_hash = ? AND c.provider_account_id = ? AND c.provider_account_revision = ?
  AND c.provider_identity_hash = ? AND json_valid(c.projection_json)
  AND json_extract(c.projection_json, '$.cardType') = ?
  AND json_extract(c.projection_json, '$.cardSubType') = ?
  AND json_extract(c.projection_json, '$.countryCode') = ?
  AND c.credential_keyset_commitment = ${pinnedKeysetSql}
  AND EXISTS (SELECT 1 FROM template_approvals approval WHERE approval.candidate_id = c.id
    AND approval.credential_keyset_commitment = c.credential_keyset_commitment
    AND approval.candidate_hash = c.candidate_hash AND approval.reviewer_id != c.author_id
    AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id))`;
/** A part's UPDATE names its table, not an alias, so the tenant tie lint can see it. */
const EVIDENCE = 'wallet_provider_projection_evidence';
const readTenant = { org: '?', mode: '?' };
const partTenant = { org: '{org}', mode: '{mode}' };

/** The evidence row must still name a candidate with independent review under the same keyset. */
const currentEvidenceCandidate = (ev: string) => `EXISTS (SELECT 1 FROM template_candidates c
  JOIN template_approvals approval ON approval.candidate_id = c.id AND approval.candidate_hash = c.candidate_hash
    AND approval.credential_keyset_commitment = c.credential_keyset_commitment
    AND approval.reviewer_id != c.author_id
    AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id)
  WHERE c.id = ${ev}.candidate_id AND c.org_id = {org} AND c.mode = {mode} AND c.candidate_hash = ${ev}.candidate_hash
    AND c.credential_keyset_commitment = ${ev}.credential_keyset_commitment)`;

function candidateParams(c: ProjectionCandidate, withTenant: boolean): SqlValue[] {
  if (c.projection.provider !== 'samsung' || c.projection.schema !== 1)
    throw new Error('Samsung candidate required.');
  return [
    c.id,
    ...(withTenant ? [c.orgId, c.mode] : []),
    c.candidateHash,
    c.accountId,
    c.accountRevision,
    c.providerIdentityHash,
    c.projection.cardType,
    c.projection.cardSubType,
    c.projection.countryCode,
  ];
}

/**
 * The grant of one evidence write: a member with the capability they were checked for, or (no authority)
 * the platform job that refreshes an expired proof. The grant's own org and mode are the candidate's; the
 * account must still be under the epoch the candidate captured.
 */
function evidenceGrant(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
): Grant | null {
  const tables = [
    'wallet_provider_projection_evidence',
    'wallet_provider_projection_evidence_history',
  ];
  if (authority) {
    if (authority.orgId !== c.orgId || authority.mode !== c.mode) return null;
    return grant(ctx, {
      purpose: 'org_mode.wallet.evidence_probe',
      principal: tenantPrincipal(authority),
      checks: capabilityChecks(authority),
      tables,
    });
  }
  if (!ctx.job) return null;
  return jobGrant(ctx, {
    job: 'wallet-evidence',
    orgId: c.orgId,
    mode: c.mode,
    purpose: 'org_mode.job.wallet.evidence_probe',
    tables,
  });
}

/** A point-in-time lookup only; effects must repeat the predicate atomically. */
export async function hasSamsungProjectionEvidence(
  ctx: ServiceContext,
  c: ProjectionCandidate,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    ctx.env.DB,
    `SELECT 1 AS ok FROM template_candidates c
    JOIN orgs owner ON owner.id = c.org_id AND owner.status = 'active'
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = 'samsung'
      AND account.authority_epoch = c.provider_account_epoch AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE ${currentCandidate(readTenant)} AND ${samsungProjectionEvidencePredicateSql('c', '?')}`,
    [...candidateParams(c, true), ctx.clock.now()],
  );
  return row !== null;
}

/** Invalidate prior evidence before contacting Samsung; a newer attempt wins over an older one. */
export async function beginSamsungProjectionProbe(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
  probeId: string,
): Promise<boolean> {
  const g = evidenceGrant(ctx, authority, c);
  if (!g) return false;
  g.include(
    writePart(
      `INSERT INTO wallet_provider_projection_evidence
    (candidate_id, org_id, mode, account_id, account_revision, provider_identity_hash, candidate_hash,
     card_type, card_sub_type, country_code, status, testing_mode_off, probe_id, verified_at, expires_at,
     credential_keyset_commitment, account_epoch)
    SELECT c.id, {org}, {mode}, c.provider_account_id, c.provider_account_revision,
      c.provider_identity_hash, c.candidate_hash, json_extract(c.projection_json, '$.cardType'),
      json_extract(c.projection_json, '$.cardSubType'), json_extract(c.projection_json, '$.countryCode'),
      'pending', NULL, ?, NULL, NULL, c.credential_keyset_commitment, c.provider_account_epoch
    FROM template_candidates c JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = {org} AND account.mode = {mode} AND account.provider = 'samsung'
      AND account.authority_epoch = c.provider_account_epoch AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE ${currentCandidate(partTenant)} AND {grant}
    ON CONFLICT(candidate_id) DO UPDATE SET
      account_id = excluded.account_id, account_revision = excluded.account_revision, account_epoch = excluded.account_epoch,
      provider_identity_hash = excluded.provider_identity_hash, candidate_hash = excluded.candidate_hash,
      card_type = excluded.card_type, card_sub_type = excluded.card_sub_type, country_code = excluded.country_code,
      status = 'pending', testing_mode_off = NULL, probe_id = excluded.probe_id, verified_at = NULL, expires_at = NULL
    WHERE wallet_provider_projection_evidence.credential_keyset_commitment = excluded.credential_keyset_commitment
    RETURNING candidate_id`,
      [probeId, ...candidateParams(c, false)],
    ),
  );
  const results = await g.commit();
  return (results[0]?.results.length ?? 0) === 1;
}

/** Mark an unsuccessful attempt without allowing it to overwrite a newer probe. */
export async function failSamsungProjectionProbe(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
  probeId: string,
): Promise<void> {
  const g = evidenceGrant(ctx, authority, c);
  if (!g) return;
  g.include(
    writePart(
      `UPDATE wallet_provider_projection_evidence SET status = 'unverified'
    WHERE candidate_id = ? AND org_id = {org} AND mode = {mode} AND probe_id = ? AND status = 'pending'
      AND credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${currentEvidenceCandidate(EVIDENCE)} AND {grant}`,
      [c.id, probeId],
    ),
  );
  try {
    await g.commit();
  } catch (error) {
    // The admin's session ended while Samsung answered: the row stays pending, which no reader accepts.
    if (!(error instanceof ForbiddenError || error instanceof ConflictError)) throw error;
    ctx.log.warn('wallet.verification_failed', { code: 'WALLET_VERIFY_FAILED' });
  }
}

/** A positive result and its immutable historical evidence are committed in one D1 transaction. */
export async function completeSamsungProjectionProbe(
  ctx: ServiceContext,
  authority: Authority | null,
  c: ProjectionCandidate,
  probeId: string,
  verifiedAt: number,
  expiresAt: number,
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
  const g = evidenceGrant(ctx, authority, c);
  if (!g) return false;
  g.include(
    writePart(
      `INSERT INTO wallet_provider_projection_evidence_history
      (id, candidate_id, org_id, mode, account_id, account_revision, provider_identity_hash, candidate_hash,
       card_type, card_sub_type, country_code, testing_mode_off, verified_at, expires_at, credential_keyset_commitment,
       account_epoch)
      SELECT ev.probe_id, ev.candidate_id, {org}, {mode}, ev.account_id, ev.account_revision,
        ev.provider_identity_hash, ev.candidate_hash, ev.card_type, ev.card_sub_type, ev.country_code, 'Y', ?, ?,
        ev.credential_keyset_commitment, ev.account_epoch
      FROM wallet_provider_projection_evidence ev
      JOIN template_candidates c ON c.id = ev.candidate_id AND c.org_id = {org} AND c.mode = {mode}
        AND c.provider_account_id = ev.account_id AND c.provider_account_revision = ev.account_revision
        AND c.provider_identity_hash = ev.provider_identity_hash AND c.candidate_hash = ev.candidate_hash
        AND c.credential_keyset_commitment = ev.credential_keyset_commitment
        AND json_extract(c.projection_json, '$.cardType') = ev.card_type
        AND json_extract(c.projection_json, '$.cardSubType') = ev.card_sub_type
        AND json_extract(c.projection_json, '$.countryCode') = ev.country_code
      JOIN wallet_provider_accounts account ON account.id = ev.account_id AND account.org_id = {org}
        AND account.mode = {mode} AND account.provider = 'samsung' AND account.authority_epoch = ev.account_epoch
        AND account.credential_id IS NOT NULL AND account.revoked_at IS NULL
      WHERE ev.org_id = {org} AND ev.mode = {mode} AND ev.status = 'pending' AND ev.probe_id = ?
        AND ${currentCandidate(partTenant)} AND {grant}
      RETURNING id`,
      [verifiedAt, expiresAt, probeId, ...candidateParams(c, false)],
    ),
    writePart(
      `UPDATE wallet_provider_projection_evidence SET status = 'verified', testing_mode_off = 'Y',
      verified_at = ?, expires_at = ? WHERE candidate_id = ? AND org_id = {org} AND mode = {mode}
      AND probe_id = ? AND status = 'pending'
      AND credential_keyset_commitment = ${pinnedKeysetSql}
      AND ${currentEvidenceCandidate(EVIDENCE)}
      AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history eh
        WHERE eh.id = ${EVIDENCE}.probe_id AND eh.candidate_id = ${EVIDENCE}.candidate_id
          AND eh.org_id = {org} AND eh.mode = {mode} AND eh.account_id = ${EVIDENCE}.account_id
          AND eh.account_revision = ${EVIDENCE}.account_revision AND eh.provider_identity_hash = ${EVIDENCE}.provider_identity_hash
          AND eh.credential_keyset_commitment = ${EVIDENCE}.credential_keyset_commitment
          AND eh.candidate_hash = ${EVIDENCE}.candidate_hash AND eh.card_type = ${EVIDENCE}.card_type
          AND eh.card_sub_type = ${EVIDENCE}.card_sub_type AND eh.country_code = ${EVIDENCE}.country_code
          AND eh.testing_mode_off = 'Y' AND eh.verified_at = ? AND eh.expires_at = ?)
      AND {grant}
      RETURNING candidate_id`,
      [verifiedAt, expiresAt, c.id, probeId, verifiedAt, expiresAt],
    ),
  );
  const results = await g.commit();
  return results[0]?.results.length === 1 && results[1]?.results.length === 1;
}
