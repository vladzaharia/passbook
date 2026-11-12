import type { Mode } from '../../../shared/contracts/common.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import type { Candidate } from './repo-lookup.ts';
import type { WalletSnapshot } from './wallet-snapshot.ts';

export interface AssetWalletSnapshot extends WalletSnapshot {
  pass: Pick<Pass, 'serial' | 'version' | 'personalization'>;
  walletVersion: number | null;
  walletTemplateVersion: string | null;
  versionPersonalization: string | null;
  identityRevision: number | null;
}

/** The original, request-local candidate SELECT; never serialized into a grant. */
export type AssetPassSnapshot = Candidate;

/** Server-only source recovered from the authenticated retained live-event proof. */
export interface AssetGrantSource {
  sourceId: string;
  eventId: string;
  actor: ScanActor;
}

/** Nonsecret original session incarnation; idle expiry is rechecked, not pinned. */
export interface AssetSessionSnapshot {
  user_id: string;
  amr: string;
  roles: string;
  created_at: number;
  expires_at: number;
  membership_id: string | null;
  membership_roles: string | null;
}

export type AssetGrantPurpose = 'read' | 'commit';

/**
 * A photo is read under the purpose its release state allows: a pass used under its own release
 * while the head is on another build (null display version) is read, as the card reads it.
 */
export const photoGrantPurpose = (
  snapshot: Pick<Candidate, 'displayTemplateVersion'>,
): AssetGrantPurpose => (snapshot.displayTemplateVersion === null ? 'read' : 'commit');

/** Server-only authority with original pass data bound only by a keyed proof. */
export interface AssetGuardPlan {
  passId: string;
  snapshotProof: string;
  actor: ScanActor;
  source: AssetGrantSource | undefined;
  recipientSession: AssetSessionSnapshot | null;
  sourceSession: AssetSessionSnapshot | null;
  connectionGeneration: number | null;
  activeVersion: string | null;
  credentialTombstoneRefs: readonly string[];
  purpose: AssetGrantPurpose;
  requirePhoto: boolean;
}

/** Cloneable plan: bearer token and actor credential identifiers remain in a sidecar. */
export interface PreparedAssetGrant {
  tokenHash: string;
  orgId: string;
  mode: Mode;
  expiresAt: number;
  credentialRefsJson: string;
  guard: Omit<AssetGuardPlan, 'actor' | 'source' | 'recipientSession' | 'sourceSession'>;
}
