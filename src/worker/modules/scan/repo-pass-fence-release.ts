import { validityOf } from '../../../shared/pass-view/validity.ts';

/** What the pass fence reads off the candidate (or its stop projection) the answer was evaluated from. */
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
