import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { chunk, stmt } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import {
  type LiveTemplateSnapshot,
  liveTemplateSnapshotColumnsSql,
} from './repo-live-template-snapshot.ts';
import { type Raw, toCandidate } from './repo-lookup-candidate.ts';

type Db = D1Database;

/** A pass and its latest bounded Wallet version row, read in the same statement. */
export interface Candidate extends CredentialTombstoneSnapshot {
  pass: Pass;
  /** Original D1 keyset commitment captured with the candidate. */
  credentialKeysetCommitment: string;
  /** Raw pass data and photo lineage captured with this candidate, never projected. */
  passPersonalizationSnapshot: string;
  fieldSourcesSnapshot: string;
  assetPhoto: { version: string; key: string; sha1: string; includeInPass: number } | null;
  /** Original pinned and active policy rows for bounded scanner reads and strict live verification. */
  templateSnapshot: LiveTemplateSnapshot | null;
  passJson: string | null;
  /** Raw Wallet snapshot and signing identity observed in the same pass read. */
  passJsonSnapshot: string | null;
  /** Version and personalization from that same bounded Wallet row; never projected. */
  walletVersion: number | null;
  walletTemplateVersion: string | null;
  versionPersonalization: string | null;
  identityPassTypeIdentifier: string | null;
  identityTeamIdentifier: string | null;
  identityRevision: number | null;
  /** Whether a credential transfer was pending in the evaluated database snapshot. */
  transferPending: boolean;
  /** Exact-lookup key, kept server-side for query/snapshot revalidation. */
  lookupHash: string | null;
  /** Connection generation captured with the pass; null for passes without a connection. */
  connectionGeneration: number | null;
  /** Policy revisions read in the same statement as the pass. */
  orgRevision: number | null;
  templateRevision: number | null;
  /** Effective approved Apple release captured atomically with the pass. */
  activeReleaseId: string | null;
  activeReleaseGeneration: number | null;
  activeReleaseVersion: string | null;
  activeReleaseCandidateHash: string | null;
  /** Approved version, or the pinned version when legacy release history is absent. */
  activeTemplateVersion: string | null;
  /** Build-compatible release display, or the pinned version for the same legacy case. */
  displayTemplateVersion: string | null;
  checkInRules?: CheckInPolicy;
  hasPhoto?: boolean;
}

export type ReleaseSnapshot = Pick<
  Candidate,
  | 'activeReleaseId'
  | 'activeReleaseGeneration'
  | 'activeReleaseVersion'
  | 'activeReleaseCandidateHash'
>;

export type WalletSnapshot = Pick<
  Candidate,
  | 'passPersonalizationSnapshot'
  | 'fieldSourcesSnapshot'
  | 'assetPhoto'
  | 'passJsonSnapshot'
  | 'walletVersion'
  | 'walletTemplateVersion'
  | 'versionPersonalization'
  | 'identityPassTypeIdentifier'
  | 'identityTeamIdentifier'
  | 'identityRevision'
  | 'transferPending'
>;

/** Incomplete release snapshots fail closed; only pre-release passes can use the pinned version. */
export function hasScanPolicy(candidate: Candidate): boolean {
  if (
    candidate.pass.releaseId === null &&
    candidate.activeReleaseId === null &&
    candidate.activeReleaseGeneration === null &&
    candidate.activeReleaseVersion === null &&
    candidate.activeReleaseCandidateHash === null
  ) {
    return (
      !!candidate.activeTemplateVersion &&
      candidate.activeTemplateVersion === candidate.pass.templateVersion &&
      candidate.displayTemplateVersion === candidate.pass.templateVersion
    );
  }
  return (
    typeof candidate.activeReleaseId === 'string' &&
    candidate.activeReleaseId.length > 0 &&
    typeof candidate.activeReleaseGeneration === 'number' &&
    Number.isSafeInteger(candidate.activeReleaseGeneration) &&
    candidate.activeReleaseGeneration > 0 &&
    typeof candidate.activeReleaseVersion === 'string' &&
    candidate.activeReleaseVersion.length > 0 &&
    typeof candidate.activeReleaseCandidateHash === 'string' &&
    candidate.activeReleaseCandidateHash.length > 0 &&
    candidate.activeTemplateVersion === candidate.activeReleaseVersion
  );
}

const PROJECTION = `SELECT p.*, snapshot.pass_json AS pass_json,
    snapshot.version AS wallet_version, snapshot.personalization AS version_personalization,
    snapshot.template_version AS wallet_template_version,
    si.pass_type_identifier AS identity_pass_type_identifier, si.team_identifier AS identity_team_identifier,
    si.revision AS identity_revision,
    EXISTS(SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id=p.id AND transfer.state='pending') AS transfer_pending,
    credential_keyset.commitment AS credential_keyset_commitment,
    (SELECT rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id) AS check_in_rules,
    photo.version AS asset_photo_version, photo.r2_key AS asset_photo_key,
    photo.sha1 AS asset_photo_sha1, photo.include_in_pass AS asset_photo_included,
    (SELECT c.generation FROM connections c WHERE c.id=p.connection_id AND c.org_id=p.org_id AND c.enabled=1)
      AS connection_generation,
    (SELECT o.access_revision FROM orgs o WHERE o.id=p.org_id) AS org_revision,
    (SELECT o.config_revision FROM orgs o WHERE o.id=p.org_id) AS template_revision,
    ar.id AS active_release_id, ar.generation AS active_release_generation,
    ar.version AS active_release_version, ar.candidate_hash AS active_release_candidate_hash,
    COALESCE(ar.version, legacy.version) AS active_template_version,
    CASE WHEN legacy.version IS NOT NULL THEN legacy.version
      WHEN ar.version=p.template_version THEN ar.version
      WHEN pinned.build_key IS NOT NULL AND EXISTS(
        SELECT 1 FROM template_versions active
        WHERE active.template_id=p.template_id AND active.version=ar.version
          AND active.build_key=pinned.build_key
      ) THEN ar.version END AS display_template_version,
    ${liveTemplateSnapshotColumnsSql()}`;

const JOINS = `JOIN credential_ref_keyset credential_keyset ON credential_keyset.id=1
  LEFT JOIN pass_versions snapshot ON snapshot.pass_id=p.id AND snapshot.version=(
    SELECT v.version FROM pass_versions v
    WHERE v.pass_id=p.id AND v.version<=p.version ORDER BY v.version DESC LIMIT 1
  )
  LEFT JOIN member_photos photo ON photo.pass_id=p.id AND photo.org_id=p.org_id
  LEFT JOIN template_releases ar ON ar.id=p.release_id
  LEFT JOIN signing_identities si ON si.id=p.identity_id AND (si.org_id IS NULL OR si.org_id=p.org_id)
  LEFT JOIN template_versions pinned ON pinned.template_id=p.template_id
    AND pinned.version=p.template_version
  LEFT JOIN template_versions legacy ON legacy.template_id=p.template_id
    AND legacy.version=p.template_version AND p.release_id IS NULL
  LEFT JOIN templates snapshot_template ON snapshot_template.id=p.template_id
  LEFT JOIN template_versions snapshot_active ON snapshot_active.template_id=p.template_id
    AND snapshot_active.version=COALESCE(ar.version,legacy.version)`;

const ELIGIBLE = `p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND EXISTS(SELECT 1 FROM templates ot WHERE ot.id=p.template_id
      AND (ot.org_id IS NULL OR ot.org_id=p.org_id) AND ot.status!='deleted')
    AND (p.release_id IS NULL OR (${issuedReleasePredicateSql(
      { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
      {
        templateIdSql: 'p.template_id',
        orgIdSql: 'p.org_id',
        modeSql: 'p.mode',
        providerSql: "'apple'",
      },
    )}))`;

const SELECT = `${PROJECTION} FROM passes p ${JOINS} WHERE p.org_id = ? AND ${ELIGIBLE}`;

const LOOKUP_LABELS = {
  scan_code: 'scan-code',
  barcode_hash: 'barcode-hash',
  lookup_hash: 'lookup-hash',
  serial: 'serial',
  id: 'pass-id',
} as const;

/** Prefer the actor's mode before the bounded cap; the other mode is only for a warning. */
const lookup = (
  db: Db,
  orgId: string,
  column: keyof typeof LOOKUP_LABELS,
  value: string,
  limit: number,
  mode?: 'live' | 'test',
) =>
  stmt(
    db,
    `${SELECT} AND p.${column} = ?/* scan-ephemeral-${LOOKUP_LABELS[column]} */${mode ? ' ORDER BY (p.mode = ?) DESC' : ''} LIMIT ${limit}`,
    mode ? [orgId, value, mode] : [orgId, value],
  );

export const byScanCodeStmt = (db: Db, orgId: string, code: string, mode: 'live' | 'test') =>
  lookup(db, orgId, 'scan_code', code, 2, mode);
export const byBarcodeHashStmt = (db: Db, orgId: string, hash: string, mode: 'live' | 'test') =>
  lookup(db, orgId, 'barcode_hash', hash, 5, mode);
export const byLookupHashStmt = (db: Db, orgId: string, hash: string, mode: 'live' | 'test') =>
  lookup(db, orgId, 'lookup_hash', hash, 5, mode);
export const bySerialStmt = (db: Db, orgId: string, value: string, mode: 'live' | 'test') =>
  lookup(db, orgId, 'serial', value, 5, mode);
export const byIdStmt = (db: Db, orgId: string, id: string) => lookup(db, orgId, 'id', id, 1);

export const candidatesOf = (result: D1Result | undefined): Candidate[] =>
  ((result?.results ?? []) as Raw[])
    .map(toCandidate)
    .filter((candidate): candidate is Candidate => candidate !== null);

/** Read bounded tenant/mode/pass tuples in one transaction; output order is unspecified. */
export async function candidatesByScopes(
  db: Db,
  scopes: readonly { orgId: string; mode: 'live' | 'test'; passId: string }[],
): Promise<Candidate[]> {
  if (scopes.length === 0) return [];
  if (scopes.length > 1000) throw new RangeError('At most 1000 candidate scopes are allowed');
  const statements = chunk(scopes, 30).map((group) => {
    const values = group.map(() => '(?,?,?/* scan-ephemeral-pass-id */)').join(',');
    const params = group.flatMap(({ orgId, mode, passId }) => [orgId, mode, passId]);
    return stmt(
      db,
      `WITH scoped(org_id, mode, pass_id) AS (VALUES ${values})
      ${PROJECTION}
      FROM scoped JOIN passes p ON p.id=scoped.pass_id AND p.org_id=scoped.org_id AND p.mode=scoped.mode
      ${JOINS} WHERE ${ELIGIBLE}`,
      params,
    );
  });
  const results = await db.batch<Raw>(statements);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const result of results) {
    for (const row of result.results) {
      const candidate = toCandidate(row);
      if (!candidate || seen.has(candidate.pass.id)) continue;
      seen.add(candidate.pass.id);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function candidateById(db: Db, orgId: string, id: string): Promise<Candidate | null> {
  const row = await byIdStmt(db, orgId, id).first<Raw>();
  return row ? toCandidate(row) : null;
}
