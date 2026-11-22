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
/** All values are snapshots from trusted reads, not client-provided authority. */
export interface WalletInstanceProof extends WalletScope {
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
  /**
   * The pass row_version and the account authority_epoch the reconcile read. The queue grant refuses when either
   * moved.
   */
  passRowVersion?: number;
  accountEpoch?: number;
}
/** The proof of queued reconcile work: the lost-update pin is required. */
export type WalletQueueProof = WalletInstanceProof & {
  passRowVersion: number;
  accountEpoch: number;
};

interface WalletInstanceBase extends WalletScope {
  id: string;
  passId: string;
  /** Immutable credential lineage used to derive provider object identity. */
  credentialGeneration: number;
  /** Identity within a generation: a successor after a channel-off retirement is epoch + 1. */
  channelEpoch: number;
  retirementCause: 'channel_off' | null;
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
  /** The instance's own epoch, which selects the Google object id. */
  channelEpoch: number;
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
export interface WalletClaimRef extends WalletOperationRef {
  /** Generate using newWalletClaimHandle(); the raw handle is never stored. */
  claimHandle: string;
  now: number;
}
export type WalletClaimResult = 'claimed' | 'already_claimed' | 'not_claimable';
export type WalletProviderResult =
  | {
      kind: 'success';
      httpStatus?: number;
      rawBody?: Uint8Array;
      /**
       * A Google revoke that was read back (G5), the replay boundary: `inactive` (barcode-less) or `absent`
       * (Google has no such object). The confirming read is the last response recorded for the attempt.
       */
      confirmed?: 'inactive' | 'absent';
    }
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
  instanceId: string;
  passId: string;
  version: number;
  identityProjectionReleaseId: string;
  credentialGeneration: number;
  expiresAt: number;
}
