import { sha256Hex } from '../../platform/ids.ts';
import type {
  WalletInstanceProof,
  WalletOfferAuthority,
  WalletOperation,
  WalletOperationKind,
  WalletScope,
} from './instance-types.ts';
import { isCredentialKeysetCommitment as validCommitment } from './instance-types.ts';

export const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
export const scopeValid = (p: WalletScope) =>
  !!p.orgId &&
  (p.mode === 'live' || p.mode === 'test') &&
  (p.provider === 'google' || p.provider === 'samsung');
export function validProof(p: WalletInstanceProof, kind: WalletOperationKind): boolean {
  return (
    scopeValid(p) &&
    validCommitment(p.credentialKeysetCommitment) &&
    !!p.passId &&
    !!p.accountId &&
    !!p.projectionReleaseId &&
    nonnegative(p.passVersion) &&
    p.passVersion > 0 &&
    nonnegative(p.passRevision) &&
    nonnegative(p.lifecycleGeneration) &&
    nonnegative(p.passCredentialGeneration) &&
    p.passCredentialGeneration > 0 &&
    nonnegative(p.accountRevision) &&
    p.accountRevision > 0 &&
    nonnegative(p.adapterRevision) &&
    p.adapterRevision > 0 &&
    nonnegative(p.policyRevision) &&
    p.policyRevision > 0 &&
    (kind === 'revoke' || !!p.issuingReleaseId)
  );
}
export function sameProof(
  op: WalletOperation,
  p: WalletInstanceProof,
  kind: WalletOperationKind,
): boolean {
  return (
    op.kind === kind &&
    op.passId === p.passId &&
    op.orgId === p.orgId &&
    op.mode === p.mode &&
    op.provider === p.provider &&
    op.accountId === p.accountId &&
    op.passVersion === p.passVersion &&
    op.passRevision === p.passRevision &&
    op.lifecycleGeneration === p.lifecycleGeneration &&
    op.passCredentialGeneration === p.passCredentialGeneration &&
    op.credentialKeysetCommitment === p.credentialKeysetCommitment &&
    op.issuingReleaseId === p.issuingReleaseId &&
    op.projectionReleaseId === p.projectionReleaseId &&
    op.accountRevision === p.accountRevision &&
    op.adapterRevision === p.adapterRevision &&
    op.policyRevision === p.policyRevision
  );
}
export function validAuthority(a: WalletOfferAuthority): boolean {
  return a.kind === 'download'
    ? typeof a.token === 'string' && a.token.length > 0 && a.token.length <= 256
    : a.kind === 'holder' &&
        typeof a.ownerUserId === 'string' &&
        a.ownerUserId.length > 0 &&
        a.ownerUserId.length <= 256;
}
export function validRequest(key: string, now: number): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 256 && nonnegative(now);
}
export const requestHash = (key: string) => sha256Hex(`wallet-operation-v1\0${key}`);
