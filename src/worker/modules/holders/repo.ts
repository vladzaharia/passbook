import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, chunk, first, placeholders, stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { readMode, type ScopeArg, scopeOrg } from '../passes/scope.ts';
import { type MutationAudit, mutationAudit, operationAuthority } from './repo-blocks.ts';

/** userSql/emailSql are trusted SQL expressions, never request data. */
function verifiedAttachSql(passAlias: string, userSql: string, emailSql: string): string {
  return `EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
      WHERE u.id = ${userSql} AND u.status = 'active' AND e.email = ${emailSql})
    AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b
      WHERE b.pass_id = ${passAlias}.id AND b.user_id = ${userSql})
    AND NOT EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
      WHERE u.id != ${userSql} AND u.status = 'active' AND e.email = ${emailSql}
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b
          WHERE b.pass_id = ${passAlias}.id AND b.user_id = u.id))`;
}

/**
 * A reissue request is actionable only for the exact still-waiting pass and verified user.
 * The optional user expression is a single bound parameter for holder-facing queries.
 */
export function holderReissueCurrentSql(passAlias: string, userIdSql?: '?'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(passAlias)) throw new Error('Invalid pass alias.');
  return `EXISTS (SELECT 1 FROM pass_holder_reissue_required hr
    WHERE hr.pass_id = ${passAlias}.id AND hr.org_id = ${passAlias}.org_id
      AND hr.mode = ${passAlias}.mode AND ${passAlias}.holder_email IS NOT NULL
      AND hr.credential_generation = ${passAlias}.credential_generation
      AND hr.version = ${passAlias}.version AND hr.revision = ${passAlias}.revision
      AND hr.lifecycle_generation = ${passAlias}.lifecycle_generation
      AND hr.link_generation = ${passAlias}.link_generation AND hr.release_id IS ${passAlias}.release_id
      AND ${passAlias}.owner_user_id IS NULL AND ${passAlias}.deleted_at IS NULL
      AND ${passAlias}.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = ${passAlias}.org_id AND o.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = ${passAlias}.id AND t.state = 'pending')
      ${userIdSql ? 'AND hr.user_id = ?' : ''}
      AND ${verifiedAttachSql(passAlias, 'hr.user_id', `${passAlias}.holder_email`)})`;
}

export interface HolderConnectionFence {
  orgId: string;
  connectionId: string;
  externalRef: string | null;
  generation: number;
}

export interface HolderPass {
  id: string;
  mode: Mode;
  orgId: string;
  holderEmail: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  version: number;
  rowVersion: number;
  revision: number;
  lifecycleGeneration: number;
  releaseId: string | null;
  downloadToken: string;
  linkGeneration: number;
  credentialGeneration: number;
  pendingTransferId: string | null;
  reissueRequired: boolean;
  modifiedAt: number;
}

export interface HolderDbRow {
  id: string;
  mode: Mode;
  org_id: string;
  holder_email: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  version: number;
  row_version: number;
  revision: number;
  lifecycle_generation: number;
  release_id: string | null;
  download_token: string;
  link_generation: number;
  credential_generation: number;
  pending_transfer_id: string | null;
  reissue_required: number;
  modified_at: number;
}

export const mapHolder = (r: HolderDbRow): HolderPass => ({
  id: r.id,
  mode: r.mode,
  orgId: r.org_id,
  holderEmail: r.holder_email,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  version: r.version,
  rowVersion: r.row_version,
  revision: r.revision,
  lifecycleGeneration: r.lifecycle_generation,
  releaseId: r.release_id,
  downloadToken: r.download_token,
  linkGeneration: r.link_generation,
  pendingTransferId: r.pending_transfer_id,
  credentialGeneration: r.credential_generation,
  reissueRequired: r.reissue_required === 1,
  modifiedAt: r.modified_at,
});

export const SELECT_HOLDER = `SELECT p.id, p.mode, p.org_id, p.holder_email, p.owner_user_id, p.modified_at,
    p.version, p.row_version, p.revision, p.lifecycle_generation, p.release_id, p.download_token, p.link_generation,
    p.credential_generation,
    (SELECT t.id FROM pass_credential_transfers t
      WHERE t.pass_id = p.id AND t.state = 'pending') AS pending_transfer_id,
    (${holderReissueCurrentSql('p')}) AS reissue_required,
    u.name AS owner_name FROM passes p LEFT JOIN users u ON u.id = p.owner_user_id`;

export async function getHolderPass(
  db: D1Database,
  passId: string,
  scope: ScopeArg,
): Promise<HolderPass | null> {
  const orgScope = scopeOrg(scope);
  const row = await first<HolderDbRow>(
    db,
    `${SELECT_HOLDER} WHERE p.id = ? AND (? IS NULL OR p.org_id = ?) AND (? IS NULL OR p.mode = ?)
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`,
    [passId, orgScope, orgScope, readMode(scope), readMode(scope)],
  );
  return row ? mapHolder(row) : null;
}

export async function blockedUsers(
  db: D1Database,
  passIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (passIds.length === 0) return out;
  // D1 allows 100 bound parameters per statement.
  for (const ids of chunk(passIds)) {
    const rows = await all<{ pass_id: string; user_id: string }>(
      db,
      `SELECT pass_id, user_id FROM pass_attach_blocks WHERE pass_id IN (${placeholders(ids.length)})`,
      ids,
    );
    for (const r of rows) out.set(r.pass_id, [...(out.get(r.pass_id) ?? []), r.user_id]);
  }
  return out;
}

/**
 * Active users that verified `email` through a user_emails row. An OIDC email_verified claim is
 * not proof here: with oidc.trustEmail off, sign-in leaves the address out of user_emails.
 */
export async function verifiedCandidates(db: D1Database, email: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT u.id FROM users u WHERE u.status = 'active'
       AND EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?1)`,
    [email],
  );
  return rows.map((r) => r.id);
}

export async function blockedUserIds(db: D1Database, passId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    db,
    'SELECT user_id FROM pass_attach_blocks WHERE pass_id = ?',
    [passId],
  );
  return rows.map((r) => r.user_id);
}

type ReissueSource = Pick<
  HolderPass,
  | 'orgId'
  | 'mode'
  | 'holderEmail'
  | 'ownerUserId'
  | 'version'
  | 'revision'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'releaseId'
  | 'downloadToken'
  | 'linkGeneration'
>;

/** Persist and audit only a current verified attachment that cannot safely rotate its credentials. */
export async function markHolderReissueRequired(
  db: D1Database,
  passId: string,
  source: ReissueSource,
  userId: string,
  now: number,
  credentialKeysetCommitment: string,
  authority: TenantPassWrite | undefined,
  connection: HolderConnectionFence | undefined,
  audit: MutationAudit,
): Promise<void> {
  const write = stmt(
    db,
    `INSERT INTO pass_holder_reissue_required
    (pass_id, org_id, mode, user_id, credential_generation, version, revision,
     lifecycle_generation, link_generation, release_id, detected_at)
    SELECT p.id, p.org_id, p.mode, candidate.user_id, p.credential_generation, p.version, p.revision,
      p.lifecycle_generation, p.link_generation, p.release_id, ?
    FROM passes p CROSS JOIN (SELECT ? AS user_id) candidate
    WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
      AND p.holder_email IS ? AND p.owner_user_id IS ? AND p.owner_user_id IS NULL
      AND p.version = ? AND p.revision = ? AND p.credential_generation = ?
      AND p.lifecycle_generation = ? AND p.release_id IS ? AND p.download_token = ?
      AND p.link_generation = ? AND p.holder_email IS NOT NULL
      AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = p.id AND t.state = 'pending')
      AND ${verifiedAttachSql('p', 'candidate.user_id', 'p.holder_email')}
      AND ${credentialRefKeysetSql}
      ${authority ? `AND p.org_id = ? AND p.mode = ? AND ${operationAuthority(authority) ? tenantPassAuthoritySql(authority, 'p') : '0'}` : ''}
      ${
        connection
          ? `AND p.connection_id = ? AND p.org_id = ? AND p.external_ref IS ? AND p.mode = 'live'
        AND p.status = 'active' AND p.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM connections c JOIN orgs o ON o.id = c.org_id
          WHERE c.id = ? AND c.org_id = ? AND c.enabled = 1 AND c.generation = ? AND o.status = 'active')`
          : ''
      }
    ON CONFLICT(pass_id) DO UPDATE SET
      org_id = excluded.org_id, mode = excluded.mode, user_id = excluded.user_id,
      credential_generation = excluded.credential_generation, version = excluded.version,
      revision = excluded.revision, lifecycle_generation = excluded.lifecycle_generation,
      link_generation = excluded.link_generation, release_id = excluded.release_id, detected_at = excluded.detected_at
    WHERE pass_holder_reissue_required.org_id IS NOT excluded.org_id
      OR pass_holder_reissue_required.mode IS NOT excluded.mode
      OR pass_holder_reissue_required.user_id IS NOT excluded.user_id
      OR pass_holder_reissue_required.credential_generation IS NOT excluded.credential_generation
      OR pass_holder_reissue_required.version IS NOT excluded.version
      OR pass_holder_reissue_required.revision IS NOT excluded.revision
      OR pass_holder_reissue_required.lifecycle_generation IS NOT excluded.lifecycle_generation
      OR pass_holder_reissue_required.link_generation IS NOT excluded.link_generation
      OR pass_holder_reissue_required.release_id IS NOT excluded.release_id`,
    [
      now,
      userId,
      passId,
      source.orgId,
      source.mode,
      source.holderEmail,
      source.ownerUserId,
      source.version,
      source.revision,
      source.credentialGeneration,
      source.lifecycleGeneration,
      source.releaseId,
      source.downloadToken,
      source.linkGeneration,
      credentialKeysetCommitment,
      ...(authority
        ? [
            authority.orgId,
            authority.mode,
            ...(operationAuthority(authority) ? tenantPassAuthorityParams(authority, now) : []),
          ]
        : []),
      ...(connection
        ? [
            connection.connectionId,
            connection.orgId,
            connection.externalRef,
            connection.connectionId,
            connection.orgId,
            connection.generation,
          ]
        : []),
    ],
  );
  await batch(db, [write, mutationAudit(db, audit)]);
}

/** Bound one sweep to its current high-water mark, even as new passes are issued. */
export async function waitingHolderSweepUpper(db: D1Database): Promise<string | null> {
  const row = await first<{ id: string | null }>(
    db,
    `SELECT MAX(p.id) AS id FROM passes p
    WHERE p.holder_email IS NOT NULL AND p.owner_user_id IS NULL
      AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`,
  );
  return row?.id ?? null;
}

/** Eligible rows only; the hook repeats every proof in the eventual transfer or marker batch. */
export function listSweepWaitingPasses(
  db: D1Database,
  cursor: { after: string | null; upper: string },
  limit: number,
) {
  return all<{ id: string }>(
    db,
    `SELECT p.id FROM passes p
    WHERE p.holder_email IS NOT NULL AND p.owner_user_id IS NULL
      AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = p.id AND t.state = 'pending')
      AND NOT (${holderReissueCurrentSql('p')})
      AND EXISTS (SELECT 1 FROM user_emails candidate
        WHERE candidate.email = p.holder_email
          AND ${verifiedAttachSql('p', 'candidate.user_id', 'p.holder_email')})
      AND (? IS NULL OR p.id > ?) AND p.id <= ? ORDER BY p.id LIMIT ?`,
    [cursor.after, cursor.after, cursor.upper, limit],
  );
}
