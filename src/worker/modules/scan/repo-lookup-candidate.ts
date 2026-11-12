import { CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { mapPass, type PassDbRow } from '../passes/repo-map.ts';
import {
  type LiveTemplateSnapshotRow,
  liveTemplateSnapshotFromRow,
} from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';

type PhotoProjection =
  | {
      asset_photo_version: null;
      asset_photo_key: null;
      asset_photo_sha1: null;
      asset_photo_included: null;
    }
  | {
      asset_photo_version: string;
      asset_photo_key: string;
      asset_photo_sha1: string;
      asset_photo_included: number;
    };

export type Raw = PassDbRow &
  LiveTemplateSnapshotRow & {
    pass_json: string | null;
    wallet_version: number | null;
    wallet_template_version: string | null;
    version_personalization: string | null;
    identity_pass_type_identifier: string | null;
    identity_team_identifier: string | null;
    identity_revision: number | null;
    transfer_pending: number;
    credential_keyset_commitment: string | null;
    lookup_hash: string | null;
    connection_generation: number | null;
    org_revision: number | null;
    template_revision: number | null;
    active_release_id: string | null;
    active_release_generation: number | null;
    active_release_version: string | null;
    active_release_candidate_hash: string | null;
    active_template_version: string | null;
    display_template_version: string | null;
    check_in_rules: string | null;
  } & PhotoProjection;

const NO_CREDENTIAL_REFS: readonly string[] = Object.freeze([]);

export function toCandidate(r: Raw): Candidate | null {
  if (
    typeof r.credential_keyset_commitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.credential_keyset_commitment) ||
    !Number.isSafeInteger(r.image_generation) ||
    r.image_generation < 0
  )
    return null;
  return {
    pass: mapPass(r),
    passPersonalizationSnapshot: r.personalization,
    fieldSourcesSnapshot: r.field_sources,
    templateSnapshot: liveTemplateSnapshotFromRow(r),
    assetPhoto:
      r.asset_photo_version === null
        ? null
        : {
            version: r.asset_photo_version,
            key: r.asset_photo_key,
            sha1: r.asset_photo_sha1,
            includeInPass: r.asset_photo_included,
          },
    passJson: r.pass_json,
    passJsonSnapshot: r.pass_json,
    walletVersion: r.wallet_version,
    walletTemplateVersion: r.wallet_template_version,
    versionPersonalization: r.version_personalization,
    identityPassTypeIdentifier: r.identity_pass_type_identifier,
    identityTeamIdentifier: r.identity_team_identifier,
    identityRevision: r.identity_revision,
    transferPending: r.transfer_pending !== 0,
    credentialKeysetCommitment: r.credential_keyset_commitment,
    credentialTombstoneRefs: NO_CREDENTIAL_REFS,
    otherModeCredentialTombstoneRefs: NO_CREDENTIAL_REFS,
    lookupHash: r.lookup_hash,
    connectionGeneration: r.connection_generation,
    orgRevision: r.org_revision,
    templateRevision: r.template_revision,
    activeReleaseId: r.active_release_id,
    activeReleaseGeneration: r.active_release_generation,
    activeReleaseVersion: r.active_release_version,
    activeReleaseCandidateHash: r.active_release_candidate_hash,
    activeTemplateVersion: r.active_template_version,
    displayTemplateVersion: r.display_template_version,
    checkInRules: CheckInPolicySchema.parse(JSON.parse(r.check_in_rules ?? '{}')),
    hasPhoto: r.asset_photo_version !== null,
  };
}
