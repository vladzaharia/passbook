import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { activeReleasePredicate, issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import {
  noCredentialTombstonesSql,
  validCredentialKeysetCommitment,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

type Predicate = { sql: string; params: SqlValue[] };

const PASS_RELEASE_SCOPE = {
  templateIdSql: 'p.template_id',
  orgIdSql: 'p.org_id',
  modeSql: 'p.mode',
  providerSql: "'apple'",
};
const ISSUED_RELEASE_SQL = issuedReleasePredicateSql(
  { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
  PASS_RELEASE_SCOPE,
);

/** Release head observed with the evaluated candidate, not a later database read. */
export interface ReleaseSnapshot {
  activeReleaseId?: string | null;
  activeReleaseGeneration?: number | null;
  activeReleaseVersion?: string | null;
  activeReleaseCandidateHash?: string | null;
  identityPassTypeIdentifier?: string | null;
  identityTeamIdentifier?: string | null;
  identityRevision?: number | null;
  /** Pending-transfer state from the same candidate read, not a later lookup. */
  transferPending?: boolean;
  /** Exact lookup credential refs observed before this candidate was read. */
  credentialTombstoneRefs?: readonly string[];
  /** Keyset commitment captured with the evaluated credential references. */
  credentialKeysetCommitment?: string;
  /** Raw JSON from the original Candidate or its Found/Stop projection. */
  passJson?: unknown;
  passJsonSnapshot?: string | null;
  /** Identity of the same bounded Wallet row and its exact stored personalization. */
  walletVersion?: number | null;
  walletTemplateVersion?: string | null;
  versionPersonalization?: string | null;
}

type ActiveReleaseSnapshot = ReleaseSnapshot & {
  activeReleaseId: string;
  activeReleaseGeneration: number;
  activeReleaseVersion: string;
  activeReleaseCandidateHash: string;
};
type LegacyReleaseSnapshot = ReleaseSnapshot & {
  activeReleaseId: null;
  activeReleaseGeneration: null;
  activeReleaseVersion: null;
  activeReleaseCandidateHash: null;
};

export function legacyRelease(
  release: ReleaseSnapshot | null | undefined,
): release is LegacyReleaseSnapshot {
  return (
    release != null &&
    release.activeReleaseId === null &&
    release.activeReleaseGeneration === null &&
    release.activeReleaseVersion === null &&
    release.activeReleaseCandidateHash === null
  );
}

export function completeRelease(
  release: ReleaseSnapshot | null | undefined,
): release is ActiveReleaseSnapshot {
  return (
    typeof release?.activeReleaseId === 'string' &&
    release.activeReleaseId.length > 0 &&
    typeof release.activeReleaseGeneration === 'number' &&
    Number.isSafeInteger(release.activeReleaseGeneration) &&
    release.activeReleaseGeneration > 0 &&
    typeof release.activeReleaseVersion === 'string' &&
    release.activeReleaseVersion.length > 0 &&
    typeof release.activeReleaseCandidateHash === 'string' &&
    release.activeReleaseCandidateHash.length > 0
  );
}

export function passJsonOf(release: ReleaseSnapshot | null | undefined): string | null | undefined {
  if (!release) return undefined;
  const value =
    release.passJsonSnapshot !== undefined ? release.passJsonSnapshot : release.passJson;
  return value === null || typeof value === 'string' ? value : undefined;
}

export type WalletStatus = 'active' | 'voided' | 'expired';

export function walletStatusOf(
  snapshot: string | null | undefined,
  now: number,
): WalletStatus | null {
  if (typeof snapshot !== 'string') return null;
  try {
    const value: unknown = JSON.parse(snapshot);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return validityOf(value as { voided?: unknown; expirationDate?: unknown }, now).status;
  } catch {
    return null;
  }
}

/** The evaluated values which can change admission or the pass identity shown to an operator. */
export function passPredicate(
  pass: Pass,
  connectionGeneration?: number | null,
  options?: { imagePolicy: 'strict' | 'identity-only' },
): Predicate {
  if (
    (options !== undefined &&
      options.imagePolicy !== 'strict' &&
      options.imagePolicy !== 'identity-only') ||
    (pass.connectionId !== null && typeof connectionGeneration !== 'number') ||
    (pass.connectionId === null && connectionGeneration != null) ||
    typeof pass.credentialGeneration !== 'number' ||
    !Number.isSafeInteger(pass.credentialGeneration) ||
    pass.credentialGeneration <= 0 ||
    typeof pass.lifecycleGeneration !== 'number' ||
    !Number.isSafeInteger(pass.lifecycleGeneration) ||
    pass.lifecycleGeneration < 0 ||
    typeof pass.imageGeneration !== 'number' ||
    !Number.isSafeInteger(pass.imageGeneration) ||
    pass.imageGeneration < 0
  )
    return { sql: '0', params: [] };
  const status = pass.status === 'active' ? "p.status='active'" : "p.status='voided'";
  const removed = pass.removedAt === null ? 'p.removed_at IS NULL' : 'p.removed_at=?';
  const identityOnly = options?.imagePolicy === 'identity-only';
  return {
    sql: scanConjunction([
      'p.id=?/* scan-ephemeral-pass-id */',
      'p.org_id=?',
      'p.mode=?',
      'p.identity_id=?',
      'p.serial=?/* scan-ephemeral-serial */',
      'p.template_id=?',
      'p.template_version=?',
      'p.release_id IS ?',
      `(p.release_id IS NULL OR (${ISSUED_RELEASE_SQL}))`,
      'p.version=?',
      'p.revision=?',
      'p.link_generation=?',
      'p.credential_generation=?',
      'p.lifecycle_generation=?',
      ...(identityOnly ? [] : ['p.image_generation=?']),
      `NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
        WHERE transfer.pass_id=p.id AND transfer.state='pending')`,
      status,
      removed,
      'p.deleted_at IS NULL',
      'p.test_data_quarantined=0',
      'json(p.personalization)=json(?/* scan-ephemeral-personalization */)',
      'p.holder_email IS ?/* scan-ephemeral-holder-email */',
      'p.owner_user_id IS ?/* scan-ephemeral-owner-id */',
      'p.download_token=?/* scan-ephemeral-download-token */',
      'p.object_key=?/* scan-ephemeral-object-key */',
      'p.scan_code IS ?/* scan-ephemeral-scan-code */',
      'p.barcode_hash IS ?/* scan-ephemeral-barcode-hash */',
      'p.connection_id IS ?',
      `(p.connection_id IS NULL OR EXISTS (
        SELECT 1 FROM connections c WHERE c.id=p.connection_id AND c.org_id=p.org_id
          AND c.enabled=1 AND c.generation=?
      ))`,
    ]),
    params: [
      pass.id,
      pass.orgId,
      pass.mode,
      pass.identityId,
      pass.serial,
      pass.templateId,
      pass.templateVersion,
      pass.releaseId,
      pass.version,
      pass.revision,
      pass.linkGeneration,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      ...(identityOnly ? [] : [pass.imageGeneration]),
      ...(pass.removedAt === null ? [] : [pass.removedAt]),
      JSON.stringify(pass.personalization),
      pass.holderEmail,
      pass.ownerUserId,
      pass.downloadToken,
      pass.objectKey,
      pass.scanCode,
      pass.barcodeHash,
      pass.connectionId,
      connectionGeneration ?? null,
    ],
  };
}

/** The policy must be the same one read with the original pass candidate. */
export function evaluatedPolicyPredicate(
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  release: ReleaseSnapshot | null | undefined,
  _purpose: 'read' | 'commit',
  now: number,
  walletStatus: WalletStatus,
): Predicate {
  const passJson = passJsonOf(release);
  if (
    !activeTemplateVersion ||
    release?.transferPending !== false ||
    !validCredentialTombstoneRefs(release.credentialTombstoneRefs) ||
    !validCredentialKeysetCommitment(release.credentialKeysetCommitment) ||
    typeof orgRevision !== 'number' ||
    typeof templateRevision !== 'number' ||
    typeof passJson !== 'string' ||
    typeof release?.identityPassTypeIdentifier !== 'string' ||
    typeof release.identityTeamIdentifier !== 'string' ||
    typeof release.identityRevision !== 'number' ||
    !Number.isSafeInteger(release.identityRevision) ||
    release.identityRevision <= 0 ||
    typeof release.walletVersion !== 'number' ||
    !Number.isSafeInteger(release.walletVersion) ||
    release.walletVersion <= 0 ||
    (release.walletTemplateVersion !== null && typeof release.walletTemplateVersion !== 'string') ||
    (release.versionPersonalization !== null && typeof release.versionPersonalization !== 'string')
  )
    return { sql: '0', params: [] };
  const credentialTombstoneRefs = release.credentialTombstoneRefs;
  const credentialKeysetCommitment = release.credentialKeysetCommitment;
  const walletVersion = release.walletVersion;
  const walletTemplateVersion = release.walletTemplateVersion;
  const versionPersonalization = release.versionPersonalization;
  const identityPassTypeIdentifier = release.identityPassTypeIdentifier;
  const identityTeamIdentifier = release.identityTeamIdentifier;
  const identityRevision = release.identityRevision;
  let active: Predicate;
  const scope = PASS_RELEASE_SCOPE;
  if (completeRelease(release) && activeTemplateVersion === release.activeReleaseVersion) {
    // The release in use is the pass's own issued one, or a compatible head (lookup `usedReleaseIdSql`).
    // Its own release is checked as immutable provenance, so a newer, withdrawn or missing head never
    // refuses the pass; only a head used in its place is fenced.
    const bound = activeReleasePredicate(
      {
        id: release.activeReleaseId,
        generation: release.activeReleaseGeneration,
        version: release.activeReleaseVersion,
        candidateHash: release.activeReleaseCandidateHash,
      },
      scope,
    );
    const own = issuedReleasePredicateSql(
      {
        releaseIdSql: 'p.release_id',
        versionSql: 'p.template_version',
        generationSql: '?',
        candidateHashSql: '?',
      },
      scope,
    );
    const head = {
      sql: `((p.release_id IS ? AND ${own}) OR (p.release_id IS NOT ? AND ${bound.sql}))`,
      params: [
        release.activeReleaseId,
        release.activeReleaseGeneration,
        release.activeReleaseCandidateHash,
        release.activeReleaseId,
        ...bound.params,
      ] as SqlValue[],
    };
    active = { sql: `(${head.sql})`, params: head.params };
  } else if (legacyRelease(release)) {
    active = {
      sql: `p.release_id IS NULL AND p.template_version=? AND EXISTS (
        SELECT 1 FROM template_versions v WHERE v.template_id=p.template_id AND v.version=p.template_version
      ) AND (${usedReleaseIdSql('p')}) IS NULL`,
      params: [activeTemplateVersion],
    };
  } else return { sql: '0', params: [] };
  const tombstones = noCredentialTombstonesSql(
    credentialTombstoneRefs,
    {
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
    },
    credentialKeysetCommitment,
  );
  // Not `templateRevision` (`config_revision`): a rename or settings save never fails a scan (R8).
  return {
    sql: scanConjunction([
      `EXISTS (SELECT 1 FROM orgs o WHERE o.id=p.org_id AND o.status='active' AND o.access_revision=?)`,
      `EXISTS (SELECT 1 FROM templates t WHERE t.id=p.template_id
        AND (t.org_id=p.org_id OR t.org_id IS NULL) AND t.status!='deleted')`,
      active.sql,
      walletSnapshotPredicateSql({
        snapshotSql: '?/* scan-ephemeral-wallet-json */',
        walletVersionSql: '?',
        walletTemplateVersionSql: '?',
        personalizationSql: '?/* scan-ephemeral-version-personalization */',
        passTypeIdentifierSql: '?',
        teamIdentifierSql: '?',
        identityRevisionSql: '?',
        nowSql: '?',
        status: walletStatus,
      }),
      tombstones.sql,
    ]),
    params: [
      orgRevision,
      ...active.params,
      passJson,
      walletVersion,
      walletTemplateVersion,
      versionPersonalization,
      identityPassTypeIdentifier,
      identityTeamIdentifier,
      identityRevision,
      now,
      ...tombstones.params,
    ],
  };
}
