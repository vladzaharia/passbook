export type WalletProvider = 'google' | 'samsung';
export type WalletMode = 'live' | 'test';
export type WalletOperationKind = 'upsert' | 'revoke';
export type WalletOperationState =
  | 'pending'
  | 'claimed'
  | 'retry'
  | 'succeeded'
  | 'failed'
  | 'superseded'
  | 'uncertain';
export type WalletReasonCode =
  | 'ok'
  | 'not_issued'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'rejected'
  | 'invalid_response'
  | 'provider_error';
export type WalletInstallation = 'unknown';

export interface WalletScope {
  orgId: string;
  mode: WalletMode;
  provider: WalletProvider;
}
/** The canonical credential-reference keyset captured at the trusted authority boundary. */
export interface WalletCredentialKeysetProof {
  credentialKeysetCommitment: string;
}

export function isCredentialKeysetCommitment(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/** All values are snapshots from trusted reads, not client-provided authority. */
export interface WalletInstanceProof extends WalletScope, WalletCredentialKeysetProof {
  passId: string;
  passVersion: number;
  passRevision: number;
  lifecycleGeneration: number;
  /** Current pass generation at the mutation boundary, including historical cleanup. */
  passCredentialGeneration: number;
  issuingReleaseId: string | null;
  projectionReleaseId: string;
  accountId: string;
  accountRevision: number;
  adapterRevision: number;
  policyRevision: number;
}

interface WalletInstanceBase extends WalletScope {
  id: string;
  credentialKeysetCommitment: string;
  passId: string;
  /** Immutable credential lineage used to derive provider object identity. */
  credentialGeneration: number;
  desiredVersion: number;
  installationState: WalletInstallation;
  installationObservedAt: null;
  revokedAt: number | null;
  retirementRequestedAt: number | null;
  retiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type WalletInstance = WalletInstanceBase &
  (
    | {
        lifecycle: 'blocked' | 'ready';
        accountId: null;
        identityProjectionReleaseId: null;
        desiredOperationId: null;
      }
    | {
        lifecycle: 'active' | 'revoking' | 'revoked';
        accountId: string;
        identityProjectionReleaseId: string;
        desiredOperationId: string;
      }
    | {
        lifecycle: 'retired';
        accountId: string | null;
        identityProjectionReleaseId: string | null;
        desiredOperationId: string | null;
      }
  );

export interface WalletOperation extends WalletInstanceProof {
  id: string;
  instanceId: string;
  identityProjectionReleaseId: string;
  /** Original instance generation; may differ from passCredentialGeneration during cleanup. */
  credentialGeneration: number;
  version: number;
  kind: WalletOperationKind;
  state: WalletOperationState;
  attempts: number;
  nextAttemptAt: number | null;
  claimExpiresAt: number | null;
  lastAttemptAt: number | null;
  lastResultAt: number | null;
  completedAt: number | null;
  reasonCode: WalletReasonCode | null;
  httpStatus: number | null;
  createdAt: number;
}

export interface WalletOperationRef extends WalletScope {
  instanceId: string;
  version: number;
}
export interface WalletClaimRef extends WalletOperationRef, WalletCredentialKeysetProof {
  /** Generate using newWalletClaimHandle(); the raw handle is never stored. */
  claimHandle: string;
  now: number;
}
export type WalletClaimResult = 'claimed' | 'already_claimed' | 'not_claimable';
export type WalletProviderResult =
  | { kind: 'success'; httpStatus?: number; rawBody?: Uint8Array }
  | { kind: 'not_issued'; httpStatus?: never; rawBody?: never }
  | {
      kind: 'failure';
      reason: Exclude<WalletReasonCode, 'ok' | 'not_issued'>;
      retryable: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      rawBody?: Uint8Array;
    };

export type WalletOfferAuthority =
  | { kind: 'download'; token: string }
  | { kind: 'holder'; ownerUserId: string };

export interface WalletOfferBinding extends WalletScope {
  credentialKeysetCommitment: string;
  instanceId: string;
  passId: string;
  version: number;
  identityProjectionReleaseId: string;
  credentialGeneration: number;
  expiresAt: number;
}
