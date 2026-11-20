import type { ServiceContext } from '../../platform/service-context.ts';
import { nonnegative, requestHash, sameProof, validProof, validRequest } from './instance-input.ts';
import type {
  WalletInstance,
  WalletInstanceProof,
  WalletOperation,
  WalletOperationKind,
  WalletOperationRef,
  WalletQueueProof,
  WalletScope,
} from './instance-types.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import {
  ackDirtyInstance,
  deferDirtyInstance,
  getInstanceById,
  getInstanceByPass,
  getOperation,
  getOperationByRequest,
  insertInstance,
  listDirtyInstances,
  listDueOperations,
  readPassSnapshot,
} from './repo-instance.ts';
import { grantDesiredOperation } from './repo-instance-desired.ts';
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
    !walletProviderEnabled(p.provider, p.mode) ||
    !validProof(p, 'upsert') ||
    !validRequest(p.requestKey, p.now) ||
    !p.instanceId
  )
    return null;
  const hash = await requestHash(p.requestKey);
  const existing = await getInstanceByPass(db, p);
  if (existing && existing.lifecycle !== 'ready' && existing.lifecycle !== 'active') return null;
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

/**
 * Queues the next desired operation under the reconcile grant (retire grant for a revoke). The proof carries what the
 * caller read; a pass or account that moved since refuses `stale` and returns null with nothing written.
 */
export async function queueWalletOperation(
  ctx: ServiceContext,
  p: WalletQueueProof & {
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
  const db = ctx.env.DB;
  const hash = await requestHash(p.requestKey);
  const queued = await grantDesiredOperation(ctx, {
    ...p,
    operationId: p.newId(),
    requestHash: hash,
  });
  if (queued === 'stale') return null;
  const op = await getOperationByRequest(db, { ...p, requestHash: hash });
  return op && sameProof(op, p, p.kind) ? op : null;
}

export function listDueWalletOperations(
  db: D1Database,
  now: number,
  limit: number,
  afterId: string | null = null,
): Promise<WalletOperation[]> {
  return listDueOperations(db, now, Math.max(1, Math.min(100, Math.trunc(limit))), afterId);
}
export function listDirtyWalletInstances(
  db: D1Database,
  now: number,
  limit: number,
  afterInstanceId: string | null = null,
) {
  return listDirtyInstances(
    db,
    now,
    Math.max(1, Math.min(100, Math.trunc(limit))),
    afterInstanceId,
  );
}
export function deferDirtyWalletInstance(
  db: D1Database,
  p: WalletScope & {
    instanceId: string;
    generation: number;
    now: number;
    delayMs: number;
  },
): Promise<boolean> {
  if (!nonnegative(p.now) || !nonnegative(p.delayMs)) return Promise.resolve(false);
  return deferDirtyInstance(db, {
    ...p,
    nextAttemptAt: p.now + Math.max(1_000, Math.min(300_000, p.delayMs)),
  });
}
export function listWalletRetirementsReady(
  db: D1Database,
  now: number,
  limit: number,
  afterId: string | null = null,
) {
  return listRetirementsReady(db, now, Math.max(1, Math.min(100, Math.trunc(limit))), afterId);
}
export function deferWalletRetirement(
  db: D1Database,
  p: WalletOperationRef & { now: number; delayMs: number },
): Promise<boolean> {
  if (!nonnegative(p.now) || !nonnegative(p.delayMs)) return Promise.resolve(false);
  return deferRetirement(db, {
    ...p,
    nextAttemptAt: p.now + Math.max(1_000, Math.min(300_000, p.delayMs)),
  });
}
export const ackDirtyWalletInstance = ackDirtyInstance;
export const requestWalletRetirement = requestRetirement;
export const retireWalletInstance = retireInstance;
export const retireUnissuedWalletPlaceholder = retireUnissuedPlaceholder;
