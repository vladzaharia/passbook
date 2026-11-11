import { nonnegative, requestHash, sameProof, validProof, validRequest } from './instance-input.ts';
import type {
  WalletCredentialKeysetProof,
  WalletInstance,
  WalletInstanceProof,
  WalletOperation,
  WalletOperationKind,
  WalletOperationRef,
  WalletScope,
} from './instance-types.ts';
import { isCredentialKeysetCommitment as validCommitment } from './instance-types.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import {
  ackDirtyInstance,
  deferDirtyInstance,
  getInstanceById,
  getInstanceByPass,
  getOperation,
  getOperationByRequest,
  insertDesiredOperation,
  insertInstance,
  listDirtyInstances,
  listDueOperations,
  readPassSnapshot,
} from './repo-instance.ts';
import {
  deferRetirement,
  listRetirementsReady,
  requestRetirement,
  retireInstance,
  retireUnissuedPlaceholder,
} from './repo-instance-retirement.ts';

export {
  claimWalletOperation,
  completeWalletOperation,
  expireWalletClaims,
  markWalletClaimUncertain,
  newWalletClaimHandle,
  recordWalletOperationOutcome,
  settleWalletClaim,
  walletClaimHash,
  walletOperationFresh,
} from './instance-claims.ts';
export {
  consumeWalletOfferRef,
  createWalletInstanceAndOffer,
  createWalletOfferRef,
  expireWalletOfferRef,
  purgeExpiredWalletOffers,
  walletOfferFresh,
} from './instance-offer-refs.ts';
export type * from './instance-types.ts';

export function getWalletInstance(
  db: D1Database,
  scope: WalletScope & { passId: string },
): Promise<WalletInstance | null> {
  return getInstanceByPass(db, scope);
}
export function getWalletInstanceById(
  db: D1Database,
  scope: WalletScope & { instanceId: string },
): Promise<WalletInstance | null> {
  return getInstanceById(db, scope);
}
export const getWalletOperation = getOperation;
export const readWalletPassSnapshot = readPassSnapshot;

export async function createWalletInstance(
  db: D1Database,
  p: WalletInstanceProof & {
    instanceId: string;
    requestKey: string;
    now: number;
    newId: () => string;
  },
): Promise<WalletOperation | null> {
  p = { ...p };
  if (
    !walletProviderEnabled(p.provider) ||
    !validProof(p, 'upsert') ||
    !validRequest(p.requestKey, p.now) ||
    !p.instanceId
  )
    return null;
  const hash = await requestHash(p.requestKey);
  const existing = await getInstanceByPass(db, p);
  if (
    existing &&
    (existing.credentialKeysetCommitment !== p.credentialKeysetCommitment ||
      (existing.lifecycle !== 'ready' && existing.lifecycle !== 'active'))
  )
    return null;
  const instanceId = existing?.id ?? p.instanceId;
  await insertInstance(db, {
    ...p,
    instanceId,
    operationId: p.newId(),
    requestHash: hash,
  });
  const op = await getOperationByRequest(db, { ...p, instanceId, requestHash: hash });
  return op && sameProof(op, p, 'upsert') ? op : null;
}

export async function queueWalletOperation(
  db: D1Database,
  p: WalletInstanceProof & {
    instanceId: string;
    expectedVersion: number;
    kind: WalletOperationKind;
    requestKey: string;
    now: number;
    newId: () => string;
  },
): Promise<WalletOperation | null> {
  p = { ...p };
  if (
    !validProof(p, p.kind) ||
    !validRequest(p.requestKey, p.now) ||
    !p.instanceId ||
    !nonnegative(p.expectedVersion) ||
    p.expectedVersion === 0
  )
    return null;
  const hash = await requestHash(p.requestKey);
  await insertDesiredOperation(db, { ...p, operationId: p.newId(), requestHash: hash });
  const op = await getOperationByRequest(db, { ...p, requestHash: hash });
  return op && sameProof(op, p, p.kind) ? op : null;
}

export function listDueWalletOperations(
  db: D1Database,
  now: number,
  limit: number,
  credentialKeysetCommitment: string,
  afterId: string | null = null,
): Promise<WalletOperation[]> {
  if (!validCommitment(credentialKeysetCommitment)) return Promise.resolve([]);
  return listDueOperations(
    db,
    now,
    Math.max(1, Math.min(100, Math.trunc(limit))),
    afterId,
    credentialKeysetCommitment,
  );
}
export function listDirtyWalletInstances(
  db: D1Database,
  now: number,
  limit: number,
  credentialKeysetCommitment: string,
  afterInstanceId: string | null = null,
) {
  if (!validCommitment(credentialKeysetCommitment)) return Promise.resolve([]);
  return listDirtyInstances(
    db,
    now,
    Math.max(1, Math.min(100, Math.trunc(limit))),
    afterInstanceId,
    credentialKeysetCommitment,
  );
}
export function deferDirtyWalletInstance(
  db: D1Database,
  p: WalletScope &
    WalletCredentialKeysetProof & {
      instanceId: string;
      generation: number;
      now: number;
      delayMs: number;
    },
): Promise<boolean> {
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !nonnegative(p.now) ||
    !nonnegative(p.delayMs)
  )
    return Promise.resolve(false);
  return deferDirtyInstance(db, {
    ...p,
    nextAttemptAt: p.now + Math.max(1_000, Math.min(300_000, p.delayMs)),
  });
}
export function listWalletRetirementsReady(
  db: D1Database,
  now: number,
  limit: number,
  credentialKeysetCommitment: string,
  afterId: string | null = null,
) {
  if (!validCommitment(credentialKeysetCommitment)) return Promise.resolve([]);
  return listRetirementsReady(
    db,
    now,
    Math.max(1, Math.min(100, Math.trunc(limit))),
    afterId,
    credentialKeysetCommitment,
  );
}
export function deferWalletRetirement(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { now: number; delayMs: number },
): Promise<boolean> {
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !nonnegative(p.now) ||
    !nonnegative(p.delayMs)
  )
    return Promise.resolve(false);
  return deferRetirement(db, {
    ...p,
    nextAttemptAt: p.now + Math.max(1_000, Math.min(300_000, p.delayMs)),
  });
}
export const ackDirtyWalletInstance = ackDirtyInstance;
export const requestWalletRetirement = requestRetirement;
export const retireWalletInstance = retireInstance;
export const retireUnissuedWalletPlaceholder = retireUnissuedPlaceholder;
